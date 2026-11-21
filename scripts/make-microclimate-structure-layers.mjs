#!/usr/bin/env node
// Genererar två valfria mikroklimat-/struktur-lager från befintliga raster:
//   water_rel_10m.tif    (0..1) mikroklimatisk vatten-/svacknärhet: TWI + lutning
//   stand_struct_10m.tif (0..1) skogsstruktur/kantzon: trädhöjd + lutning + TWI-variation
// Skriver bara saknade filer (eller alla vid --force). Samma grid som referenslagret
// (twi/slope); källor med annan grid samplas närmaste granne.
//
//   npm run microclimate
//   npm run microclimate -- --force

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromFile, writeArrayBuffer } from "geotiff";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const LAYERS = path.join(root, "data", "layers");
const FORCE = process.argv.includes("--force");

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

async function readBand(file) {
  if (!fs.existsSync(file)) return null;
  const image = await (await fromFile(file)).getImage();
  const w = image.getWidth();
  const h = image.getHeight();
  const res = Math.abs(image.getResolution()[0]);
  const [ox, oy] = image.getOrigin();
  const nod = image.getGDALNoData() ?? -9999;
  const bands = image.getSamplesPerPixel();
  const arr = await image.readRasters({ interleave: true });
  const data = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const v = arr[k * bands];
    data[k] = typeof v === "number" && v !== nod ? v : NaN;
  }
  return { w, h, res, ox, oy, data };
}

// sample src (eget geotransform) på ref-grid (i,j) -> src-koordinat
const makeSampler = (src) => (i, j, ref) => {
  const e = ref.ox + (i + 0.5) * ref.res;
  const n = ref.oy - (j + 0.5) * ref.res;
  const si = Math.floor((e - src.ox) / src.res);
  const sj = Math.floor((src.oy - n) / src.res);
  if (si < 0 || sj < 0 || si >= src.w || sj >= src.h) return NaN;
  return src.data[sj * src.w + si];
};

async function main() {
  const twi = await readBand(path.join(LAYERS, "twi_10m.tif"));
  const slope = await readBand(path.join(LAYERS, "slope_10m.tif"));
  const heightFile = ["skog_tradhojd_10m.tif", "hojdmodell_2m.tif"].map((f) => path.join(LAYERS, f)).find((p) => fs.existsSync(p));
  const height = heightFile ? await readBand(heightFile) : null;

  const ref = twi ?? slope;
  if (!ref) {
    console.error("FEL: hittade varken twi_10m.tif eller slope_10m.tif i data/layers/ (kör npm run twi eller npm run demo-data först)");
    process.exit(1);
  }
  const n = ref.w * ref.h;
  console.log(`referensgrid: ${ref.w}x${ref.h} @ ${ref.res} m; height=${height ? heightFile : "saknas"}`);

  const sample = (src, i, j) => (src ? (src.w === ref.w && src.h === ref.h ? src.data[j * ref.w + i] : makeSampler(src)(i, j, ref)) : NaN);

  // #1 vatten-/svacknärhet 0..1
  const water = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = k % ref.w;
    const j = (k - i) / ref.w;
    const t = sample(twi, i, j);
    const s = sample(slope, i, j);
    if (!Number.isFinite(t)) {
      water[k] = 0.5;
      continue;
    }
    const wet = smoothstep(5.5, 13.5, clamp(t, 0, 18));
    const flat = Number.isFinite(s) ? 1 - smoothstep(2, 18, clamp(s, 0, 45)) : 0.5;
    water[k] = clamp(0.75 * wet + 0.25 * wet * flat, 0, 1);
  }

  // #3 skogsstruktur/kantzon 0..1
  const struct = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = k % ref.w;
    const j = (k - i) / ref.w;
    const h = sample(height, i, j);
    const s = sample(slope, i, j);
    const t = sample(twi, i, j);
    let hScore = 0.65;
    if (Number.isFinite(h) && h > 0) {
      const lowOk = smoothstep(2, 9, h);
      const highOk = 1 - 0.35 * smoothstep(24, 38, h);
      hScore = clamp(lowOk * highOk, 0, 1);
    }
    const slopeOk = Number.isFinite(s) ? 1 - 0.5 * smoothstep(14, 32, clamp(s, 0, 50)) : 0.75;
    const twiEdge = Number.isFinite(t) ? 1 - 0.35 * Math.abs(clamp(t, 0, 18) - 8.5) / 8.5 : 0.75;
    struct[k] = clamp(0.55 * hScore + 0.25 * slopeOk + 0.2 * twiEdge, 0, 1);
  }

  async function write(file, values) {
    const p = path.join(LAYERS, file);
    if (fs.existsSync(p) && !FORCE) {
      console.log(`hoppar över ${file} (finns redan; --force skriver över)`);
      return;
    }
    const metadata = {
      width: ref.w,
      height: ref.h,
      BitsPerSample: [32],
      SampleFormat: [3],
      PhotometricInterpretation: 1,
      PlanarConfiguration: 1,
      SamplesPerPixel: 1,
      RowsPerStrip: ref.h,
      ModelPixelScale: [ref.res, ref.res, 0],
      ModelTiepoint: [0, 0, 0, ref.ox, ref.oy, 0],
      ProjectedCSTypeGeoKey: 3006,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
    };
    await fsp.writeFile(p, Buffer.from(writeArrayBuffer(values, metadata)));
    console.log(`wrote ${file} ${ref.w}x${ref.h} @ ${ref.res} m`);
  }
  await write("water_rel_10m.tif", water);
  await write("stand_struct_10m.tif", struct);
  console.log("KLART");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
