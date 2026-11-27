// bake-zones.mts — baka optimalzoner till R2-klara filer:
//   data/r2/zones/<art>-<date>-<static>.json   (Workern servar dessa, se worker/src/index.ts)
//
// Kör på Macen (har rasters):  npx tsx scripts/bake-zones.mts --species kantarell,... [--days 1] [--both]
// Synka:  rclone sync data/r2/zones r2://svampradar-tiles/domains/fungi/<rev>/zones
// Cron-förslag på Macen: kl 06:00 dagligen (säsong/regn ändras).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LayerStore } from "../src/layers.js";
import { SPECIES } from "../src/habitat.js";
import { computeOptimalZone } from "../src/optimal-zone.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const speciesArg = arg("species", "").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = path.resolve(arg("out", path.join(here, "..", "data", "r2", "zones")));
const days = Math.max(1, Number(arg("days", "1")) || 1);
const both = args.includes("--both");
if (speciesArg.length === 0) { console.error("Ange --species a,b,c (eller --all)"); process.exit(1); }
const ids = speciesArg[0] === "all" ? Object.keys(SPECIES) : speciesArg;

const store = await LayerStore.load(path.join(here, "..", "data", "layers"));
if (store.empty) { console.error("Inga lager — kör på Macen."); process.exit(1); }
await fsp.mkdir(outDir, { recursive: true });

const dayMs = 86400000;
let n = 0;
for (let di = 0; di < days; di++) {
  const asOf = new Date(Date.now() - di * dayMs);
  const date = asOf.toISOString().slice(0, 10);
  for (const st of both ? [false, true] : [false]) {
    for (const id of ids) {
      if (!SPECIES[id]) continue;
      try {
        const t = Date.now();
        const result = await computeOptimalZone(store, [id], asOf, { static: st });
        const file = `${id}-${date}-${st ? "1" : "0"}.json`;
        await fsp.writeFile(path.join(outDir, file), JSON.stringify({ ...result, asOf: date }));
        n++;
        if (di === 0) console.log(`${file}: ${(Date.now() - t)} ms peak=${(result.meta as Record<string, unknown>).peakScore} zone=${result.optimalZone ? "JA" : "null"}`);
      } catch (e) {
        console.error(`${id} ${date} static=${st}:`, (e as Error).message);
      }
    }
  }
}
console.log(`KLART: ${n} zon-filer -> ${outDir}`);
console.log(`Synka: rclone sync ${outDir} r2://svampradar-tiles/domains/fungi/${arg("rev", "r16")}/zones`);
