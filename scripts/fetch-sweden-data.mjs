#!/usr/bin/env node
// fetch-sweden-data.mjs — laddar ner rå hel-Sverige-geodata UTAN registrering:
//
//   DEM:  Copernicus DEM GLO-30 (30 m) från AWS Open Data (S3, publika COG-tiles, ingen auth)
//         https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<Nxx_00_Eyyy_00>_DEM/
//              Copernicus_DSM_COG_10_<tile>_DEM.tif
//   OSM:  Geofabrik sweden-latest.osm.pbf (~1 GB) — basemap-vektor + forest/exclusion-masker
//
// Usage:
//   node scripts/fetch-sweden-data.mjs                          # hela Sverige DEM + OSM PBF
//   node scripts/fetch-sweden-data.mjs --bbox 17.4,58.8,18.8,59.9   # bara ett område (snabbtest)
//   node scripts/fetch-sweden-data.mjs --out /Volumes/SvampradarSSD/00-sources
//   node scripts/fetch-sweden-data.mjs --dem-only | --osm-only
//
// Efter nedladdning (på Mac, med `brew install gdal osmium-tool`):
//   gdalwarp -t_srs EPSG:3006 -tr 50 50 -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256 \
//     -co COMPRESS=DEFLATE -multi <out>/dem-glo30/*.tif <out>/10-derived/rasters-3006/50m/hojdmodell_50m.tif
//   osmium extract -b <bbox> <out>/osm/sweden-latest.osm.pbf -o <out>/osm/area.osm.pbf --overwrite
//   (se README för osmium tags-filter / osm-bake)
//
// Sandbox-test: --bbox 17.4,58.8,18.8,59.9 hämtar bara ~6 tiles och verifierar att de är giltiga COG.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const bboxArg = opt("bbox", "10.5,55.0,24.5,69.5").split(",").map(Number);
const OUT = path.resolve(opt("out", path.join(here, "..", "data", "downloads")));
const DEM_ONLY = args.includes("--dem-only");
const OSM_ONLY = args.includes("--osm-only");
const CONCURRENCY = 12;

const S3 = "https://copernicus-dem-30m.s3.amazonaws.com";
const GEOFABRIK = "https://download.geofabrik.de/europe/sweden-latest.osm.pbf";

// 1°×1° GLO-30 tiles som skär bboxen (tile Nyy_00_Exx_00 täcker lat yy..yy+1, lon xx..xx+1)
function tilesForBBox([minLon, minLat, maxLon, maxLat]) {
  const tiles = [];
  for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat - 1e-9); lat++) {
    for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon - 1e-9); lon++) {
      tiles.push(`N${String(lat).padStart(2, "0")}_00_E${String(lon).padStart(3, "0")}_00`);
    }
  }
  return tiles;
}

async function download(url, dest, minBytes = 1000) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
    return { skipped: true, size: fs.statSync(dest).size };
  }
  const tmp = dest + ".part";
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`för liten fil (${buf.length} B) ${url}`);
  await fsp.writeFile(tmp, buf);
  fs.renameSync(tmp, dest);
  return { skipped: false, size: buf.length };
}

async function pool(items, worker, conc) {
  let i = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx]);
        done++;
        if (done % 20 === 0) console.log(`  ${done}/${items.length}`);
      }
    }),
  );
}

async function fetchDEM() {
  const demDir = path.join(OUT, "dem-glo30");
  await fsp.mkdir(demDir, { recursive: true });
  const tiles = tilesForBBox(bboxArg);
  console.log(`GLO-30: ${tiles.length} tiles för bbox ${bboxArg.join(",")} -> ${demDir}`);
  let total = 0;
  await pool(
    tiles,
    async (t) => {
      const key = `Copernicus_DSM_COG_10_${t}_DEM/Copernicus_DSM_COG_10_${t}_DEM.tif`;
      const dest = path.join(demDir, `${t}_DEM.tif`);
      try {
        const r = await download(`${S3}/${key}`, dest, 100000);
        total += r.size;
        if (!r.skipped) process.stdout.write(`  ${t}: ${(r.size / 1e6).toFixed(1)} MB\n`);
      } catch (e) {
        console.error(`  FEL ${t}: ${e.message}`);
      }
    },
    CONCURRENCY,
  );
  console.log(`GLO-30 klart: ${tiles.length} tiles, ${(total / 1e9).toFixed(2)} GB totalt`);
  return demDir;
}

async function fetchOSM() {
  const osmDir = path.join(OUT, "osm");
  await fsp.mkdir(osmDir, { recursive: true });
  const dest = path.join(osmDir, "sweden-latest.osm.pbf");
  console.log(`OSM: ${GEOFABRIK} -> ${dest} (~1 GB)`);
  // strömma till fil (stor fil — arrayBuffer skulle spränga minnet)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 900e6) {
    console.log("  finns redan, hoppar över");
    return dest;
  }
  const tmp = dest + ".part";
  const r = await fetch(GEOFABRIK, { signal: AbortSignal.timeout(600000) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const ws = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!ws.write(chunk)) await new Promise((res) => ws.once("drain", res));
  }
  await new Promise((res) => ws.end(res));
  fs.renameSync(tmp, dest);
  console.log(`OSM klart: ${(got / 1e9).toFixed(2)} GB`);
  return dest;
}

async function main() {
  console.log(`Ut-katalog: ${OUT}, bbox: ${bboxArg.join(",")}`);
  if (!OSM_ONLY) await fetchDEM();
  if (!DEM_ONLY) await fetchOSM();
  console.log(`
Klart. Nästa steg (Mac, brew install gdal osmium-tool):
  gdalwarp -t_srs EPSG:3006 -tr 50 50 -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256 -co COMPRESS=DEFLATE -multi ${OUT}/dem-glo30/*.tif ${OUT}/../10-derived/rasters-3006/50m/hojdmodell_50m.tif
  osmium tags-filter ${OUT}/osm/sweden-latest.osm.pbf w/landuse=forest w/natural=wood w/natural=scrub -o ${OUT}/osm/forest.osm.pbf --overwrite
  npm run osm-bake   # eller be servern använda Overpass-fallback tills vidare
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
