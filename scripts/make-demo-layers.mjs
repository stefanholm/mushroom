import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeArrayBuffer } from "geotiff";
import proj4 from "proj4";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "layers");
await fs.mkdir(root, { recursive: true });

// Never clobber real downloaded data: skip existing files unless --force.
const FORCE = process.argv.includes("--force");
async function writeIfAbsent(file, buf, label) {
  const p = path.join(root, file);
  try {
    await fs.access(p);
    if (!FORCE) {
      console.log(`hoppar över ${file} (finns redan; använd --force för att skriva över)`);
      return;
    }
  } catch {}
  await fs.writeFile(p, buf);
  console.log(`wrote ${file}${label ? " " + label : ""}`);
}

const to3006 = ([lon, lat]) => proj4("EPSG:4326", "EPSG:3006", [lon, lat]);

const bbox = { minLon: 17.7, minLat: 59.1, maxLon: 18.5, maxLat: 59.7 };
const [minE, minN] = to3006([bbox.minLon, bbox.minLat]);
const [maxE, maxN] = to3006([bbox.maxLon, bbox.maxLat]);
const res = 100;
const width = Math.ceil((maxE - minE) / res);
const height = Math.ceil((maxN - minN) / res);

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);

async function writeRaster(file, values, bits, sampleFormat) {
  const metadata = {
    width,
    height,
    BitsPerSample: [bits],
    SampleFormat: [sampleFormat],
    PhotometricInterpretation: 1,
    PlanarConfiguration: 1,
    SamplesPerPixel: 1,
    RowsPerStrip: height,
    ModelPixelScale: [res, res, 0],
    ModelTiepoint: [0, 0, 0, minE, maxN, 0],
    ProjectedCSTypeGeoKey: 3006,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
  };
  await writeIfAbsent(file, Buffer.from(writeArrayBuffer(values, metadata)), `${width}x${height}`);
}

const n = width * height;

const tradhojd = new Float32Array(n);
const volym = new Float32Array(n);
const grundyta = new Float32Array(n);
const gran = new Float32Array(n);
const tall = new Float32Array(n);
const bjork = new Float32Array(n);
const ek = new Float32Array(n);
const bok = new Float32Array(n);
const hassel = new Float32Array(n);
const asp = new Float32Array(n);
const sis = new Float32Array(n);
const gdd5 = new Float32Array(n);
const soildepth = new Float32Array(n);
const markfuktighet = new Uint8Array(n);
const jordart = new Uint8Array(n);
const hojd = new Float32Array(n);
const alder = new Float32Array(n);

for (let j = 0; j < height; j++) {
  for (let i = 0; i < width; i++) {
    const k = j * width + i;
    const r = rand();
    tradhojd[k] = 6 + 20 * rand();
    volym[k] = 30 + 280 * rand();
    grundyta[k] = 8 + 45 * rand();
    const mix = rand();
    if (mix < 0.45) { gran[k] = volym[k] * 0.8; tall[k] = volym[k] * 0.1; bjork[k] = volym[k] * 0.1; }
    else if (mix < 0.75) { bjork[k] = volym[k] * 0.6; gran[k] = volym[k] * 0.25; ek[k] = volym[k] * 0.15; }
    else { ek[k] = volym[k] * 0.5; bok[k] = volym[k] * 0.3; hassel[k] = volym[k] * 0.1; bjork[k] = volym[k] * 0.1; }
    asp[k] = volym[k] * (mix < 0.45 ? 0.05 : mix < 0.75 ? 0.2 : 0.05);
    sis[k] = 10 + 18 * rand();
    gdd5[k] = 1560 - ((maxN - minN - (j + 0.5) * res) / 1000) * 1.1 + 20 * rand();
    soildepth[k] = 0.4 + 4 * rand();
    const m = rand();
    markfuktighet[k] = m < 0.1 ? 1 : m < 0.5 ? 2 : m < 0.75 ? 3 : m < 0.95 ? 4 : 5;
    jordart[k] = r < 0.75 ? 1 : 2;
    hojd[k] =
      10 + 80 * (0.5 + 0.5 * Math.sin(i * 0.05) * Math.cos(j * 0.04)) + 5 * rand();
    alder[k] = 15 + 130 * rand();
    if (i >= 150 && i < 210 && j >= 300 && j < 390) hojd[k] = -9999;
    if (i >= 250 && i < 340 && j >= 80 && j < 200) {
      tradhojd[k] = 0;
      volym[k] = 0;
      gran[k] = 0; tall[k] = 0; bjork[k] = 0; ek[k] = 0; bok[k] = 0; hassel[k] = 0; asp[k] = 0;
      grundyta[k] = 0;
      alder[k] = 10;
    }
  }
}

