#!/usr/bin/env node
// bake-overview.mjs — Tier 1 (Overview): grovt rutnät (default 2 km, z4–z9-nivå) över
// HELA täckta ytan (huvudraster + patches), per art. Varje grov cell samplas 3x3 och
// aggregeras med max OCH 95:e percentilen (så skog inte missas av pixel-hopp).
// Skriver data/overview/<art>.json (Top-Spots JSON) — Tier 2 (detalj z10–z15+) är de
// vanliga habitat-tiles via `npm run bake-tiles -- --zmin 10 --zmax 15`.
//
// Scoring görs på samma sätt som servern (staticHabitatScore, static=1) så overview
// och detalj är konsistenta.
//
// Usage:
//   npm run bake-overview -- --species kantarell,karljohan --cell 2000 --min 55
//   npm run bake-overview -- --all-species
//
// Skriver även data/overview/species-pyramid-profile.json (per art: nationalCells per
// SWEREF-ruta 140/55/18/6/2 km, topScore, p95Score, rarityWeight 1.00–1.45, updatedAt).
// --species gör inkrementell merge; --all-species skriver om hela profilen.
//
// Kräver tsx (importerar src/*.ts): körs via npm run bake-overview.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromFile } from "geotiff";
import proj4 from "proj4";
import { LayerStore } from "../src/layers.js";
import { SPECIES, staticHabitatScore } from "../src/habitat.js";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);
const to4326 = ([e, n]) => proj4("EPSG:3006", "EPSG:4326", [e, n]);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const layersDir = path.join(root, "data", "layers");
const outDir = path.join(root, "data", "overview");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const speciesArg = opt("species", "kantarell");
const allSpecies = args.includes("--all-species");
const cellM = Number(opt("cell", 2000));
const minScore = Number(opt("min", 55));
const maxCells = Number(opt("max", 2000));

// SWEREF 99 TM pyramid-rutor (m) för artprofilen
const PYRAMID_SIZES = [
  ["140km", 140000],
  ["55km", 55000],
  ["18km", 18000],
  ["6km", 6000],
  ["2km", 2000],
];

function profileFor(species, qualCells, updatedAt) {
  const nationalCells = {};
  for (const [label, size] of PYRAMID_SIZES) {
    const keys = new Set(qualCells.map((c) => `${Math.floor(c.e / size)},${Math.floor(c.n / size)}`));
    nationalCells[label] = keys.size;
  }
  const maxes = qualCells.map((c) => c.max);
  const topScore = maxes.length ? Math.max(...maxes) : 0;
  const p95Score = quantile(maxes, 0.95);
  return {
    nationalCells,
    topScore: Number(topScore.toFixed(1)),
    p95Score: Number(p95Score.toFixed(1)),
    rarityWeight: 1, // sätts när hela profilen är klar (behöver max över alla arter)
    updatedAt,
  };
}

// Deterministisk mjuk log-vikt 1.00–1.45: färre 6 km-rutor => högre vikt (rariteter lyfts).
function rarityWeightFor(c6km, refC6km) {
  const ref = Math.max(2, refC6km);
  const t = Math.min(1, Math.max(0, Math.log(Math.max(1, c6km)) / Math.log(ref)));
  return Number((1 + 0.45 * (1 - t)).toFixed(2));
}

async function unionBBox() {
  const manifest = JSON.parse(await fs.readFile(path.join(layersDir, "manifest.json"), "utf8"));
  const files = [
    ...(manifest.rasters ?? []).flatMap((r) => [r.file, ...(r.patches ?? [])]),
    ...(manifest.mask ? [manifest.mask.file, ...(manifest.mask.patches ?? [])] : []),
  ];
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const f of files) {
    try {
      const img = await (await fromFile(path.join(layersDir, f))).getImage();
      const bb = img.getBoundingBox();
      minE = Math.min(minE, bb[0]); minN = Math.min(minN, bb[1]);
      maxE = Math.max(maxE, bb[2]); maxN = Math.max(maxN, bb[3]);
    } catch {}
  }
  return [minE, minN, maxE, maxN];
}

