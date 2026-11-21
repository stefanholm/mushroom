#!/usr/bin/env node
// Beräknar TWI (topografiskt fuktindex, ln(a/tan β)) och lutning (Horn, grader) från
// hojdmodell_2m.tif vid native upplösning, poolas till 10 m och skrivs som
// data/layers/twi_10m.tif och slope_10m.tif (som manifest.json läser).
// Ingen extra mjukvara behövs (bara geotiff som redan är ett beroende).
// Skriver aldrig över befintliga filer utan --force.
//
//   npm run twi                 # skriv bara saknade filer
//   npm run twi -- --force      # skriv över
//   npm run twi -- --dem data/layers/hojdmodell_2m.tif --pool 5
//
// Alternativ: gdaldem slope + SAGA ta_hydrology / QGIS Processing (se README).

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeArrayBuffer, fromFile } from "geotiff";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const FORCE = args.includes("--force");
const demFile = opt("dem", path.join(root, "data", "layers", "hojdmodell_2m.tif"));
const pool = Number(opt("pool", 5)); // 2 m -> 10 m
const outDir = path.join(root, "data", "layers");

if (!existsSync(demFile)) {
  console.error("FEL: " + demFile + " saknas");
  process.exit(1);
}

const tiff = await fromFile(demFile);
const image = await tiff.getImage();
const W = image.getWidth();
const H = image.getHeight();
const fd = image.getFileDirectory();
const res = Math.abs(fd.ModelPixelScale?.[0] ?? 2);
const originX = fd.ModelTiepoint?.[3] ?? 0;
const originY = fd.ModelTiepoint?.[4] ?? 0;
const nod = fd.GDAL_NODATA ? Number.parseFloat(fd.GDAL_NODATA) : -9999;
const bands = image.getSamplesPerPixel();
console.log(`DEM: ${W}x${H} @ ${res} m (${(W * H / 1e6).toFixed(1)} M px), nodata=${nod}`);

const t0 = Date.now();
const arr = await image.readRasters({ interleave: true });
const z = new Float64Array(W * H);
for (let k = 0; k < W * H; k++) {
  const v = arr[k * bands];
  z[k] = typeof v === "number" && v !== nod ? v : NaN;
}
console.log(`läst ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? NaN : z[j * W + i]);

// Horn-lutning i grader
const slope = new Float64Array(W * H).fill(NaN);
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const c = z[j * W + i];
    if (!Number.isFinite(c)) continue;
    const dzdx = ((at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1))) / (8 * res);
    const dzdy = ((at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1))) / (8 * res);
    if (!Number.isFinite(dzdx) || !Number.isFinite(dzdy)) continue;
    slope[j * W + i] = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  }
}
console.log(`lutning klar ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// D8 flow accumulation: sortera högt->lågt, varje cell skickar sin area till lägsta grannen
const acc = new Float64Array(W * H);
for (let k = 0; k < W * H; k++) acc[k] = Number.isFinite(z[k]) ? res * res : 0;
const order = Array.from({ length: W * H }, (_, k) => k).sort(
  (a, b) => (Number.isFinite(z[b]) ? z[b] : -1e9) - (Number.isFinite(z[a]) ? z[a] : -1e9),
);
const nbrs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const twi = new Float64Array(W * H).fill(NaN);
for (const k of order) {
  const zi = z[k];
  if (!Number.isFinite(zi) || acc[k] === 0) continue;
  const i = k % W;
  const j = (k - i) / W;
  let best = -1;
  let bestZ = zi;
  for (const [di, dj] of nbrs) {
    const zn = at(i + di, j + dj);
    if (Number.isFinite(zn) && zn < bestZ) {
      bestZ = zn;
      best = (j + dj) * W + (i + di);
    }
  }
  if (best >= 0) acc[best] += acc[k];
  const s = Math.max(0.5, slope[k] || 0.5) * Math.PI / 180;
  twi[k] = Math.log(acc[k] / res / Math.tan(s));
}
console.log(`TWI klar ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Poola till pool*res (10 m): medel av giltiga celler
const outRes = res * pool;
const oW = Math.ceil(W / pool);
const oH = Math.ceil(H / pool);
async function pooled(src, file) {
  const out = new Float32Array(oW * oH).fill(nod);
  for (let oj = 0; oj < oH; oj++) {
    for (let oi = 0; oi < oW; oi++) {
      let sum = 0;
      let cnt = 0;
      const j0 = oj * pool;
      const i0 = oi * pool;
      for (let j = j0; j < Math.min(H, j0 + pool); j++) {
        for (let i = i0; i < Math.min(W, i0 + pool); i++) {
          const v = src[j * W + i];
          if (Number.isFinite(v)) {
            sum += v;
            cnt++;
          }
        }
      }
      if (cnt > 0) out[oj * oW + oi] = sum / cnt;
    }
  }
  const metadata = {
    width: oW,
    height: oH,
    BitsPerSample: [32],
    SampleFormat: [3],
    PhotometricInterpretation: 1,
    PlanarConfiguration: 1,
    SamplesPerPixel: 1,
    RowsPerStrip: oH,
    ModelPixelScale: [outRes, outRes, 0],
    ModelTiepoint: [0, 0, 0, originX, originY, 0],
    ProjectedCSTypeGeoKey: 3006,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
  };
  const p = path.join(outDir, file);
  try {
    await fs.access(p);
    if (!FORCE) {
      console.log(`hoppar över ${file} (finns redan; --force skriver över)`);
      return;
    }
  } catch {}
  await fs.writeFile(p, Buffer.from(writeArrayBuffer(out, metadata)));
  console.log(`wrote ${file} ${oW}x${oH} @ ${outRes} m`);
}
await pooled(twi, "twi_10m.tif");
await pooled(slope, "slope_10m.tif");
console.log(`KLART på ${((Date.now() - t0) / 1000).toFixed(0)}s`);
