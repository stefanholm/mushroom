import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { PNG } from "pngjs";
import { LayerStore, toSWEREF } from "./layers.js";
import { SPECIES, seasonalFactor, staticHabitatScore } from "./habitat.js";

const MODEL = "mistral-small-latest";
const SYSTEM_PROMPT =
  "Du är en hjälpsam assistent för svampplockning i Sverige. Svara alltid på svenska.";

if (!process.env.MISTRAL_API_KEY) {
  console.error("MISTRAL_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const app = express();
app.use(express.json());

const here = path.dirname(fileURLToPath(import.meta.url));
const noCache = { etag: false, lastModified: false, setHeaders: (res: express.Response) => res.setHeader("Cache-Control", "no-cache") };
app.use(express.static(path.join(here, "..", "public"), noCache));
app.use("/vendor/maplibre", express.static(path.join(here, "..", "node_modules", "maplibre-gl", "dist"), noCache));

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function isChatMessage(m: unknown): m is ChatMessage {
  if (typeof m !== "object" || m === null) return false;
  const { role, content } = m as Record<string, unknown>;
  return (
    (role === "system" || role === "user" || role === "assistant") &&
    typeof content === "string"
  );
}

app.post("/api/chat", async (req, res) => {
  const raw: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages: ChatMessage[] = raw.filter(isChatMessage);

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return res
      .status(400)
      .json({ error: "Expected a non-empty messages array ending with a user message." });
  }

  try {
    const response = await client.chat.complete({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });
    const content = response.choices?.[0]?.message?.content;
    const reply =
      typeof content === "string"
        ? content
        : (content ?? [])
            .map((chunk) => ("text" in chunk ? chunk.text : ""))
            .join("");
    res.json({ reply });
  } catch (err) {
    console.error("Mistral API error:", err);
    res.status(502).json({ error: "The Mistral API request failed." });
  }
});

const SMHI_BASE = "https://opendata-download-metobs.smhi.se/api/version/latest";
const PRECIP_PARAMETER = "5";

type SmhiStation = { id: string; lat: number; lon: number; active: boolean };

let stationCache: { at: number; stations: SmhiStation[] } | null = null;

async function getStations(): Promise<SmhiStation[]> {
  if (stationCache && Date.now() - stationCache.at < 24 * 3600 * 1000) {
    return stationCache.stations;
  }
  const r = await fetch(`${SMHI_BASE}/parameter/${PRECIP_PARAMETER}.json`);
  if (!r.ok) throw new Error(`SMHI station list: HTTP ${r.status}`);
  const body = (await r.json()) as {
    station?: { key: unknown; summary?: string; active?: boolean }[];
  };
  const stations: SmhiStation[] = [];
  for (const s of body.station ?? []) {
    const m = /Latitud:\s*(-?[\d.]+)\s+Longitud:\s*(-?[\d.]+)/.exec(s.summary ?? "");
    if (m) {
      stations.push({ id: String(s.key), lat: Number(m[1]), lon: Number(m[2]), active: s.active !== false });
    }
  }
  stationCache = { at: Date.now(), stations };
  return stations;
}

function nearestStation(stations: SmhiStation[], lat: number, lon: number): SmhiStation {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = stations[0];
  let bestD = Infinity;
  for (const s of stations) {
    const d = (s.lat - lat) ** 2 + ((s.lon - lon) * cosLat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

const rainCache = new Map<string, { at: number; rain14: number }>();

async function rainLast14Days(lat: number, lon: number, asOf: Date): Promise<number> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${asOf.toISOString().slice(0, 10)}`;
  const cached = rainCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.rain14;
  const stations = await getStations();
  const active = stations.filter((s) => s.active);
  const station = nearestStation(active.length > 0 ? active : stations, lat, lon);
  const r = await fetch(
    `${SMHI_BASE}/parameter/${PRECIP_PARAMETER}/station/${station.id}/period/latest-months/data.json`,
  );
  if (!r.ok) throw new Error(`SMHI observations: HTTP ${r.status}`);
  const body = (await r.json()) as { value?: { to?: unknown; value?: unknown }[] };
  const values: { to: number; value: string }[] = (body.value ?? [])
    .filter(
      (v): v is { to: number; value: string } =>
        typeof v?.to === "number" && typeof v?.value === "string",
    )
    .sort((a, b) => a.to - b.to);
  const end = asOf.getTime();
  const cutoff = end - 14 * 86400_000;
  const rain14 = values
    .filter((v) => v.to >= cutoff && v.to <= end)
    .reduce((sum, v) => sum + Number(v.value), 0);
  rainCache.set(key, { at: Date.now(), rain14 });
  return rain14;
}

const OVERPASS_HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

type OverpassElement = {
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { geometry?: { lat: number; lon: number }[] }[];
};

async function overpassQuery(q: string): Promise<{ elements?: OverpassElement[] }> {
  let lastErr: unknown = new Error("no host");
  for (const host of OVERPASS_HOSTS) {
    try {
      const r = await fetch(host, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { elements?: OverpassElement[] };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function ringsFromOverpass(body: { elements?: OverpassElement[] }): [number, number][][] {
  const rings: [number, number][][] = [];
  for (const e of body.elements ?? []) {
    if (e.geometry) {
      const ring = e.geometry.map((p) => [p.lon, p.lat] as [number, number]);
      if (ring.length >= 2) rings.push(ring);
    }
    for (const m of e.members ?? []) {
      if (m.geometry) {
        const ring = m.geometry.map((p) => [p.lon, p.lat] as [number, number]);
        if (ring.length >= 2) rings.push(ring);
      }
    }
  }
  return rings;
}

type OsmFeature = { tags: Record<string, string>; rings: [number, number][][] };

const isForestTag = (t: Record<string, string>): boolean =>
  t.landuse === "forest" || t.natural === "wood" || t.natural === "scrub";

const EXCLUDE_LANDUSE_RE =
  /^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$/;
const EXCLUDE_LEISURE = new Set(["pitch", "golf_course", "recreation_ground"]);
const EXCLUDE_MAN_MADE = new Set(["wastewater_plant", "storage_tank"]);

const isExcludedAreaTag = (t: Record<string, string>): boolean =>
  t.natural === "water" ||
  t.waterway !== undefined ||
  t.building !== undefined ||
  (t.landuse !== undefined && EXCLUDE_LANDUSE_RE.test(t.landuse)) ||
  (t.leisure !== undefined && EXCLUDE_LEISURE.has(t.leisure)) ||
  t.amenity === "parking" ||
  t.natural === "grass" ||
  t.shop !== undefined ||
  (t.man_made !== undefined && EXCLUDE_MAN_MADE.has(t.man_made));

const isLineTag = (t: Record<string, string>): boolean =>
  t.highway !== undefined || t.railway !== undefined || t.aeroway !== undefined;

async function osmMainApiFeatures(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
): Promise<OsmFeature[]> {
  const r = await fetch(
    `https://api.openstreetmap.org/api/0.6/map?bbox=${minLon},${minLat},${maxLon},${maxLat}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!r.ok) throw new Error(`OSM API: HTTP ${r.status}`);
  const xml = await r.text();
  const nodes = new Map<string, [number, number]>();
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const id = /id="(\d+)"/.exec(tag)?.[1];
    const lat = /lat="(-?[\d.]+)"/.exec(tag)?.[1];
    const lon = /lon="(-?[\d.]+)"/.exec(tag)?.[1];
    if (id && lat && lon) nodes.set(id, [Number(lon), Number(lat)]);
  }
  const wayRings = new Map<string, { tags: Record<string, string>; ring: [number, number][] }>();
  for (const m of xml.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
    const head = m[0].slice(0, m[0].indexOf(">") + 1);
    const id = /id="(\d+)"/.exec(head)?.[1] ?? "";
    const tags: Record<string, string> = {};
    for (const t of m[1].matchAll(/<tag\b[^>]*k="([^"]+)"[^>]*v="([^"]*)"/g)) tags[t[1]] = t[2];
    const ring: [number, number][] = [];
    for (const n of m[1].matchAll(/<nd\b[^>]*ref="(\d+)"/g)) {
      const c = nodes.get(n[1]);
      if (c) ring.push(c);
    }
    wayRings.set(id, { tags, ring });
  }
  const features: OsmFeature[] = [];
  for (const w of wayRings.values()) {
    if (w.ring.length >= 2) features.push({ tags: w.tags, rings: [w.ring] });
  }
  for (const m of xml.matchAll(/<relation\b[^>]*>([\s\S]*?)<\/relation>/g)) {
    const tags: Record<string, string> = {};
    for (const t of m[1].matchAll(/<tag\b[^>]*k="([^"]+)"[^>]*v="([^"]*)"/g)) tags[t[1]] = t[2];
    const rings: [number, number][][] = [];
    for (const mem of m[1].matchAll(/<member\b[^>]*type="way"[^>]*ref="(\d+)"/g)) {
      const w = wayRings.get(mem[1]);
      if (w && w.ring.length >= 2) rings.push(w.ring);
    }
    if (rings.length > 0) features.push({ tags, rings });
  }
  return features;
}

function gridKey(minLon: number, minLat: number, maxLon: number, maxLat: number): [number, number, number, number, string] {
  const g = 0.4;
  const kMinLon = Math.floor(minLon / g) * g;
  const kMinLat = Math.floor(minLat / g) * g;
  const kMaxLon = Math.ceil(maxLon / g) * g;
  const kMaxLat = Math.ceil(maxLat / g) * g;
  return [kMinLon, kMinLat, kMaxLon, kMaxLat, `${kMinLon},${kMinLat},${kMaxLon},${kMaxLat}`];
}

const forestCache = new Map<string, { at: number; polys: [number, number][][] }>();

async function forestPolygonsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<[number, number][][]> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = forestCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.polys;
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const q = `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
  let polys: [number, number][][];
  try {
    polys = ringsFromOverpass(await overpassQuery(q)).filter((ring) => ring.length >= 3);
  } catch {
    const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
    polys = features
      .filter((f) => isForestTag(f.tags))
      .flatMap((f) => f.rings)
      .filter((ring) => ring.length >= 3);
  }
  forestCache.set(key, { at: Date.now(), polys });
  return polys;
}

type Exclusions = { polys: [number, number][][]; lines: [number, number][][] };
const exclusionCache = new Map<string, { at: number; ex: Exclusions }>();

async function exclusionsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Exclusions> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = exclusionCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.ex;
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const area = `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
  const lines = `way["highway"](${b});way["railway"](${b});way["aeroway"](${b});`;
  const q = `[out:json][timeout:60];(${area}${lines});out geom;`;
  const ex: Exclusions = { polys: [], lines: [] };
  try {
    const body = await overpassQuery(q);
    const pushElement = (e: OverpassElement) => {
      const t = e.tags ?? {};
      const line = Boolean(t.highway || t.railway || t.aeroway);
      const geoms = [e.geometry, ...(e.members ?? []).map((m) => m.geometry)].filter(
        (g): g is { lat: number; lon: number }[] => Array.isArray(g),
      );
      for (const g of geoms) {
        const ring = g.map((p) => [p.lon, p.lat] as [number, number]);
        if (ring.length < 2) continue;
        if (line) ex.lines.push(ring);
        else ex.polys.push(ring);
      }
    };
    for (const e of body.elements ?? []) pushElement(e);
  } catch {
    const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
    for (const f of features) {
      if (isLineTag(f.tags)) ex.lines.push(...f.rings);
      else if (isExcludedAreaTag(f.tags)) ex.polys.push(...f.rings);
    }
  }
  exclusionCache.set(key, { at: Date.now(), ex });
  return ex;
}

function distToLinesMeters(lines: [number, number][][], lon: number, lat: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [x1, y1] = line[i];
      const [x2, y2] = line[i + 1];
      const ax = (x1 - lon) * 111320 * cosLat;
      const ay = (y1 - lat) * 110540;
      const bx = (x2 - lon) * 111320 * cosLat;
      const by = (y2 - lat) * 110540;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : (-(ax * dx + ay * dy)) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (d < best) best = d;
    }
  }
  return best;
}

