#!/usr/bin/env node
// make-test-patches.mjs — genererar två små GIS-testpatchar (2-tier-arkitekturen):
//
//   Patch A "sodertalje": täcker Södertälje/Ronna/Nykvarn (~59.207, 17.584) och går
//                          VÄSTER om nuvarande cutoff 17.61°E (Mälardalen-rastrens kant).
//   Patch B "skane":       en avlägsen 20x20 km-ruta (Malmö/Lund-området) för att testa
//                          landstäckande översiktspins + zoom-in.
//
// Regler (enligt spec):
//   * Alla rasters i EPSG:3006 (SWEREF99 TM), 256x256-tiled GeoTIFF, samma rutnät som
//     huvudfilen (origin snäpps mot huvudfilens grid).
//   * RÅA lager — inga svamp-vetoer (kalhyggen/vatten/stad) är inbakade; NMD-patchen
//     innehåller råa klasser (skog 111-117/121-127, vatten 61, kalhygge 51, tätort 81)
//     och masken applicerar vattenbuffert/kanthygge vid runtime som vanligt.
//   * Upplösning: kläms till 10–25 m (huvudfilens upplösning om den ligger i spannet).
//
//   Patcharna skrivs till data/layers/patches/ och registreras i manifest.json under
//   "patches": [...] per lager (mosaic i src/layers.ts). Befintliga filer skrivs INTE
//   över utan --force.
//
//   På Mac: byt ut de syntetiska värdena mot riktiga urklipp:
//     gdalwarp -cutline patchA.geojson -crop_to_cutline -tr 10 10 -t_srs EPSG:3006 \
//       -of GTiff -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256 \
//       <källa.tif> data/layers/patches/<fil>__patchA.tif
//   kör sedan bara: npm run test-patches -- --register-only
//
// Usage: npm run test-patches [-- --force] [-- --register-only]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromFile } from "geotiff";
import proj4 from "proj4";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const layersDir = path.join(here, "..", "data", "layers");
const patchesDir = path.join(layersDir, "patches");
const FORCE = process.argv.includes("--force");
const REGISTER_ONLY = process.argv.includes("--register-only");

const PATCHES = [
  { key: "patchA", name: "sodertalje", minLon: 17.42, minLat: 59.08, maxLon: 17.72, maxLat: 59.32 },
  { key: "patchB", name: "skane", minLon: 12.98, minLat: 55.38, maxLon: 13.32, maxLat: 55.58 },
];

const to3006 = ([lon, lat]) => proj4("EPSG:4326", "EPSG:3006", [lon, lat]);

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- minimal tiled GeoTIFF-writer (geotiff.js writer är strip-only) ----------
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_DOUBLE = 12;
const TYPE_SIZE = { [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_DOUBLE]: 8 };