await writeRaster("skog_tradhojd_10m.tif", tradhojd, 32, 3);
await writeRaster("skog_volym_10m.tif", volym, 32, 3);
await writeRaster("grundyta_10m.tif", grundyta, 32, 3);
await writeRaster("skog_gran_10m.tif", gran, 32, 3);
await writeRaster("skog_tall_10m.tif", tall, 32, 3);
await writeRaster("skog_bjork_10m.tif", bjork, 32, 3);
await writeRaster("skog_ek_10m.tif", ek, 32, 3);
await writeRaster("skog_bok_10m.tif", bok, 32, 3);
await writeRaster("skog_hassel_10m.tif", hassel, 32, 3);
await writeRaster("skog_asp_10m.tif", asp, 32, 3);
await writeRaster("skog_sis_10m.tif", sis, 32, 3);
await writeRaster("smhi_gdd5.tif", gdd5, 32, 3);
await writeRaster("sgu_soil_depth_10m.tif", soildepth, 32, 3);
await writeRaster("markfuktighet_10m.tif", markfuktighet, 8, 1);
await writeRaster("jordart_10m.tif", jordart, 8, 1);
await writeRaster("hojdmodell_2m.tif", hojd, 32, 3);
await writeRaster("skog_alder_10m.tif", alder, 32, 3);

// TWI (topografiskt fuktindex, ln(a/tan β)) och lutning (Horn, grader) från demo-DEM:en.
// Riktiga data: se README (gdaldem slope + SAGA TWI på hojdmodell_2m.tif, resampla till 10 m).
const nod = -9999;
const slope = new Float32Array(n).fill(nod);
const twi = new Float32Array(n).fill(nod);
const at = (i, j) => (i < 0 || j < 0 || i >= width || j >= height ? nod : hojd[j * width + i]);
for (let j = 0; j < height; j++) {
  for (let i = 0; i < width; i++) {
    const k = j * width + i;
    const z = hojd[k];
    if (z === nod) continue;
    const dzdx = ((at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1))) / (8 * res);
    const dzdy = ((at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1))) / (8 * res);
    slope[k] = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  }
}
// D8 flow accumulation (sortera högt->lågt, varje cell ger vidare sin ackumulerade area till lägsta grannen)
const acc = new Float64Array(n);
for (let k = 0; k < n; k++) acc[k] = hojd[k] === nod ? 0 : res * res;
const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => hojd[b] - hojd[a]);
const nbrs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
for (const k of order) {
  const z = hojd[k];
  if (z === nod || acc[k] === 0) continue;
  const i = k % width, j = Math.floor(k / width);
  let best = -1, bestZ = z;
  for (const [di, dj] of nbrs) {
    const zi = at(i + di, j + dj);
    if (zi !== nod && zi < bestZ) { bestZ = zi; best = (j + dj) * width + (i + di); }
  }
  if (best >= 0) acc[best] += acc[k];
  const s = Math.max(0.5, slope[k]) * Math.PI / 180;
  twi[k] = Math.log((acc[k] / res) / Math.tan(s));
}
await writeRaster("twi_10m.tif", twi, 32, 3);
await writeRaster("slope_10m.tif", slope, 32, 3);

// Demo: avstånd till "sjön" (nodata-rect i hojd) + död ved-volym (m³/ha)
const waterDist = new Float32Array(n);
for (let j = 0; j < height; j++) {
  for (let i = 0; i < width; i++) {
    const k = j * width + i;
    let best = 1e9;
    for (let jj = 300; jj < 390; jj++) {
      for (let ii = 150; ii < 210; ii++) {
        if (hojd[jj * width + ii] === -9999) {
          const d = Math.hypot((ii - i) * res, (jj - j) * res);
          if (d < best) best = d;
        }
      }
    }
    waterDist[k] = best === 1e9 ? 5000 : best;
  }
}
await writeRaster("water_dist_10m.tif", waterDist, 32, 3);
const dodved = new Float32Array(n);
for (let k = 0; k < n; k++) dodved[k] = volym[k] > 0 ? 5 + 55 * rand() : 0;
await writeRaster("dodved_10m.tif", dodved, 32, 3);

const clearcutSquare = (lon0, lat0, lon1, lat1) => {
  const pts = [
    [lon0, lat0],
    [lon1, lat0],
    [lon1, lat1],
    [lon0, lat1],
    [lon0, lat0],
  ].map(to3006);
  return [pts];
};

const avverkningar = {
  type: "FeatureCollection",
  name: "avverkningar_senaste_5ar",
  crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3006" } },
  features: [
    {
      type: "Feature",
      properties: { typ: "avverkning", ar: 2024 },
      geometry: { type: "Polygon", coordinates: clearcutSquare(18.0, 59.3, 18.06, 59.36) },
    },
    {
      type: "Feature",
      properties: { typ: "avverkning", ar: 2025 },
      geometry: { type: "Polygon", coordinates: clearcutSquare(18.3, 59.45, 18.37, 59.51) },
    },
  ],
};
await writeIfAbsent("avverkningar_senaste_5ar.geojson", JSON.stringify(avverkningar, null, 2));