function pointInPolygon(polys: [number, number][][], lon: number, lat: number): boolean {
  for (const ring of polys) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

const LAYERS_DIR = path.join(here, "..", "data", "layers");
let layerStore: LayerStore | null = null;

async function getLayerStore(): Promise<LayerStore> {
  if (layerStore && !layerStore.empty) return layerStore;
  if (layerStore && !layerStore.shouldRetryEmpty()) return layerStore;
  layerStore = await LayerStore.load(LAYERS_DIR);
  if (!layerStore.empty) {
    console.log(
      `Laddade lager: ${[...layerStore.rasters.keys(), ...layerStore.vectors.keys()].join(", ")}`,
    );
    if (layerStore.missing.length > 0) {
      console.log(`Saknade datafiler: ${layerStore.missing.join(", ")}`);
    }
  }
  return layerStore;
}

app.get("/api/hotspots", async (req, res) => {
  const key = String(req.query.species ?? "");
  const species = SPECIES[key];
  const box = ["minLon", "minLat", "maxLon", "maxLat"].map((k) => Number(req.query[k]));
  if (!species || box.some((n) => !Number.isFinite(n))) {
    return res
      .status(400)
      .json({ error: "Expected query params: species, minLon, minLat, maxLon, maxLat." });
  }
  let [minLon, minLat, maxLon, maxLat] = box;
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (maxLon - minLon > 4 || maxLat - minLat > 4) {
    return res.status(400).json({ error: "Bounding box too large (max 4 degrees per side)." });
  }
  const staticOnly = req.query.static === "1";

  let asOf = new Date();
  const dateParam = String(req.query.date ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const parsed = new Date(`${dateParam}T12:00:00Z`);
    const min = new Date(Date.now() - 120 * 86400_000);
    if (!Number.isNaN(parsed.getTime()) && parsed >= min && parsed <= new Date()) {
      asOf = parsed;
    }
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(centerLat, centerLon, asOf);
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  const rainFactor = rain14 === null ? 0.5 : Math.min(1, rain14 / 60);
  const seasonAtCenter = seasonalFactor(species, centerLat, asOf);

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  let forestPolys: [number, number][][] = [];
  let exclusions: Exclusions = { polys: [], lines: [] };
  if (span <= 2) {
    try {
      forestPolys = await forestPolygonsForBox(minLon, minLat, maxLon, maxLat);
    } catch (err) {
      console.error("Forest layer fetch failed:", err);
    }
    try {
      exclusions = await exclusionsForBox(minLon, minLat, maxLon, maxLat);
    } catch (err) {
      console.error("Exclusion layer fetch failed:", err);
    }
  }

  const store = await getLayerStore();
  const clearcuts = store.vectors.get("avverkningar");

  let cell = 0.00003;
  while (span / cell > 60) cell *= 2;
  const startLon = Math.floor(minLon / cell) * cell;
  const startLat = Math.floor(minLat / cell) * cell;
  const features = [];
  for (let lat = startLat; lat < maxLat; lat += cell) {
    for (let lon = startLon; lon < maxLon; lon += cell) {
      const clat = lat + cell / 2;
      const clon = lon + cell / 2;
      const inForest = forestPolys.length === 0 || pointInPolygon(forestPolys, clon, clat);
      const excluded =
        exclusions.polys.length > 0 && pointInPolygon(exclusions.polys, clon, clat);
      const roadFactor =
        exclusions.lines.length > 0 && distToLinesMeters(exclusions.lines, clon, clat) < 30
          ? 0.2
          : 1;
      const forestEdge =
        inForest &&
        forestPolys.length > 0 &&
        (!pointInPolygon(forestPolys, clon + 0.001, clat) ||
          !pointInPolygon(forestPolys, clon - 0.001, clat) ||
          !pointInPolygon(forestPolys, clon, clat + 0.001) ||
          !pointInPolygon(forestPolys, clon, clat - 0.001));
      const [e, n] = toSWEREF(clon, clat);
      const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
      const habitat = await staticHabitatScore(store, key, clon, clat, {
        forestOk: inForest,
        inClearcut,
        excluded,
        roadFactor,
        forestEdge,
      });
      const dynamic = staticOnly ? 1 : seasonalFactor(species, clat, asOf) * rainFactor;
      const score = Math.round(100 * habitat * dynamic);
      const heat = Math.min(1, Math.max(0, (score - 60) / 40));
      features.push({
        type: "Feature",
        properties: { score, heat: Number(heat.toFixed(3)) },
        geometry: { type: "Point", coordinates: [clon, clat] },
      });
    }
  }
  res.json({
    type: "FeatureCollection",
    meta: {
      species: key,
      label: species.label,
      rain14,
      rainFactor: Number(rainFactor.toFixed(3)),
      seasonFactor: Number(seasonAtCenter.toFixed(2)),
      staticOnly,
      asOf: asOf.toISOString().slice(0, 10),
      forestAreas: forestPolys.length,
      excludedAreas: exclusions.polys.length,
      layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
      layers: [
        "smhi-precip-14d",
        "osm-forest-mask",
        "osm-exclusions(water/urban/roads/buildings)",
        "dem-water-cutoff",
        ...store.rasters.keys(),
        ...store.vectors.keys(),
      ],
      generatedAt: new Date().toISOString(),
    },
    features,
  });
});

app.get("/api/hillshade", async (req, res) => {
  const box = ["minLon", "minLat", "maxLon", "maxLat"].map((k) => Number(req.query[k]));
  if (box.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: "Expected query params: minLon, minLat, maxLon, maxLat." });
  }
  let [minLon, minLat, maxLon, maxLat] = box;
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (maxLon - minLon > 4 || maxLat - minLat > 4) {
    return res.status(400).json({ error: "Bounding box too large (max 4 degrees per side)." });
  }
  const store = await getLayerStore();
  const dem = store.rasters.get("hojd");
  if (!dem) return res.status(404).json({ error: "hojdmodell (data/layers/hojdmodell_2m.tif) saknas." });

  const [w, s] = toSWEREF(minLon, minLat);
  const [e, n] = toSWEREF(maxLon, maxLat);
  const minE = Math.min(w, e);
  const maxE = Math.max(w, e);
  const minN = Math.min(s, n);
  const maxN = Math.max(s, n);
  const px0 = Math.max(0, Math.floor((minE - dem.originX) / dem.pixelX));
  const px1 = Math.min(dem.width, Math.ceil((maxE - dem.originX) / dem.pixelX));
  const py0 = Math.max(0, Math.floor((maxN - dem.originY) / dem.pixelY));
  const py1 = Math.min(dem.height, Math.ceil((minN - dem.originY) / dem.pixelY));
  if (px1 - px0 < 2 || py1 - py0 < 2) {
    return res.status(404).json({ error: "Ingen höjdmodell-täckning i detta område." });
  }
  const out = 512;
  const arr = await dem.readWindow(px0, py0, px1, py1);
  const bands = dem.bands();
  const winW = px1 - px0;
  const winH = py1 - py0;
  const cs = dem.pixelX;
  const at = (x: number, y: number): number => {
    const v = arr[(y * winW + x) * bands];
    return typeof v === "number" ? v : NaN;
  };
  const png = new PNG({ width: out, height: out });
  const zenith = (45 * Math.PI) / 180;
  const azimuth = (315 * Math.PI) / 180;
  for (let oy = 0; oy < out; oy++) {
    for (let ox = 0; ox < out; ox++) {
      const fx = (ox / (out - 1)) * (winW - 1);
      const fy = (oy / (out - 1)) * (winH - 1);
      const x = Math.round(fx);
      const y = Math.round(fy);
      const z = at(x, y);
      const idx = (oy * out + ox) * 4;
      if (!Number.isFinite(z)) {
        png.data[idx + 3] = 0;
        continue;
      }
      const zW = x > 0 ? at(x - 1, y) : z;
      const zE = x < winW - 1 ? at(x + 1, y) : z;
      const zN = y > 0 ? at(x, y - 1) : z;
      const zS = y < winH - 1 ? at(x, y + 1) : z;
      const dzdx = (zE - zW) / (2 * cs);
      const dzdy = (zS - zN) / (2 * cs);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade =
        255 *
        (Math.cos(zenith) * Math.cos(slope) +
          Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect));
      const v = Math.max(0, Math.min(255, Math.round(shade)));
      png.data[idx] = v;
      png.data[idx + 1] = v;
      png.data[idx + 2] = v;
      png.data[idx + 3] = 170;
    }
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-cache");
  res.send(PNG.sync.write(png));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});