async function writeTiledGeoTIFF(file, width, height, bits, sampleFormat, values, originX, originY, step) {
  const TILE = 256;
  const ta = Math.ceil(width / TILE);
  const td = Math.ceil(height / TILE);
  const nTiles = ta * td;
  const bps = bits / 8;
  const tileBytes = TILE * TILE * bps;

  const tiles = [];
  for (let ty = 0; ty < td; ty++) {
    for (let tx = 0; tx < ta; tx++) {
      const buf = Buffer.alloc(tileBytes);
      for (let y = 0; y < TILE; y++) {
        const gy = ty * TILE + y;
        if (gy >= height) break;
        for (let x = 0; x < TILE; x++) {
          const gx = tx * TILE + x;
          const v = gx < width ? Number(values[gy * width + gx]) : 0;
          const off = (y * TILE + x) * bps;
          if (bits === 8) buf.writeUInt8(v & 0xff, off);
          else if (bits === 16) buf.writeUInt16LE(v & 0xffff, off);
          else if (bits === 32 && sampleFormat === 3) buf.writeFloatLE(v, off);
          else if (bits === 32) buf.writeUInt32LE(v >>> 0, off);
          else if (bits === 64) buf.writeDoubleLE(v, off);
          else throw new Error("bits " + bits + " stöds ej");
        }
      }
      tiles.push(buf);
    }
  }

  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3026, 0, 1, 3006]; // projected, pixel-is-area, EPSG:3006
  const pixelScale = Buffer.alloc(24);
  pixelScale.writeDoubleLE(step, 0);
  pixelScale.writeDoubleLE(step, 8);
  pixelScale.writeDoubleLE(0, 16);
  const tiepoint = Buffer.alloc(48);
  tiepoint.writeDoubleLE(0, 0);
  tiepoint.writeDoubleLE(0, 8);
  tiepoint.writeDoubleLE(0, 16);
  tiepoint.writeDoubleLE(originX, 24);
  tiepoint.writeDoubleLE(originY, 32);
  tiepoint.writeDoubleLE(0, 40);
  const geoKeyBuf = Buffer.alloc(geoKeys.length * 2);
  geoKeys.forEach((v, i) => geoKeyBuf.writeUInt16LE(v, i * 2));

  const entries = [];
  const push = (tag, type, count, inlineBuf /* Buffer|null */, extraBuf /* Buffer|null */) =>
    entries.push({ tag, type, count, inlineBuf, extraBuf });
  const tileOffsetsExtra = Buffer.alloc(nTiles * 4);
  const tileByteCountsExtra = Buffer.alloc(nTiles * 4);
  for (let i = 0; i < nTiles; i++) tileByteCountsExtra.writeUInt32LE(tileBytes, i * 4);

  push(256, TYPE_LONG, 1, u32(width), null); // ImageWidth
  push(257, TYPE_LONG, 1, u32(height), null); // ImageLength
  push(258, TYPE_SHORT, 1, u16(bits), null); // BitsPerSample
  push(259, TYPE_SHORT, 1, u16(1), null); // Compression = none
  push(262, TYPE_SHORT, 1, u16(1), null); // PhotometricInterpretation = BlackIsZero
  push(277, TYPE_SHORT, 1, u16(1), null); // SamplesPerPixel
  push(322, TYPE_LONG, 1, u32(TILE), null); // TileWidth
  push(323, TYPE_LONG, 1, u32(TILE), null); // TileLength
  push(324, TYPE_LONG, nTiles, null, tileOffsetsExtra); // TileOffsets
  push(325, TYPE_LONG, nTiles, null, tileByteCountsExtra); // TileByteCounts
  push(339, TYPE_SHORT, 1, u16(sampleFormat), null); // SampleFormat: 1=uint 3=float
  push(33550, TYPE_DOUBLE, 3, null, pixelScale);
  push(33922, TYPE_DOUBLE, 6, null, tiepoint);
  push(34735, TYPE_SHORT, geoKeys.length, null, geoKeyBuf);
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraOffset = ifdOffset + ifdSize;
  const extra = [];
  for (const e of entries) {
    if (e.extraBuf) {
      e.offset = extraOffset;
      extra.push(e.extraBuf);
      extraOffset += e.extraBuf.length;
    }
  }
  let dataOffset = extraOffset;
  for (let i = 0; i < nTiles; i++) {
    tileOffsetsExtra.writeUInt32LE(dataOffset, i * 4);
    dataOffset += tiles[i].length;
  }

  const out = Buffer.alloc(dataOffset);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  out.writeUInt16LE(entries.length, ifdOffset);
  let p = ifdOffset + 2;
  for (const e of entries) {
    out.writeUInt16LE(e.tag, p);
    out.writeUInt16LE(e.type, p + 2);
    out.writeUInt32LE(e.count, p + 4);
    const size = TYPE_SIZE[e.type] * e.count;
    if (e.inlineBuf) e.inlineBuf.copy(out, p + 8);
    else out.writeUInt32LE(e.offset, p + 8);
    p += 12;
  }
  out.writeUInt32LE(0, p); // next IFD
  let eo = ifdOffset + ifdSize;
  for (const e of entries) {
    if (e.extraBuf) {
      e.extraBuf.copy(out, eo);
      eo += e.extraBuf.length;
    }
  }
  let to = extraOffset;
  for (const t of tiles) {
    t.copy(out, to);
    to += t.length;
  }
  await fs.writeFile(file, out);
}
function u16(v) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(v, 0);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

