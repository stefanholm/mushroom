#!/usr/bin/env node
// AUC validation: scores Artportalen observations (data/validation/observations.geojson)
// against random background cells inside the forest mask (available habitat) via
// /api/debug/cell (static=1), per species and per GDD band. Writes
// data/validation/auc-report.json. Skyddsklassade arter (brusade koordinater) flaggas.
//
// Usage:
//   npm run validate
//   npm run validate -- --species kantarell,karljohan --limit 1500 --bg 2000
// Scoring sker i batch via POST /api/debug/cells (400 punkter/anrop) — mycket snabbare
// än ett /api/debug/cell-anrop per punkt.
//
// Env: VALIDATE_PORT (default 3998).

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const speciesFilter = opt("species", "").split(",").filter(Boolean);
const limit = Number(opt("limit", 1500));
const bgCount = Number(opt("bg", 2000));
const port = Number(process.env.VALIDATE_PORT ?? 3998);

const obsFile = path.join(root, "data", "validation", "observations.geojson");
if (!fs.existsSync(obsFile)) {
  console.error("FEL: " + obsFile + " saknas — kör först: npm run artfakta -- --bbox minLon,minLat,maxLon,maxLat --limit 2000");
  process.exit(1);
}
const obs = JSON.parse(await fsp.readFile(obsFile, "utf8"));
const features = (obs.features ?? []).filter(
  (f) => f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates) && f.properties?.species,
);
if (features.length === 0) {
  console.error("FEL: inga observationer med koordinater i " + obsFile);
  process.exit(1);
}

let [minLon, minLat, maxLon, maxLat] = obs.bbox ?? [];
if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
  minLon = Infinity; minLat = Infinity; maxLon = -Infinity; maxLat = -Infinity;
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
}

const bySpecies = new Map();
for (const f of features) {
  const id = f.properties.species;
  if (speciesFilter.length > 0 && !speciesFilter.includes(id)) continue;
  if (!bySpecies.has(id)) bySpecies.set(id, []);
  bySpecies.get(id).push(f);
}

// Deterministic PRNG so reruns are comparable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "server.ts")],
  { env: { ...process.env, PORT: String(port), MISTRAL_API_KEY: process.env.MISTRAL_API_KEY ?? "validate" }, stdio: ["ignore", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => process.stderr.write(d));

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await fetch(base + "/api/meta?species=kantarell");
    if (r.ok) up = true;
  } catch {}
}
if (!up) {
  console.error("FEL: servern startade inte i tid");
  child.kill();
  process.exit(1);
}
console.log(`server up på port ${port}; ${features.length} observationer, bbox ${minLon.toFixed(2)},${minLat.toFixed(2)}–${maxLon.toFixed(2)},${maxLat.toFixed(2)}`);

const meta = await (await fetch(base + "/api/meta?species=kantarell")).json();
const protectedIds = new Set((meta.speciesList ?? []).filter((s) => s.protected).map((s) => s.id));

let done = 0;
// Batch-scoring: POST /api/debug/cells?ents=all med upp till 400 punkter per anrop.
// ents=all så även låsta arter valideras (validate ska mäta modellen, inte köpet).
async function scoreBatch(species, pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 400) {
    const chunk = pts.slice(i, i + 400);
    let res = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        const r = await fetch(`${base}/api/debug/cells?ents=all`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ species, static: 1, points: chunk }),
        });
        if (r.ok) res = (await r.json()).results;
      } catch {}
      if (!res) await new Promise((r2) => setTimeout(r2, 500));
    }
    if (!res) res = chunk.map(() => ({ score: 0, gddEff: NaN, inForest: false, excluded: false, error: "batch misslyckades" }));
    out.push(...res);
    done += chunk.length;
    if (done % 2000 < 400) console.log(`  ${done} punkter scorade…`);
  }
  return out;
}

// Background = random cells INSIDE the forest mask (available habitat), not the raw bbox —
// otherwise urban/water/road zeros depress AUC and the metric says nothing about habitat.
async function bgPoints(rnd, species, count) {
  const cand = Array.from({ length: count * 4 }, () => [
    minLon + rnd() * (maxLon - minLon),
    minLat + rnd() * (maxLat - minLat),
  ]);
  const res = await scoreBatch(species, cand);
  const inForest = res.filter((r) => r.inForest && !r.excluded);
  return inForest.length >= count ? inForest.slice(0, count) : res.slice(0, count);
}

