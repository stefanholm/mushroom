// bake-hotspot-blocks.mts — baka statiska hotspot-pins till 10x10 km-block (EPSG:3006)
// redo för R2:  data/r2/hotspots/<art>/<bx>_<by>.json
//
// Blocken är bara STAISKA habitat-pins (score = habitat*100, 10 m-raster via sampling);
// live-faktorn (säsong/regn/frost) appliceras i Workern vid anrop från weather/live.json.
// Förfiltrering: om data/overview/<art>.json finns används dess 2 km-celler >= minScore
// som skogsmask (annars körs alla block i --bbox — tungt, kör bara över natten då).
//
// Kör:  npx tsx scripts/bake-hotspot-blocks.mts --species kantarell,trattkantarell \
//         --out data/r2/hotspots [--minScore 55] [--cellM 50] [--bbox 10.9,55.3,24.2,69.1]
// Synka: rclone sync data/r2/hotspots r2://svampradar-tiles/domains/fungi/r16/hotspots

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { LayerStore, toSWEREF } from "../src/layers.js";
import { SPECIES, staticHabitatScore } from "../src/habitat.js";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);
const to4326 = (e: number, n: number): [number, number] =>
  proj4("EPSG:3006", "EPSG:4326", [e, n]) as [number, number];

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const speciesArg = arg("species", "").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = path.resolve(arg("out", path.join(here, "..", "data", "r2", "hotspots")));
const minScore = Math.max(0, Math.min(100, Number(arg("minScore", "55")) || 55));
const cellM = Math.max(10, Number(arg("cellM", "50")) || 50);
const maxPins = Math.min(500, Number(arg("maxPins", "150")) || 150);
const bboxArg = arg("bbox", "");
const BLOCK_M = 10000; // 10x10 km
const OVERVIEW_DIR = path.join(here, "..", "data", "overview");
const SWEDEN = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };

if (speciesArg.length === 0) {
  console.error("Ange --species a,b,c");
  process.exit(1);
}
for (const s of speciesArg) if (!SPECIES[s]) { console.error(`Okänd art: ${s}`); process.exit(1); }

const bbox = bboxArg
  ? bboxArg.split(",").map(Number)
  : [SWEDEN.minLon, SWEDEN.minLat, SWEDEN.maxLon, SWEDEN.maxLat];
if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) { console.error("--bbox minLon,minLat,maxLon,maxLat"); process.exit(1); }

const store = await LayerStore.load(path.join(here, "..", "data", "layers"));
if (store.empty) { console.error("Inga lager laddade — kör på Macen med riktiga rasters."); process.exit(1); }
console.log(`Lager: ${[...store.rasters.keys()].length} rasters, mask=${!!store.mask}`);

const [minE, maxN] = toSWEREF(bbox[0], bbox[3]);
const [maxE, minN] = toSWEREF(bbox[2], bbox[1]);
const bx0 = Math.floor(minE / BLOCK_M) * BLOCK_M;
const bx1 = Math.ceil(maxE / BLOCK_M) * BLOCK_M;
const by0 = Math.floor(minN / BLOCK_M) * BLOCK_M;
const by1 = Math.ceil(maxN / BLOCK_M) * BLOCK_M;

async function overviewMask(sp: string): Promise<Set<string> | null> {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(OVERVIEW_DIR, `${sp}.json`), "utf8")) as {
      cells: { e: number; n: number; max: number }[];
    };
    const blocks = new Set<string>();
    for (const c of j.cells) {
      if (c.max >= minScore) {
        blocks.add(`${Math.floor(c.e / BLOCK_M) * BLOCK_M}_${Math.floor(c.n / BLOCK_M) * BLOCK_M}`);
      }
    }
    console.log(`${sp}: overview-mask ${blocks.size} block (minScore=${minScore})`);
    return blocks;
  } catch {
    return null; // ingen overview -> alla block i bbox
  }
}

let totalBlocks = 0, totalPins = 0;
for (const sp of speciesArg) {
  const mask = await overviewMask(sp);
  const spDir = path.join(outDir, sp);
  await fsp.mkdir(spDir, { recursive: true });
  let spBlocks = 0, spPins = 0;
  for (let by = by0; by < by1; by += BLOCK_M) {
    for (let bx = bx0; bx < bx1; bx += BLOCK_M) {
      const key = `${bx}_${by}`;
      if (mask && !mask.has(key)) continue;
      // sampla blocket i SWEREF-rutnät
      const scores: { e: number; n: number; s: number }[] = [];
      const maskL = store.mask;
      const clearcuts = store.vectors.get("avverkningar");
      for (let n = by; n < by + BLOCK_M; n += cellM) {
        for (let e = bx; e < bx + BLOCK_M; e += cellM) {
          if (maskL && !(maskL.has(e, n) && maskL.allows(e, n))) continue; // hårt veto
          if (clearcuts && clearcuts.contains(e, n)) continue; // hårt veto
          const [lon, lat] = to4326(e, n);
          const h = staticHabitatScore(store, sp, lon, lat, {
            forestOk: true, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false,
          });
          const s = Math.min(100, Math.round(h * 100)); // samma clamp som servern
          if (s >= minScore) scores.push({ e, n, s });
        }
      }
      if (scores.length === 0) continue;
      // local maxima (8-grannar på samplingsrutnätet)
      const step = cellM;
      const grid = new Map<string, number>();
      for (const p of scores) grid.set(`${p.e},${p.n}`, p.s);
      const peaks = scores.filter((p) => {
        for (let dn = -step; dn <= step; dn += step) {
          for (let de = -step; de <= step; de += step) {
            if (!de && !dn) continue;
            const nb = grid.get(`${p.e + de},${p.n + dn}`);
            if (nb !== undefined && nb > p.s) return false;
          }
        }
        return true;
      });
      peaks.sort((a, b) => b.s - a.s);
      const pins = peaks.slice(0, maxPins).map((p) => {
        const [lon, lat] = to4326(p.e, p.n);
        return { lon: Number(lon.toFixed(6)), lat: Number(lat.toFixed(6)), s: p.s };
      });
      const file = { art: sp, bx, by, blockM: BLOCK_M, minScore, generatedAt: new Date().toISOString(), pins };
      await fsp.writeFile(path.join(spDir, `${key}.json`), JSON.stringify(file));
      spBlocks++; spPins += pins.length;
    }
  }
  console.log(`${sp}: ${spBlocks} block, ${spPins} pins -> ${path.relative(process.cwd(), spDir)}`);
  totalBlocks += spBlocks; totalPins += spPins;
}
console.log(`KLART: ${totalBlocks} block, ${totalPins} pins totalt. Synka med:`);
console.log(`  rclone sync ${outDir} r2://svampradar-tiles/domains/fungi/${arg("rev", "r16")}/hotspots`);