const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const store = await LayerStore.load(layersDir);
  console.log(`lager: ${store.rasters.size} rasters, mask=${store.mask ? "ja" : "nej"}, saknade=${store.missing.length}`);
  const [minE, minN, maxE, maxN] = await unionBBox();
  console.log(`täckning (EPSG:3006): E ${Math.round(minE)}–${Math.round(maxE)}, N ${Math.round(minN)}–${Math.round(maxN)}`);

  const speciesList = allSpecies ? Object.keys(SPECIES).sort() : speciesArg.split(",").map((s) => s.trim()).filter(Boolean);
  const profileUpdates = {};

  for (const sp of speciesList) {
    if (!SPECIES[sp]) {
      console.log(`okänd art: ${sp}`);
      continue;
    }
    const cells = [];
    const off = cellM / 3;
    for (let n = minN + cellM / 2; n < maxN; n += cellM) {
      for (let e = minE + cellM / 2; e < maxE; e += cellM) {
        const maskOk = store.mask ? store.mask.has(e, n) && store.mask.allows(e, n) : true;
        if (store.mask && !maskOk) continue; // overview visar bara riktig skog
        const subs = [];
        for (const de of [-off, 0, off]) {
          for (const dn of [-off, 0, off]) {
            const [lon, lat] = to4326([e + de, n + dn]);
            const s = staticHabitatScore(store, sp, lon, lat, {
              forestOk: true, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false,
            }) * 100; // staticHabitatScore returnerar 0..1; servern skalar till 0..100
            subs.push(Math.min(100, s)); // samma tak som servern (score=min(100,...))
          }
        }
        const mx = Math.max(...subs);
        if (mx < minScore) continue;
        const [lon, lat] = to4326([e, n]);
        cells.push({
          e: Math.round(e), n: Math.round(n),
          lon: Number(lon.toFixed(5)), lat: Number(lat.toFixed(5)),
          max: Number(mx.toFixed(1)), p95: Number(quantile(subs, 0.95).toFixed(1)),
        });
      }
    }
    cells.sort((a, b) => b.max - a.max);
    const kept = cells.slice(0, maxCells);
    const out = {
      species: sp,
      tier: 1,
      cellM,
      minScore,
      generatedAt: new Date().toISOString(),
      count: kept.length,
      truncated: cells.length > kept.length,
      cells: kept,
    };
    await fs.writeFile(path.join(outDir, `${sp}.json`), JSON.stringify(out));
    profileUpdates[sp] = profileFor(sp, cells, out.generatedAt); // alla kvalificerade celler, ej trunkerade
    const top = kept.slice(0, 3).map((c) => `${c.lat},${c.lon} max=${c.max}`).join(" | ");
    console.log(`${sp}: ${kept.length} celler (min ${minScore}) ${cells.length > kept.length ? "(trunkerad)" : ""} — topp: ${top}`);
  }

  // species-pyramid-profile.json: inkrementell merge vid --species, komplett vid --all-species
  const profilePath = path.join(outDir, "species-pyramid-profile.json");
  let profiles = {};
  try {
    profiles = JSON.parse(await fs.readFile(profilePath, "utf8")).profiles ?? {};
  } catch {}
  if (allSpecies) profiles = {};
  Object.assign(profiles, profileUpdates);
  const refC6 = Math.max(0, ...Object.values(profiles).map((p) => p.nationalCells["6km"] ?? 0));
  for (const p of Object.values(profiles)) {
    p.rarityWeight = rarityWeightFor(p.nationalCells["6km"] ?? 0, refC6);
  }
  await fs.writeFile(
    profilePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), profiles }, null, 2) + "\n",
  );
  console.log(`species-pyramid-profile.json: ${Object.keys(profiles).length} arter (refC6km=${refC6})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
