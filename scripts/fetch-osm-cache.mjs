import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "osm");

const [minLon, minLat, maxLon, maxLat] = process.argv.slice(2).map(Number);
if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
  console.error("Usage: node scripts/fetch-osm-cache.mjs <minLon> <minLat> <maxLon> <maxLat>");
  process.exit(1);
}
const g = 0.4;
const kMinLon = Math.floor(minLon / g) * g;
const kMinLat = Math.floor(minLat / g) * g;
const kMaxLon = Math.ceil(maxLon / g) * g;
const kMaxLat = Math.ceil(maxLat / g) * g;
const key = `${kMinLon},${kMinLat},${kMaxLon},${kMaxLat}`;
const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;

const HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

async function overpass(q) {
  for (const host of HOSTS) {
    try {
      const r = await fetch(host, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) return await r.json();
    } catch { /* next host */ }
  }
  throw new Error("all Overpass hosts failed");
}

function ringsOf(body) {
  const rings = [];
  for (const e of body.elements ?? []) {
    if (e.geometry) {
      const ring = e.geometry.map((p) => [p.lon, p.lat]);
      if (ring.length >= 2) rings.push(ring);
    }
    for (const m of e.members ?? []) {
      if (m.geometry) {
        const ring = m.geometry.map((p) => [p.lon, p.lat]);
        if (ring.length >= 2) rings.push(ring);
      }
    }
  }
  return rings;
}

const forestQ = `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
const area = `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
const lines = `way["highway"](${b});way["railway"](${b});way["aeroway"](${b});`;
const exclQ = `[out:json][timeout:60];(${area}${lines});out geom;`;

await fs.mkdir(root, { recursive: true });

const forest = ringsOf(await overpass(forestQ));
await fs.writeFile(path.join(root, `forest_${key}.json`), JSON.stringify(forest));
console.log(`forest_${key}.json: ${forest.length} rings`);

const exclBody = await overpass(exclQ);
const ex = { polys: [], lines: [] };
for (const e of exclBody.elements ?? []) {
  const t = e.tags ?? {};
  const isLine = Boolean(t.highway || t.railway || t.aeroway);
  const geoms = [e.geometry, ...(e.members ?? []).map((m) => m.geometry)].filter(Array.isArray);
  for (const g of geoms) {
    const ring = g.map((p) => [p.lon, p.lat]);
    if (ring.length < 2) continue;
    if (isLine) ex.lines.push(ring);
    else ex.polys.push(ring);
  }
}
await fs.writeFile(path.join(root, `exclusion_${key}.json`), JSON.stringify(ex));
console.log(`exclusion_${key}.json: ${ex.polys.length} polys, ${ex.lines.length} lines`);
console.log("Server reads these from data/osm/ before calling live APIs.");
