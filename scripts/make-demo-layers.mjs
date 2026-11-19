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
  await fs.writeFile(path.join(root, file), Buffer.from(writeArrayBuffer(values, metadata)));
  console.log("wrote", file, `${width}x${height}`);
}

const n = width * height;

const tradhojd = new Float32Array(n);
const volym = new Float32Array(n);
const markfuktighet = new Uint8Array(n);
const jordart = new Uint8Array(n);
const hojd = new Float32Array(n);

for (let j = 0; j < height; j++) {
  for (let i = 0; i < width; i++) {
    const k = j * width + i;
    const r = rand();
    tradhojd[k] = 6 + 20 * rand();
    volym[k] = 30 + 280 * rand();
    const m = rand();
    markfuktighet[k] = m < 0.1 ? 1 : m < 0.5 ? 2 : m < 0.75 ? 3 : m < 0.95 ? 4 : 5;
    jordart[k] = r < 0.75 ? 1 : 2;
    hojd[k] =
      10 + 80 * (0.5 + 0.5 * Math.sin(i * 0.05) * Math.cos(j * 0.04)) + 5 * rand();
    if (i >= 150 && i < 210 && j >= 300 && j < 390) hojd[k] = -9999;
    if (i >= 250 && i < 340 && j >= 80 && j < 200) {
      tradhojd[k] = 0;
      volym[k] = 0;
    }
  }
}

await writeRaster("skog_tradhojd_10m.tif", tradhojd, 32, 3);
await writeRaster("skog_volym_10m.tif", volym, 32, 3);
await writeRaster("markfuktighet_10m.tif", markfuktighet, 8, 1);
await writeRaster("jordart_10m.tif", jordart, 8, 1);
await writeRaster("hojdmodell_2m.tif", hojd, 32, 3);

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
await fs.writeFile(path.join(root, "avverkningar_senaste_5ar.geojson"), JSON.stringify(avverkningar, null, 2));
console.log("wrote avverkningar_senaste_5ar.geojson");

const manifest = {
  crs: "EPSG:3006",
  comment:
    "Byt ut dessa demofiler mot riktiga nedladdningar (se README). Raster = GeoTIFF i EPSG:3006, band 1.",
  rasters: [
    { id: "tradhojd", file: "skog_tradhojd_10m.tif", nodata: -9999, band: 1 },
    { id: "volym", file: "skog_volym_10m.tif", nodata: -9999, band: 1 },
    { id: "markfuktighet", file: "markfuktighet_10m.tif", nodata: 255, band: 1 },
    {
      id: "jordart",
      file: "jordart_10m.tif",
      nodata: 255,
      band: 1,
      recode: { "1": "acidic", "2": "calcareous" },
    },
    { id: "hojd", file: "hojdmodell_2m.tif", nodata: -9999, band: 1 },
  ],
  vectors: [{ id: "avverkningar", file: "avverkningar_senaste_5ar.geojson", crs: "EPSG:3006" }],
};
await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("wrote manifest.json");
console.log("Demo-omrade: lon", bbox.minLon, "-", bbox.maxLon, "lat", bbox.minLat, "-", bbox.maxLat);