// ---------- värdegenerator (råa, neutrala lager; syntetiska men realistiska) ----------
function makeValues(id, w, h, step, maxN, bits, sampleFormat, seed) {
  const rng = mulberry32(seed);
  const Arr =
    bits === 8 ? Uint8Array : bits === 16 ? Uint16Array : bits === 32 && sampleFormat === 3 ? Float32Array : Uint32Array;
  const a = new Arr(w * h);
  const blobs = [
    { cx: 0.32, cy: 0.38, r: 0.16 },
    { cx: 0.7, cy: 0.66, r: 0.2 },
  ];
  const forestCodes = [111, 112, 113, 114, 115, 116, 117, 121, 122, 123, 124, 125, 126, 127];
  for (let j = 0; j < h; j++) {
    const N = maxN - (j + 0.5) * step;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const fx = i / w;
      const fy = j / h;
      let b = 0;
      for (const bl of blobs) {
        const d = Math.hypot((fx - bl.cx) / 1, (fy - bl.cy) / 1);
        b = Math.max(b, Math.max(0, 1 - d / bl.r));
      }
      if (id === "nmd") {
        const lake = Math.hypot((fx - 0.78) * 1.4, fy - 0.24) < 0.1;
        const town = fx > 0.08 && fx < 0.24 && fy > 0.6 && fy < 0.78;
        const clearcut = Math.hypot(fx - 0.52, fy - 0.5) < 0.06;
        a[k] = lake ? 61 : town ? 81 : clearcut ? 51 : forestCodes[Math.floor(rng() * forestCodes.length)];
        continue;
      }
      const r = rng();
      switch (id) {
        case "volym": a[k] = Math.min(520, (40 + 260 * r) * (1 + 1.6 * b)); break;
        case "tradhojd": a[k] = (6 + 20 * r) * (1 + 0.5 * b); break;
        case "grundyta": a[k] = (8 + 42 * r) * (1 + 0.8 * b); break;
        case "alder": a[k] = 20 + 120 * r + 40 * b; break;
        case "sis": a[k] = 10 + 18 * r; break;
        case "gdd5": a[k] = 1560 + ((6570000 - N) / 1000) * 1.1 + 15 * r; break;
        case "soildepth": a[k] = 0.4 + 4 * r; break;
        case "markfuktighet": a[k] = r < 0.1 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : r < 0.95 ? 4 : 5; break;
        case "jordart": a[k] = r < 0.75 ? 1 : 2; break;
        case "hojd": a[k] = 20 + 60 * (0.5 + 0.5 * Math.sin(i * 0.02) * Math.cos(j * 0.017)) + 4 * r; break;
        case "slope": a[k] = 15 * r; break;
        case "twi": a[k] = 4 + 8 * r; break;
        case "water_rel": a[k] = r; break;
        case "water_dist": a[k] = 20 + 780 * r; break;
        case "stand_struct": a[k] = r; break;
        case "dodved": a[k] = 30 * r; break;
        default: a[k] = 100 * r; // trädslagsfraktioner m.m. — fylls nedan
      }
    }
  }
  // trädslagslager: fraktion av volym beroende på mix + hotspot-blob (gran)
  if (["gran", "tall", "bjork", "ek", "bok", "hassel", "asp"].includes(id)) {
    const rng2 = mulberry32(seed + 7);
    const volymRef = null; // procentuell fördelning räcker för habitatfaktorn
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const fx = i / w;
        const fy = j / h;
        let b = 0;
        for (const bl of blobs) b = Math.max(b, Math.max(0, 1 - Math.hypot(fx - bl.cx, fy - bl.cy) / bl.r));
        const mix = rng2();
        if (id === "gran") a[k] = mix < 0.45 || b > 0.3 ? 55 + 35 * rng2() : 5 + 10 * rng2();
        else if (id === "tall") a[k] = mix < 0.45 ? 5 + 10 * rng2() : mix < 0.75 ? 10 + 20 * rng2() : 40 + 30 * rng2();
        else if (id === "bjork") a[k] = mix < 0.75 ? 20 + 30 * rng2() : 5 + 10 * rng2();
        else if (id === "ek") a[k] = mix >= 0.75 ? 30 + 30 * rng2() : 3 + 8 * rng2();
        else if (id === "bok") a[k] = mix >= 0.75 ? 15 + 20 * rng2() : 2 + 5 * rng2();
        else if (id === "hassel") a[k] = 5 + 15 * rng2();
        else a[k] = 3 + 12 * rng2(); // asp
      }
    }
    void volymRef;
  }
  return a;
}

