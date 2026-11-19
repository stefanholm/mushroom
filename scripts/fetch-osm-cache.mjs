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
const tiles = [];
for (let lon = Math.floor(minLon / g) * g; lon < maxLon; lon += g) {
  for (let lat = Math.floor(minLat / g) * g; lat < maxLat; lat += g) {
    tiles.push({ lon, lat });
  }
}
if (tiles.length > 25) {
  console.error(`Too many 0.4° tiles (${tiles.length}); narrow the bbox.`);
  process.exit(1);
}
console.log(`Baking ${tiles.length} tile(s)...`);
let key = "";
let b = "";

const HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

async function overpass(q) {
  let lastErr = new Error("no host");
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}?data=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (body.remark) console.log(`  overpass remark: ${body.remark}`);
      if ((body.elements ?? []).length === 0) throw new Error("empty result");
      return body;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function osmApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon) {
  const r = await fetch(
    `https://api.openstreetmap.org/api/0.6/map?bbox=${kMinLon},${kMinLat},${kMaxLon},${kMaxLat}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!r.ok) throw new Error(`OSM API HTTP ${r.status}`);
  const xml = await r.text();
  const nodes = new Map();
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const id = /id="(\d+)"/.exec(m[0])?.[1];
    const lat = /lat="(-?[\d.]+)"/.exec(m[0])?.[1];
    const lon = /lon="(-?[\d.]+)"/.exec(m[0])?.[1];
    if (id && lat && lon) nodes.set(id, [Number(lon), Number(lat)]);
  }
  const ways = new Map();
  for (const m of xml.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
    const id = /id="(\d+)"/.exec(m[0].slice(0, m[0].indexOf(">") + 1))?.[1] ?? "";
    const tags = {};
    for (const t of m[1].matchAll(/<tag\b[^>]*k="([^"]+)"[^>]*v="([^"]*)"/g)) tags[t[1]] = t[2];
    const ring = [];
    for (const nd of m[1].matchAll(/<nd\b[^>]*ref="(\d+)"/g)) {
      const c = nodes.get(nd[1]);
      if (c) ring.push(c);
    }
    ways.set(id, { tags, ring });
  }
  const features = [];
  for (const w of ways.values()) if (w.ring.length >= 2) features.push({ tags: w.tags, rings: [w.ring] });
  for (const m of xml.matchAll(/<relation\b[^>]*>([\s\S]*?)<\/relation>/g)) {
    const tags = {};
    for (const t of m[1].matchAll(/<tag\b[^>]*k="([^"]+)"[^>]*v="([^"]*)"/g)) tags[t[1]] = t[2];
    const rings = [];
    for (const mem of m[1].matchAll(/<member\b[^>]*type="way"[^>]*ref="(\d+)"/g)) {
      const w = ways.get(mem[1]);
      if (w && w.ring.length >= 2) rings.push(w.ring);
    }
    if (rings.length) features.push({ tags, rings });
  }
  return features;
}

const isForestTag = (t) => t.landuse === "forest" || t.natural === "wood" || t.natural === "scrub";
const EXCL_LU = /^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$/;
const EXCL_LE = new Set(["pitch", "golf_course", "recreation_ground"]);
const EXCL_MM = new Set(["wastewater_plant", "storage_tank"]);
const isExclArea = (t) =>
  t.natural === "water" || t.waterway !== undefined || t.building !== undefined ||
  (t.landuse !== undefined && EXCL_LU.test(t.landuse)) ||
  (t.leisure !== undefined && EXCL_LE.has(t.leisure)) || t.amenity === "parking" ||
  t.natural === "grass" || t.shop !== undefined || (t.man_made !== undefined && EXCL_MM.has(t.man_made));
const isLine = (t) => t.highway !== undefined || t.railway !== undefined || t.aeroway !== undefined;

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

const forestQ = (b) => `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
const areaQ = (b) => `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
const linesQ = (b) => `way["highway"](${b});way["railway"](${b});way["aeroway"](${b});`;
const exclQ = (b) => `[out:json][timeout:60];(${areaQ(b)}${linesQ(b)});out geom;`;

await fs.mkdir(root, { recursive: true });

for (const t of tiles) {
  const kMinLon = t.lon;
  const kMinLat = t.lat;
  const kMaxLon = t.lon + g;
  const kMaxLat = t.lat + g;
  const key = `${kMinLon},${kMinLat},${kMaxLon},${kMaxLat}`;
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  let forest, ex;
  try {
    forest = ringsOf(await overpass(forestQ(b)));
    const exclBody = await overpass(exclQ(b));
    ex = { polys: [], lines: [] };
    for (const e of exclBody.elements ?? []) {
      const tg = e.tags ?? {};
      const line = Boolean(tg.highway || tg.railway || tg.aeroway);
      const geoms = [e.geometry, ...(e.members ?? []).map((m) => m.geometry)].filter(Array.isArray);
      for (const gg of geoms) {
        const ring = gg.map((p) => [p.lon, p.lat]);
        if (ring.length < 2) continue;
        if (line) ex.lines.push(ring);
        else ex.polys.push(ring);
      }
    }
    console.log(`[${key}] fetched via Overpass`);
  } catch {
    const features = await osmApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
    forest = features.filter((f) => isForestTag(f.tags)).flatMap((f) => f.rings).filter((r) => r.length >= 3);
    ex = { polys: [], lines: [] };
    for (const f of features) {
      if (isLine(f.tags)) ex.lines.push(...f.rings);
      else if (isExclArea(f.tags)) ex.polys.push(...f.rings);
    }
    console.log(`[${key}] fetched via OSM main API`);
  }
  await fs.writeFile(path.join(root, `forest_${key}.json`), JSON.stringify(forest));
  await fs.writeFile(path.join(root, `exclusion_${key}.json`), JSON.stringify(ex));
  console.log(`  forest_${key}.json: ${forest.length} rings, exclusion: ${ex.polys.length} polys / ${ex.lines.length} lines`);
}
console.log("Server reads these from data/osm/ before calling live APIs.");
