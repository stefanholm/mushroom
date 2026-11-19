import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "osm");

const [forestFile, exclFile, minLon, minLat, maxLon, maxLat] = process.argv.slice(2).map((a, i) =>
  i < 2 ? a : Number(a),
);
if (!forestFile || !exclFile || ![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
  console.error(
    "Usage: node scripts/bake-osm-from-geojson.mjs <forest.geojson> <exclusion.geojson> <minLon> <minLat> <maxLon> <maxLat>",
  );
  console.error(
    "Typiskt: osmium export från en Geofabrik-PBF ger GeoJSON i EPSG:4326 med OSM-tags i properties.",
  );
  process.exit(1);
}

const g = 0.4;
const keyOf = (i, j) =>
  `${(i * g).toFixed(6)},${(j * g).toFixed(6)},${((i + 1) * g).toFixed(6)},${((j + 1) * g).toFixed(6)}`;

const isForest = (t) => t.landuse === "forest" || t.natural === "wood" || t.natural === "scrub";
const EXCL_LU = /^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$/;
const EXCL_LE = new Set(["pitch", "golf_course", "recreation_ground", "park", "garden", "playground", "dog_park"]);
const EXCL_MM = new Set(["wastewater_plant", "storage_tank"]);
const isExclArea = (t) =>
  t.natural === "water" || t.waterway !== undefined || t.building !== undefined ||
  (t.landuse !== undefined && EXCL_LU.test(t.landuse)) ||
  (t.leisure !== undefined && EXCL_LE.has(t.leisure)) ||
  t.amenity === "parking" || t.natural === "grass" || t.shop !== undefined ||
  (t.man_made !== undefined && EXCL_MM.has(t.man_made));
const PAVED = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|bus_guideway|raceway|road)$/;
const isLine = (t) =>
  (t.highway !== undefined && PAVED.test(t.highway)) || t.railway !== undefined || t.aeroway !== undefined;

function* polysOf(geom) {
  if (!geom) return;
  if (geom.type === "Polygon") {
    yield { outer: geom.coordinates[0], inner: geom.coordinates.slice(1) };
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) yield { outer: poly[0], inner: poly.slice(1) };
  }
}

function* linesOf(geom) {
  if (!geom) return;
  if (geom.type === "LineString") yield geom.coordinates;
  else if (geom.type === "MultiLineString") yield* geom.coordinates;
}

function bboxOf(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

async function loadFeatures(file, want) {
  const gj = JSON.parse(await fs.readFile(file, "utf8"));
  const feats = [];
  for (const f of gj.features ?? []) {
    const t = f.properties ?? {};
    if (want === "forest" ? isForest(t) : isExclArea(t) || isLine(t)) feats.push(f);
  }
  return feats;
}

const forestFeats = await loadFeatures(forestFile, "forest");
const exclFeats = await loadFeatures(exclFile, "excl");

const tiles = new Map();
const tileFor = (i, j) => {
  const key = keyOf(i, j);
  if (!tiles.has(key)) tiles.set(key, { forest: [], ex: { polys: [], lines: [] } });
  return tiles.get(key);
};

let nForest = 0;
for (const f of forestFeats) {
  for (const p of polysOf(f.geometry)) {
    nForest++;
    const [minX, minY, maxX, maxY] = bboxOf(p.outer);
    for (let i = Math.max(Math.floor(minLon / g), Math.floor(minX / g)); i * g <= maxX + 1e-9 && i * g < maxLon + 1e-9; i++) {
      for (let j = Math.max(Math.floor(minLat / g), Math.floor(minY / g)); j * g <= maxY + 1e-9 && j * g < maxLat + 1e-9; j++) {
        tileFor(i, j).forest.push(p);
      }
    }
  }
}
let nExclPoly = 0;
let nExclLine = 0;
for (const f of exclFeats) {
  const t = f.properties ?? {};
  if (isLine(t)) {
    for (const line of linesOf(f.geometry)) {
      nExclLine++;
      const [minX, minY, maxX, maxY] = bboxOf(line);
      for (let i = Math.max(Math.floor(minLon / g), Math.floor(minX / g)); i * g <= maxX + 1e-9 && i * g < maxLon + 1e-9; i++) {
        for (let j = Math.max(Math.floor(minLat / g), Math.floor(minY / g)); j * g <= maxY + 1e-9 && j * g < maxLat + 1e-9; j++) {
          tileFor(i, j).ex.lines.push(line);
        }
      }
    }
  } else {
    for (const p of polysOf(f.geometry)) {
      nExclPoly++;
      const [minX, minY, maxX, maxY] = bboxOf(p.outer);
      for (let i = Math.max(Math.floor(minLon / g), Math.floor(minX / g)); i * g <= maxX + 1e-9 && i * g < maxLon + 1e-9; i++) {
        for (let j = Math.max(Math.floor(minLat / g), Math.floor(minY / g)); j * g <= maxY + 1e-9 && j * g < maxLat + 1e-9; j++) {
          tileFor(i, j).ex.polys.push(p);
        }
      }
    }
  }
}

await fs.mkdir(root, { recursive: true });
for (const [key, t] of tiles) {
  await fs.writeFile(path.join(root, `forest_${key}.json`), JSON.stringify(t.forest));
  await fs.writeFile(path.join(root, `exclusion_${key}.json`), JSON.stringify(t.ex));
}
console.log(`Skrev ${tiles.size} tiles till data/osm/ — ${nForest} skog-polygoner, ${nExclPoly} exkl-polygoner, ${nExclLine} exkl-linjer.`);
if (nForest === 0 || (nExclPoly === 0 && nExclLine === 0)) {
  console.error("FEL: hittade inga features i GeoJSON-filerna — kontrollera att properties innehåller OSM-tags (osmium export).");
  process.exit(1);
}
