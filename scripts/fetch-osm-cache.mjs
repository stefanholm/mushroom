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
for (let lon = Math.floor(minLon / g) * g; lon < maxLon + 1e-9; lon += g) {
  for (let lat = Math.floor(minLat / g) * g; lat < maxLat + 1e-9; lat += g) {
    tiles.push({ lon, lat });
  }
}
if (tiles.length > 25) {
  console.error(`Too many 0.4° tiles (${tiles.length}); narrow the bbox.`);
  process.exit(1);
}
console.log(`Baking ${tiles.length} tile(s)...`);
let totalForest = 0;
let totalExcl = 0;
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
const EXCL_LE = new Set(["pitch", "golf_course", "recreation_ground", "park", "garden", "playground", "dog_park"]);
const PAVED = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|bus_guideway|raceway|road)$/;
const EXCL_MM = new Set(["wastewater_plant", "storage_tank"]);
const isExclArea = (t) =>
  t.natural === "water" || t.waterway !== undefined || t.building !== undefined ||
  (t.landuse !== undefined && EXCL_LU.test(t.landuse)) ||
  (t.leisure !== undefined && EXCL_LE.has(t.leisure)) || t.amenity === "parking" ||
  t.natural === "grass" || t.shop !== undefined || (t.man_made !== undefined && EXCL_MM.has(t.man_made));
const isLine = (t) => (t.highway !== undefined && PAVED.test(t.highway)) || t.railway !== undefined || t.aeroway !== undefined;

function assembleRings(geoms) {
  const EPS = 1e-7;
  const rings = [];
  const open = [];
  for (const g of geoms) {
    if (g.length < 2) continue;
    const [fx, fy] = g[0];
    const [lx, ly] = g[g.length - 1];
    if (Math.abs(fx - lx) < EPS && Math.abs(fy - ly) < EPS) {
      if (g.length >= 3) rings.push(g);
    } else open.push(g);
  }
  let progress = true;
  while (open.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < open.length; i++) {
      const seg = open[i];
      const [sx, sy] = seg[0];
      const [ex, ey] = seg[seg.length - 1];
      for (let j = 0; j < open.length; j++) {
        if (i === j) continue;
        const other = open[j];
        const [ox, oy] = other[0];
        const [px, py] = other[other.length - 1];
        if (Math.abs(ex - ox) < EPS && Math.abs(ey - oy) < EPS) open[i] = [...seg, ...other.slice(1)];
        else if (Math.abs(ex - px) < EPS && Math.abs(ey - py) < EPS) open[i] = [...seg, ...[...other].reverse().slice(1)];
        else if (Math.abs(sx - px) < EPS && Math.abs(sy - py) < EPS) open[i] = [...other.slice(0, -1), ...seg];
        else if (Math.abs(sx - ox) < EPS && Math.abs(sy - oy) < EPS) open[i] = [...[...other].reverse().slice(0, -1), ...seg];
        else continue;
        open.splice(j, 1);
        if (j < i) i--;
        progress = true;
        break;
      }
    }
  }
  for (const seg of open) {
    const [fx, fy] = seg[0];
    const [lx, ly] = seg[seg.length - 1];
    if (seg.length >= 3 && Math.abs(fx - lx) < EPS && Math.abs(fy - ly) < EPS) rings.push(seg);
  }
  return rings;
}

function pointInRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polysOf(body) {
  const polys = [];
  for (const e of body.elements ?? []) {
    const outers = [];
    const inners = [];
    if (e.geometry) outers.push(e.geometry.map((p) => [p.lon, p.lat]));
    for (const m of e.members ?? []) {
      if (!m.geometry) continue;
      const ring = m.geometry.map((p) => [p.lon, p.lat]);
      if (m.role === "inner") inners.push(ring);
      else outers.push(ring);
    }
    for (const o of assembleRings(outers).filter((r) => r.length >= 3)) {
      polys.push({ outer: o, inner: assembleRings(inners).filter((r) => r.length >= 3 && pointInRing(o, r[0][0], r[0][1])) });
    }
  }
  return polys;
}

function ringsOf(body) {
  return polysOf(body);
}

const forestQ = (b) => `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
const areaQ = (b) => `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground|park|garden|playground|dog_park)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
const linesQ = (b) => `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|bus_guideway|raceway|road)$"](${b});way["railway"](${b});way["aeroway"](${b});`;
const exclQ = (b) => `[out:json][timeout:60];(${areaQ(b)}${linesQ(b)});out geom;`;

await fs.mkdir(root, { recursive: true });

for (const t of tiles) {
  const kMinLon = t.lon;
  const kMinLat = t.lat;
  const key = `${kMinLon.toFixed(6)},${kMinLat.toFixed(6)},${(kMinLon + g).toFixed(6)},${(kMinLat + g).toFixed(6)}`;
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  let forest, ex;
  try {
    forest = ringsOf(await overpass(forestQ(b)));
    const exclBody = await overpass(exclQ(b));
    ex = { polys: [], lines: [] };
    for (const e of exclBody.elements ?? []) {
      const tg = e.tags ?? {};
      const line = Boolean(tg.highway || tg.railway || tg.aeroway);
      if (line) {
        for (const gg of [e.geometry, ...(e.members ?? []).map((m) => m.geometry)]) {
          if (!Array.isArray(gg)) continue;
          const ring = gg.map((p) => [p.lon, p.lat]);
          if (ring.length >= 2) ex.lines.push(ring);
        }
      } else {
        ex.polys.push(...polysOf({ elements: [e] }));
      }
    }
    console.log(`[${key}] fetched via Overpass`);
  } catch {
    const features = await osmApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
    forest = features
      .filter((f) => isForestTag(f.tags))
      .flatMap((f) => f.rings)
      .filter((r) => r.length >= 3)
      .map((r) => ({ outer: r, inner: [] }));
    ex = { polys: [], lines: [] };
    for (const f of features) {
      if (isLine(f.tags)) ex.lines.push(...f.rings);
      else if (isExclArea(f.tags)) {
        for (const r of f.rings) if (r.length >= 3) ex.polys.push({ outer: r, inner: [] });
      }
    }
    console.log(`[${key}] fetched via OSM main API`);
  }
  await fs.writeFile(path.join(root, `forest_${key}.json`), JSON.stringify(forest));
  await fs.writeFile(path.join(root, `exclusion_${key}.json`), JSON.stringify(ex));
  console.log(`  forest_${key}.json: ${forest.length} polys, exclusion: ${ex.polys.length} polys / ${ex.lines.length} lines`);
  totalForest += forest.length;
  totalExcl += ex.polys.length + ex.lines.length;
}
console.log(`Totalt: ${totalForest} skog-polygoner, ${totalExcl} exkl-polygoner/linjer i ${tiles.length} tiles.`);
if (totalForest === 0 || totalExcl === 0) {
  console.error("FEL: Overpass/OSM returnerade tomma resultat — kontrollera nätverk/rate-limit. Radera data/osm och försök igen.");
  process.exit(1);
}
console.log("Server reads these from data/osm/ before calling live APIs.");
