#!/usr/bin/env node
// Offline tile pre-bake: starts the server on a temp port, then requests every
// habitat tile in a bbox/zoom range so the server's disk cache (data/tiles/<v>/)
// is filled. Bake with static=1 (default) for the static habitat pyramid that
// scales to all of Sweden; the dynamic weather multiplier stays live.
//
// Usage:
//   npm run bake-tiles -- --species kantarell,karljohan --bbox 17.6,59.0,18.6,59.8 --zmin 9 --zmax 14
//   npm run bake-tiles -- --all-species --bbox 10,55,24,69 --zmin 5 --zmax 11   (static only)
//
// Env: BAKE_PORT (default 3999), BAKE_STATIC=0 to include live weather instead.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const speciesArg = opt("species", "kantarell");
const allSpecies = args.includes("--all-species");
const bbox = opt("bbox", "17.6,59.0,18.6,59.8").split(",").map(Number);
const zmin = Number(opt("zmin", 9));
const zmax = Number(opt("zmax", 14));
const port = Number(process.env.BAKE_PORT ?? 3999);
const staticOnly = process.env.BAKE_STATIC !== "0";

if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
  console.error("FEL: --bbox minLon,minLat,maxLon,maxLat");
  process.exit(1);
}
const [minLon, minLat, maxLon, maxLat] = bbox;

const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "server.ts")],
  { env: { ...process.env, PORT: String(port), MISTRAL_API_KEY: process.env.MISTRAL_API_KEY ?? "bake" }, stdio: ["ignore", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => process.stderr.write(d));

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await fetch(base + "/api/meta?species=kantarell");
    if (r.ok) {
      up = true;
      const m = await r.json();
      console.log(`server up; maskUsed=${m.maskUsed} layers=${(m.layersLoaded ?? []).length} tileVersion=${m.tileVersion}`);
    }
  } catch {}
}
if (!up) {
  console.error("FEL: servern startade inte i tid");
  child.kill();
  process.exit(1);
}

let speciesList = [speciesArg];
if (allSpecies) {
  const m = await (await fetch(base + "/api/meta?species=kantarell")).json();
  speciesList = (m.speciesList ?? []).map((s) => s.id);
}

const tileXY = (z, lon, lat) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [x, y];
};

let done = 0;
let failed = 0;
const t0 = Date.now();
for (const sp of speciesList) {
  for (let z = zmin; z <= zmax; z++) {
    const [x0] = tileXY(z, minLon, maxLat);
    const [x1] = tileXY(z, maxLon, maxLat);
    const [, y0] = tileXY(z, minLon, minLat);
    const [, y1] = tileXY(z, minLon, maxLat);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        const url = `${base}/api/tiles/habitat/${sp}/${z}/${x}/${y}.png?${staticOnly ? "static=1&" : ""}v=r14`;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error("HTTP " + r.status);
          await r.arrayBuffer();
          done++;
        } catch (e) {
          failed++;
          console.error(`misslyckades ${sp} ${z}/${x}/${y}: ${e.message}`);
        }
        if (done % 200 === 0) {
          const dt = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`${done} tiles bakade (${failed} fel) på ${dt}s — ${sp} z${z}`);
        }
      }
    }
  }
}
console.log(`KLART: ${done} tiles bakade, ${failed} fel, ${((Date.now() - t0) / 1000).toFixed(0)}s. Cache: data/tiles/r14/`);
child.kill();
process.exit(failed > 0 ? 1 : 0);