async function mapPool(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

function auc(obsScores, bgScores) {
  if (obsScores.length === 0 || bgScores.length === 0) return NaN;
  const bg = [...bgScores].sort((a, b) => a - b);
  let sum = 0;
  for (const s of obsScores) {
    let lo = 0, hi = bg.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bg[mid] < s) lo = mid + 1; else hi = mid;
    }
    const less = lo;
    let lo2 = lo, hi2 = bg.length;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (bg[mid] <= s) lo2 = mid + 1; else hi2 = mid;
    }
    const leq = lo2;
    sum += less + 0.5 * (leq - less);
  }
  return sum / (obsScores.length * bgScores.length);
}

const gddBand = (g) => (!Number.isFinite(g) ? "okänd" : g < 1000 ? "norr <1000" : g <= 1400 ? "mitten 1000–1400" : "söder >1400");

const report = { generatedAt: new Date().toISOString(), bbox: [minLon, minLat, maxLon, maxLat], species: {} };
const t0 = Date.now();

for (const [species, feats] of [...bySpecies.entries()].sort()) {
  const sample = feats.slice(0, limit);
  const rnd = mulberry32(42);

  const obsRes = await scoreBatch(species, sample.map((f) => f.geometry.coordinates));
  const bgRes = await bgPoints(rnd, species, bgCount);

  const obsScores = obsRes.map((r) => r.score);
  const bgScores = bgRes.map((r) => r.score);
  const overall = auc(obsScores, bgScores);

  const bands = {};
  for (const r of obsRes) {
    const b = gddBand(r.gddEff);
    (bands[b] ??= []).push(r.score);
  }
  const byBand = {};
  for (const [b, arr] of Object.entries(bands)) {
    if (arr.length >= 30) byBand[b] = { n: arr.length, auc: Number(auc(arr, bgScores).toFixed(3)) };
  }

  const isProtected = protectedIds.has(species);
  const flag = isProtected
    ? "skyddad — koordinater brusade i öppna data, AUC ej meningsfull"
    : overall < 0.7
      ? "KALIBRERA"
      : overall < 0.8
        ? "se över"
        : "ok";
  report.species[species] = {
    observations: sample.length,
    background: bgScores.length,
    auc: Number(overall.toFixed(3)),
    meanObs: Number((obsScores.reduce((a, b) => a + b, 0) / Math.max(1, obsScores.length)).toFixed(1)),
    meanBg: Number((bgScores.reduce((a, b) => a + b, 0) / Math.max(1, bgScores.length)).toFixed(1)),
    byGddBand: byBand,
    protected: isProtected,
    flag,
  };
  console.log(
    `${species.padEnd(24)} n=${String(sample.length).padStart(5)} AUC=${overall.toFixed(3)} ` +
    `medel fynd=${report.species[species].meanObs} bg=${report.species[species].meanBg} ${flag}`,
  );
}

const aucs = Object.values(report.species).map((s) => s.auc).filter(Number.isFinite);
const meanAuc = aucs.reduce((a, b) => a + b, 0) / Math.max(1, aucs.length);
report.meanAuc = Number(meanAuc.toFixed(3));
report.background = "random celler innanför skogsmasken (inForest && !excluded)";
report.speciesFlagged = Object.entries(report.species).filter(([, s]) => s.flag === "KALIBRERA").map(([id]) => id);

await fsp.mkdir(path.dirname(obsFile), { recursive: true });
const outFile = path.join(root, "data", "validation", "auc-report.json");
await fsp.writeFile(outFile, JSON.stringify(report, null, 2));
console.log(`\nMedel-AUC: ${meanAuc.toFixed(3)} över ${aucs.length} arter`);
if (report.speciesFlagged.length > 0) console.log("KALIBRERA: " + report.speciesFlagged.join(", "));
console.log(`KLART på ${((Date.now() - t0) / 1000).toFixed(0)}s — rapport: ${path.relative(root, outFile)}`);

child.kill();
process.exit(0);