// ---------- huvud ----------
async function main() {
  await fs.mkdir(patchesDir, { recursive: true });
  const manifestPath = path.join(layersDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  const entries = [...(manifest.rasters ?? [])];
  if (manifest.mask) entries.push({ ...manifest.mask, __isMask: true });

  for (const p of PATCHES) {
    const [c0e, c0n] = to3006([p.minLon, p.minLat]);
    const [c1e, c1n] = to3006([p.maxLon, p.maxLat]);
    p.minE = Math.min(c0e, c1e);
    p.maxE = Math.max(c0e, c1e);
    p.minN = Math.min(c0n, c1n);
    p.maxN = Math.max(c0n, c1n);
  }

  for (const entry of entries) {
    const mainFile = path.join(layersDir, entry.file);
    let origin, res, bits, sampleFormat;
    try {
      const img = await (await fromFile(mainFile)).getImage();
      origin = img.getOrigin();
      res = img.getResolution();
      bits = img.getBitsPerSample(0);
      sampleFormat = img.getSampleFormat(0);
    } catch {
      console.log(`hoppar över ${entry.file} (huvudfil saknas/oläsbar)`);
      continue;
    }
    const [ox, oy] = origin; // oy = nordligaste kant (top)
    const resX = Math.abs(res[0]);
    const base = path.basename(entry.file);
    const patchFiles = [];
    for (const p of PATCHES) {
      // patch-upplösning: kläm till 10–25 m (per patch)
      let step = Math.min(Math.max(resX, 10), 25);
      // snäpp mot huvudfilens rutnät
      let minE = ox + Math.floor((p.minE - ox) / step) * step;
      let maxE = ox + Math.ceil((p.maxE - ox) / step) * step;
      let maxN = oy - Math.floor((oy - p.maxN) / step) * step;
      let minN = oy - Math.ceil((oy - p.minN) / step) * step;
      let w = Math.ceil((maxE - minE) / step);
      let h = Math.ceil((maxN - minN) / step);
      while ((w > 4096 || h > 4096) && step < 100) {
        step *= 2;
        minE = ox + Math.floor((p.minE - ox) / step) * step;
        maxE = ox + Math.ceil((p.maxE - ox) / step) * step;
        maxN = oy - Math.floor((oy - p.maxN) / step) * step;
        minN = oy - Math.ceil((oy - p.minN) / step) * step;
        w = Math.ceil((maxE - minE) / step);
        h = Math.ceil((maxN - minN) / step);
      }
      const rel = `patches/${base}__${p.key}.tif`;
      const abs = path.join(layersDir, rel);
      patchFiles.push(rel);
      const exists = await fs.access(abs).then(() => true).catch(() => false);
      if (exists && !FORCE) {
        console.log(`hoppar över ${rel} (finns; --force skriver över)`);
        continue;
      }
      if (REGISTER_ONLY) continue;
      const layerId = entry.__isMask ? "nmd" : entry.id;
      const seed = 1000 + p.key.length * 17 + base.length * 31 + layerId.length * 7;
      const values = makeValues(layerId, w, h, step, maxN, bits, sampleFormat, seed);
      await writeTiledGeoTIFF(abs, w, h, bits, sampleFormat, values, minE, maxN, step);
      console.log(`wrote ${rel}  ${w}x${h} @${step}m  ${bits}bit sf=${sampleFormat}  ${p.name}`);
    }
    // registrera i manifest
    if (entry.__isMask) {
      manifest.mask.patches = patchFiles;
    } else {
      entry.patches = patchFiles;
    }
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("manifest.json uppdaterad med patches[]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