const nyckelbiotoper = {
  type: "FeatureCollection",
  name: "nyckelbiotoper",
  crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3006" } },
  features: [
    {
      type: "Feature",
      properties: { namn: "demo-nyckelbiotop" },
      geometry: { type: "Polygon", coordinates: clearcutSquare(18.15, 59.42, 18.22, 59.48) },
    },
  ],
};
await writeIfAbsent("nyckelbiotoper.geojson", JSON.stringify(nyckelbiotoper, null, 2));

const sumpskogar = {
  type: "FeatureCollection",
  name: "sumpskogar",
  crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3006" } },
  features: [
    {
      type: "Feature",
      properties: { namn: "demo-sumpskog" },
      geometry: { type: "Polygon", coordinates: clearcutSquare(18.24, 59.3, 18.3, 59.36) },
    },
  ],
};
await writeIfAbsent("sumpskogar.geojson", JSON.stringify(sumpskogar, null, 2));

const manifest = {
  crs: "EPSG:3006",
  comment:
    "Byt ut dessa demofiler mot riktiga nedladdningar (se README). Raster = GeoTIFF i EPSG:3006, band 1.",
  rasters: [
    { id: "tradhojd", file: "skog_tradhojd_10m.tif", nodata: -9999, band: 1 },
    { id: "volym", file: "skog_volym_10m.tif", nodata: -9999, band: 1 },
    { id: "grundyta", file: "grundyta_10m.tif", nodata: -9999, band: 1 },
    { id: "gran", file: "skog_gran_10m.tif", nodata: -9999, band: 1 },
    { id: "tall", file: "skog_tall_10m.tif", nodata: -9999, band: 1 },
    { id: "bjork", file: "skog_bjork_10m.tif", nodata: -9999, band: 1 },
    { id: "ek", file: "skog_ek_10m.tif", nodata: -9999, band: 1 },
    { id: "bok", file: "skog_bok_10m.tif", nodata: -9999, band: 1 },
    { id: "hassel", file: "skog_hassel_10m.tif", nodata: -9999, band: 1 },
    { id: "asp", file: "skog_asp_10m.tif", nodata: -9999, band: 1 },
    { id: "sis", file: "skog_sis_10m.tif", nodata: -9999, band: 1 },
    { id: "gdd5", file: "smhi_gdd5.tif", nodata: -9999, band: 1 },
    { id: "soildepth", file: "sgu_soil_depth_10m.tif", nodata: 255, band: 1 },
    { id: "markfuktighet", file: "markfuktighet_10m.tif", nodata: 255, band: 1 },
    {
      id: "jordart",
      file: "jordart_10m.tif",
      nodata: 255,
      band: 1,
      recode: { "1": "acidic", "2": "calcareous" },
    },
    { id: "hojd", file: "hojdmodell_2m.tif", nodata: -9999, band: 1 },
    { id: "alder", file: "skog_alder_10m.tif", nodata: -9999, band: 1 },
    { id: "twi", file: "twi_10m.tif", nodata: -9999, band: 1 },
    { id: "slope", file: "slope_10m.tif", nodata: -9999, band: 1 },
    { id: "water_rel", file: "water_rel_10m.tif", nodata: -9999, band: 1 },
    { id: "stand_struct", file: "stand_struct_10m.tif", nodata: -9999, band: 1 },
    { id: "water_dist", file: "water_dist_10m.tif", nodata: -9999, band: 1 },
    { id: "dodved", file: "dodved_10m.tif", nodata: -9999, band: 1 },
  ],
  vectors: [
    { id: "avverkningar", file: "avverkningar_senaste_5ar.geojson", crs: "EPSG:3006" },
    { id: "nyckelbiotoper", file: "nyckelbiotoper.geojson", crs: "EPSG:3006" },
    { id: "sumpskogar", file: "sumpskogar.geojson", crs: "EPSG:3006" },
  ],
  mask: {
    file: "nmd_10m.tif",
    forestClasses: [111, 112, 113, 114, 115, 116, 117, 121, 122, 123, 124, 125, 126, 127],
    dilatePx: 3,
    dilateClasses: [51, 52, 53, 54],
    waterClasses: [61, 62],
    waterBufferM: 50,
  },
};
await writeIfAbsent("manifest.json", JSON.stringify(manifest, null, 2));
console.log("Demo-omrade: lon", bbox.minLon, "-", bbox.maxLon, "lat", bbox.minLat, "-", bbox.maxLat);
