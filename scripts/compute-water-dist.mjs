#!/usr/bin/env node
// Beräknar avstånd till närmaste vatten (meter) som water_dist_10m.tif.
// Vattenmask från NMD (klass 61/62) om nmd_10m.tif finns, annars från
// höjdmodellens nodata (sjögolv). Chamfer-avståndstransform, poolas till 10 m.
// Skriver aldrig över utan --force.
//
//   npm run water-dist
//   npm run water-dist -- --force

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromFile, writeArrayBuffer } from "geotiff";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const LAYERS = path.join(root, "data", "layers");
const FORCE = process.argv.includes("--force");
const pool = 5;

async function readBand(file) {
  const image = await (await fromFile(file)).getImage();
  const w = image.getWidth();
  const h = image.getHeight();
  const res = Math.abs(image.getResolution()[0]);
  const [ox, oy] = image.getOrigin();
  const nod = image.getGDALNoData() ?? -9999;
  const bands = image.getSamplesPerPixel();
  const arr = await image.readRasters({ interleave: true });
  return { w, h, res, ox, oy, nod, arr, bands };
}

async function main() {
  const nmdPath = path.join(LAYERS, "nmd_10m.tif");
  const demPath = path.join(LAYERS, "hojdmodell_2m.tif");
  let src = null;
  let isWater = null;
  if (fs.existsSync(nmdPath)) {
    src = await readBand(nmdPath);
    isWater = (k) => {
      const v = src.arr[k * src.bands];
      return v === 61 || v === 62;
    };
    console.log("vattenmask från NMD (klass 61/62)");
  } else if (fs.existsSync(demPath)) {
    src = await readBand(demPath);
    isWater = (k) => src.arr[k * src.bands] === src.nod;
    console.log("ingen NMD — vattenmask från höjdmodellens nodata");
  } else {
    console.error("FEL: varken nmd_10m.tif eller hojdmodell_2m.tif hittades");
    process.exit(1);
  }
  const { w, h, res, ox, oy } = src;
  const n = w * h;
  // Chamfer 2-pass distance transform (3-4 vikter), i meter
  const INF = 1e12;
  const dist = new Float64Array(n).fill(INF);
  for (let k = 0; k < n; k++) if (isWater(k)) dist[k] = 0;
  const d1 = res * 1.0;
  const d2 = res * 1.41421356;
  const nbrs = [
    [-1, 0, d1], [1, 0, d1], [0, -1, d1], [0, 1, d1],
    [-1, -1, d2], [1, -1, d2], [-1, 1, d2], [1, 1, d2],
  ];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let m = dist[k];
      for (const [di, dj, d] of nbrs) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const v = dist[jj * w + ii] + d;
        if (v < m) m = v;
      }
      dist[k] = m;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let m = dist[k];
      for (const [di, dj, d] of nbrs) {
        const ii = i - di, jj = j - dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const v = dist[jj * w + ii] + d;
        if (v < m) m = v;
      }
      dist[k] = m;
    }
  }
  // poola till 10 m (max = närmaste vatten inom poolen räcker)
  const outRes = res * pool;
  const oW = Math.ceil(w / pool);
  const oH = Math.ceil(h / pool);
  const out = new Float32Array(oW * oH).fill(src.nod);
  for (let oj = 0; oj < oH; oj++) {
    for (let oi = 0; oi < oW; oi++) {
      let best = INF;
      const j0 = oj * pool;
      const i0 = oi * pool;
      for (let j = j0; j < Math.min(h, j0 + pool); j++) {
        for (let i = i0; i < Math.min(w, i0 + pool); i++) {
          const v = dist[j * w + i];
          if (v < best) best = v;
        }
      }
      if (best < INF) out[oj * oW + oi] = best;
    }
  }
  const p = path.join(LAYERS, "water_dist_10m.tif");
  if (fs.existsSync(p) && !FORCE) {
    console.log("hoppar över water_dist_10m.tif (finns redan; --force skriver över)");
    return;
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
    ModelTiepoint: [0, 0, 0, ox, oy, 0],
    ProjectedCSTypeGeoKey: 3006,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
  };
  await fsp.writeFile(p, Buffer.from(writeArrayBuffer(out, metadata)));
  console.log(`wrote water_dist_10m.tif ${oW}x${oH} @ ${outRes} m`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
