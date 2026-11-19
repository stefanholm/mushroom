import "dotenv/config";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { PNG } from "pngjs";
import { LayerStore, toSWEREF } from "./layers.js";
import { SPECIES, hostFallback, seasonalFactor, staticHabitatScore } from "./habitat.js";

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

const rainCache = new Map<string, { at: number; rain14: number | null }>();

async function rainLast14Days(lat: number, lon: number, asOf: Date): Promise<number | null> {
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
  const inWindow = values.filter((v) => v.to >= cutoff && v.to <= end);
  const rain14 =
    inWindow.length === 0 ? null : inWindow.reduce((sum, v) => sum + Number(v.value), 0);
  rainCache.set(key, { at: Date.now(), rain14 });
  return rain14;
}

const TEMP_PARAMETER = "1";
const tempCache = new Map<string, { at: number; min48: number | null }>();

async function minTempLast48h(lat: number, lon: number): Promise<number | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const cached = tempCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.min48;
  try {
    const stations = await getStations();
    const active = stations.filter((s) => s.active);
    const candidates = active.length > 0 ? active : stations;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const ranked = [...candidates].sort(
      (a, b) =>
        (a.lat - lat) ** 2 + ((a.lon - lon) * cosLat) ** 2 - ((b.lat - lat) ** 2 + ((b.lon - lon) * cosLat) ** 2),
    );
    let body: { value?: { to?: unknown; date?: unknown; value?: unknown }[] } | null = null;
    for (const station of ranked.slice(0, 4)) {
      const r = await fetch(
        `${SMHI_BASE}/parameter/${TEMP_PARAMETER}/station/${station.id}/period/latest-months/data.json`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (r.ok) {
        body = (await r.json()) as { value?: { to?: unknown; date?: unknown; value?: unknown }[] };
        if ((body.value ?? []).length > 0) break;
      }
    }
    if (!body) throw new Error("no temp data");
    const values = (body.value ?? [])
      .map((v) => ({ to: Number(v.to ?? v.date), value: v.value }))
      .filter((v) => Number.isFinite(v.to) && typeof v.value === "string")
      .sort((a, b) => a.to - b.to);
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const recent = values.filter((v) => v.to >= cutoff).map((v) => Number(v.value));
    const min48 = recent.length > 0 ? Math.min(...recent) : null;
    tempCache.set(key, { at: Date.now(), min48 });
    return min48;
  } catch {
    return null;
  }
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
  const attempts = OVERPASS_HOSTS.map((host) =>
    (async () => {
      const r = await fetch(`${host}?data=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { elements?: OverpassElement[]; remark?: string };
      if (body.remark) throw new Error(`remark: ${body.remark}`);
      if ((body.elements ?? []).length === 0) throw new Error("empty result");
      return body as { elements?: OverpassElement[] };
    })(),
  );
  return Promise.any(attempts);
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
    { signal: AbortSignal.timeout(10_000) },
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

const forestCache = new Map<string, { at: number; polys: [number, number][][]; ok: boolean }>();

function cacheFresh(entry: { at: number; ok: boolean } | undefined): boolean {
  if (!entry) return false;
  const ttl = entry.ok ? 24 * 3600 * 1000 : 10 * 60 * 1000;
  return Date.now() - entry.at < ttl;
}

async function forestPolygonsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<[number, number][][] | null> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = forestCache.get(key);
  if (cacheFresh(cached)) return cached!.ok ? cached!.polys : null;
  try {
    const disk = JSON.parse(
      await fsp.readFile(path.join(here, "..", "data", "osm", `forest_${key}.json`), "utf8"),
    );
    if (Array.isArray(disk)) {
      forestCache.set(key, { at: Date.now(), polys: disk, ok: true });
      return disk;
    }
  } catch { /* no disk cache */ }
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const q = `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
  let polys: [number, number][][] = [];
  let ok = true;
  try {
    polys = ringsFromOverpass(await overpassQuery(q)).filter((ring) => ring.length >= 3);
  } catch {
    ok = false;
  }
  if (polys.length === 0 && ok) {
    try {
      const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
      polys = features
        .filter((f) => isForestTag(f.tags))
        .flatMap((f) => f.rings)
        .filter((ring) => ring.length >= 3);
    } catch {
      ok = false;
    }
  }
  forestCache.set(key, { at: Date.now(), polys, ok });
  return ok ? polys : null;
}

type Exclusions = { polys: [number, number][][]; lines: [number, number][][] };
const exclusionCache = new Map<string, { at: number; ex: Exclusions; ok: boolean }>();

async function exclusionsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Exclusions> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = exclusionCache.get(key);
  if (cacheFresh(cached)) return cached!.ex;
  try {
    const disk = JSON.parse(
      await fsp.readFile(path.join(here, "..", "data", "osm", `exclusion_${key}.json`), "utf8"),
    );
    if (disk && Array.isArray(disk.polys) && (disk.polys.length > 0 || disk.lines.length > 0)) {
      exclusionCache.set(key, { at: Date.now(), ex: disk, ok: true });
      return disk;
    }
  } catch { /* no disk cache */ }
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const area = `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
  const lines = `way["highway"](${b});way["railway"](${b});way["aeroway"](${b});`;
  const q = `[out:json][timeout:60];(${area}${lines});out geom;`;
  const ex: Exclusions = { polys: [], lines: [] };
  try {
    const body = await overpassQuery(q);
    if ((body.elements ?? []).length === 0) throw new Error("empty overpass result");
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
    try {
      const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
      for (const f of features) {
        if (isLineTag(f.tags)) ex.lines.push(...f.rings);
        else if (isExcludedAreaTag(f.tags)) ex.polys.push(...f.rings);
      }
    } catch {
      exclusionCache.set(key, { at: Date.now(), ex, ok: false });
      return ex;
    }
  }
  exclusionCache.set(key, { at: Date.now(), ex, ok: true });
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

export type CellScore = { lon: number; lat: number; score: number; heat: number };

function cellForSpan(span: number): number {
  let cell = 0.0001;
  while (span / cell > 110) cell *= 2;
  return cell;
}

function parseAsOf(dateParam: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return new Date();
  const parsed = new Date(`${dateParam}T12:00:00Z`);
  const min = new Date(Date.now() - 120 * 86400_000);
  if (!Number.isNaN(parsed.getTime()) && parsed >= min && parsed <= new Date()) return parsed;
  return new Date();
}

async function computeCells(
  key: string,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  cell: number,
  asOf: Date,
  staticOnly: boolean,
): Promise<{ cells: CellScore[]; meta: Record<string, unknown> }> {
  const species = SPECIES[key];
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(centerLat, centerLon, asOf);
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  const rainFactor = rain14 === null ? 0.5 : Math.min(1, rain14 / 60);
  let minTemp: number | null = null;
  let frost = 1;
  if (!staticOnly) {
    minTemp = await minTempLast48h(centerLat, centerLon);
    if (species.frostSensitive && minTemp !== null && minTemp <= -3) frost = 0;
  }

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  let forestPolys: [number, number][][] | null = null;
  let exclusions: Exclusions = { polys: [], lines: [] };
  if (span <= 2) {
    const [f, x] = await Promise.allSettled([
      forestPolygonsForBox(minLon, minLat, maxLon, maxLat),
      exclusionsForBox(minLon, minLat, maxLon, maxLat),
    ]);
    if (f.status === "fulfilled") forestPolys = f.value;
    else console.error("Forest layer fetch failed:", f.reason);
    if (x.status === "fulfilled") exclusions = x.value;
    else console.error("Exclusion layer fetch failed:", x.reason);
  }

  const store = await getLayerStore();
  const clearcuts = store.vectors.get("avverkningar");

  const startLon = Math.floor(minLon / cell) * cell;
  const startLat = Math.floor(minLat / cell) * cell;
  const cells: CellScore[] = [];
  for (let lat = startLat; lat < maxLat; lat += cell) {
    for (let lon = startLon; lon < maxLon; lon += cell) {
      const clat = lat + cell / 2;
      const clon = lon + cell / 2;
      const inForest = forestPolys === null ? true : pointInPolygon(forestPolys, clon, clat);
      const excluded =
        exclusions.polys.length > 0 && pointInPolygon(exclusions.polys, clon, clat);
      const roadFactor =
        exclusions.lines.length > 0 && distToLinesMeters(exclusions.lines, clon, clat) < 30
          ? 0.2
          : 1;
      const forestEdge =
        inForest &&
        forestPolys !== null &&
        forestPolys.length > 0 &&
        (!pointInPolygon(forestPolys, clon + 0.001, clat) ||
          !pointInPolygon(forestPolys, clon - 0.001, clat) ||
          !pointInPolygon(forestPolys, clon, clat + 0.001) ||
          !pointInPolygon(forestPolys, clon, clat - 0.001));
      const [e, n] = toSWEREF(clon, clat);
      const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
      const habitat = staticHabitatScore(store, key, clon, clat, {
        forestOk: inForest,
        inClearcut,
        excluded,
        roadFactor,
        forestEdge,
      });
      const dynamic = staticOnly ? 1 : seasonalFactor(species, clat, asOf) * rainFactor * frost;
      const score = Math.min(100, Math.round(100 * habitat * dynamic));
      cells.push({ lon: clon, lat: clat, score, heat: 0 });
    }
  }
  const radius = clusterRadiusCells(cell, centerLat);
  if (radius > 0) {
    const cols = Math.max(1, Math.ceil((maxLon - startLon) / cell));
    const rows = Math.max(1, Math.ceil((maxLat - startLat) / cell));
    const grid: (CellScore | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const c of cells) {
      const i = Math.round((c.lon - cell / 2 - startLon) / cell);
      const j = Math.round((c.lat - cell / 2 - startLat) / cell);
      if (j >= 0 && j < rows && i >= 0 && i < cols) grid[j][i] = c;
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = grid[j][i];
        if (c) {
          c.heat = Number(
            heatWithCluster(c.score, countHotNeighbors(grid, rows, cols, j, i, radius, 0), 0).toFixed(3),
          );
        }
      }
    }
  } else {
    for (const c of cells) c.heat = Number(heatOf(c.score, 0).toFixed(3));
  }
  return {
    cells,
    meta: {
      species: key,
      label: species.label,
      rain14,
      rainFactor: Number(rainFactor.toFixed(3)),
      seasonFactor: Number(seasonalFactor(species, centerLat, asOf).toFixed(2)),
      minTemp48h: minTemp,
      frost,
      hostFallback: hostFallback(store),
      staticOnly,
      asOf: asOf.toISOString().slice(0, 10),
      forestAreas: forestPolys?.length ?? 0,
      forestKnown: forestPolys !== null,
      excludedAreas: exclusions.polys.length,
      layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
    },
  };
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
  const asOf = parseAsOf(String(req.query.date ?? ""));

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  const cell = cellForSpan(span);
  const { cells, meta } = await computeCells(key, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly);
  const features = cells.map((c) => ({
    type: "Feature",
    properties: { score: c.score, heat: c.heat },
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
  }));
  res.json({
    type: "FeatureCollection",
    meta: {
      ...meta,
      layers: [
        "smhi-precip-14d",
        "osm-forest-mask",
        "osm-exclusions(water/urban/roads/buildings)",
        "dem-water-cutoff",
        ...(meta.layersLoaded as string[]),
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

const TILE_VERSION = "r12";
const TILES_DIR = path.join(here, "..", "data", "tiles", TILE_VERSION);

const HEAT_BASE = 70;
const HEAT_RANGE = 30;

function tileBBox(z: number, x: number, y: number) {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const latOf = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return { minLon, minLat: latOf(y + 1), maxLon, maxLat: latOf(y) };
}

const HEAT_RAMP: [number, [number, number, number]][] = [
  [0.35, [217, 95, 2]],
  [0.55, [255, 140, 0]],
  [0.72, [242, 60, 20]],
  [0.85, [227, 26, 28]],
  [0.95, [255, 42, 0]],
  [1, [255, 255, 178]],
];

function heatOf(score: number, sens: number): number {
  return Math.min(1, Math.max(0, (score - (HEAT_BASE + sens)) / HEAT_RANGE));
}

function clusterRadiusCells(cellDeg: number, centerLatDeg: number): number {
  const mPerCell = cellDeg * 111000 * Math.max(0.4, Math.cos((centerLatDeg * Math.PI) / 180));
  if (mPerCell > 150) return 0;
  return Math.max(1, Math.min(5, Math.round(50 / mPerCell)));
}

function clusterStep(hotNeighbors: number): number {
  return hotNeighbors >= 3 ? 3 : hotNeighbors === 2 ? 2 : hotNeighbors === 1 ? 1 : 0;
}

function clusterHeatStep(step: number): number {
  return step >= 3 ? 0.2 : step === 2 ? 0.12 : step === 1 ? 0.06 : 0;
}

function heatWithCluster(score: number, hotNeighbors: number, sens: number): number {
  const base = heatOf(score, sens);
  if (base <= 0) return 0;
  return Math.min(1, base + clusterHeatStep(clusterStep(hotNeighbors)));
}

function countHotNeighbors(
  grid: (CellScore | null)[][],
  rows: number,
  cols: number,
  j: number,
  i: number,
  radius: number,
  sens: number,
): number {
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    if (j + dy < 0 || j + dy >= rows) continue;
    const row = grid[j + dy];
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (i + dx < 0 || i + dx >= cols) continue;
      const c = row[i + dx];
      if (c && heatOf(c.score, sens) >= 0.5) n++;
    }
  }
  return n;
}

function heatColor(heat: number): [number, number, number, number] {
  if (heat <= 0) return [0, 0, 0, 0];
  const pos = heat;
  let i = 0;
  while (i < HEAT_RAMP.length - 2 && HEAT_RAMP[i + 1][0] < pos) i++;
  const [h0, c0] = HEAT_RAMP[i];
  const [h1, c1] = HEAT_RAMP[i + 1];
  const t = h1 === h0 ? 1 : Math.min(1, Math.max(0, (pos - h0) / (h1 - h0)));
  const alpha = heat < 0.08 ? 0 : Math.round(Math.pow(heat, 2) * 0.95 * 255);
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * t),
    Math.round(c0[1] + (c1[1] - c0[1]) * t),
    Math.round(c0[2] + (c1[2] - c0[2]) * t),
    alpha,
  ];
}

app.get("/api/meta", async (req, res) => {
  const key = String(req.query.species ?? "kantarell");
  const species = SPECIES[key];
  if (!species) return res.status(400).json({ error: "Okänd art." });
  const asOf = parseAsOf(String(req.query.date ?? ""));
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(62.5, 15.5, asOf);
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  const store = await getLayerStore();
  const [f, x] = await Promise.allSettled([
    forestPolygonsForBox(17.6, 59.0, 18.4, 59.6),
    exclusionsForBox(17.6, 59.0, 18.4, 59.6),
  ]);
  const minTemp = await minTempLast48h(62.5, 15.5);
  const frost = species.frostSensitive && minTemp !== null && minTemp <= -3 ? 0 : 1;
  res.json({
    species: key,
    label: species.label,
    rain14,
    rainFactor: rain14 === null ? 0.5 : Number(Math.min(1, rain14 / 60).toFixed(3)),
    seasonFactor: Number(seasonalFactor(species, 62.5, asOf).toFixed(2)),
    minTemp48h: minTemp,
    frost,
    hostFallback: hostFallback(store),
    asOf: asOf.toISOString().slice(0, 10),
    layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
    tileVersion: path.basename(TILES_DIR),
    forestAreas: f.status === "fulfilled" ? (f.value?.length ?? 0) : 0,
    forestKnown: f.status === "fulfilled" && f.value !== null,
    excludedAreas: x.status === "fulfilled" ? x.value.polys.length : 0,
  });
});

app.get("/api/tiles/habitat/:species/:z/:x/:y.png", async (req, res) => {
  const key = req.params.species;
  if (!SPECIES[key]) return res.status(404).json({ error: "Okänd art." });
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger) || z < 3 || z > 17) {
    return res.status(400).json({ error: "Ogiltig tile." });
  }
  const sens = Math.max(-10, Math.min(10, Math.round(Number(req.query.sens ?? 0) || 0)));
  const dateParam = String(req.query.date ?? "");
  const asOf = parseAsOf(dateParam);
  const staticOnly = req.query.static === "1";
  const bbox = tileBBox(z, x, y);
  const cacheFile = path.join(
    TILES_DIR, "habitat", key, staticOnly ? "static" : "live", dateParam || "now", String(sens), String(z), `${x}_${y}.png`,
  );
  const cacheControl = dateParam || staticOnly ? "public, max-age=86400" : "public, max-age=21600";
  if (fs.existsSync(cacheFile)) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", cacheControl);
    return res.send(await fsp.readFile(cacheFile));
  }
  const span = Math.max(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat);
  const cell = cellForSpan(span);
  const M = 12;
  const eMinLon = bbox.minLon - M * cell;
  const eMaxLon = bbox.maxLon + M * cell;
  const eMinLat = bbox.minLat - M * cell;
  const eMaxLat = bbox.maxLat + M * cell;
  const { cells } = await computeCells(key, eMinLon, eMinLat, eMaxLon, eMaxLat, cell, asOf, staticOnly);
  const eStartLon = Math.floor(eMinLon / cell) * cell;
  const eStartLat = Math.floor(eMinLat / cell) * cell;
  const cols = Math.max(1, Math.ceil((eMaxLon - eStartLon) / cell));
  const rows = Math.max(1, Math.ceil((eMaxLat - eStartLat) / cell));
  const grid: (CellScore | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const c of cells) {
    const i = Math.floor((c.lon - eStartLon) / cell);
    const j = Math.floor((c.lat - eStartLat) / cell);
    if (j >= 0 && j < rows && i >= 0 && i < cols) grid[j][i] = c;
  }
  const clusterRadius = clusterRadiusCells(cell, (bbox.minLat + bbox.maxLat) / 2);
  const R = 2;
  const W = cols * R;
  const H = rows * R;
  const accA = new Float32Array(W * H);
  const accW = new Float32Array(W * H);
  const accR = new Float32Array(W * H);
  const accG = new Float32Array(W * H);
  const accB = new Float32Array(W * H);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = grid[j][i];
      if (!c) continue;
      const n =
        clusterRadius > 0 ? countHotNeighbors(grid, rows, cols, j, i, clusterRadius, sens) : 0;
      const step = clusterStep(n);
      const base = heatOf(c.score, sens);
      if (base <= 0) continue;
      const heat = Math.min(1, base + clusterHeatStep(step));
      const [r, g, b, a] = heatColor(heat);
      const radius = R * (0.75 + 0.45 * step) * (0.75 + 0.45 * heat);
      const cx = i * R + R / 2;
      const cy = j * R + R / 2;
      const x0 = Math.max(0, Math.floor(cx - radius));
      const x1 = Math.min(W - 1, Math.ceil(cx + radius));
      const y0 = Math.max(0, Math.floor(cy - radius));
      const y1 = Math.min(H - 1, Math.ceil(cy + radius));
      const alpha = a / 255;
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
          if (d > radius) continue;
          const add = alpha * (1 - (d / radius) * (d / radius));
          const idx = py * W + px;
          if (add > accA[idx]) accA[idx] = add;
          accW[idx] += add;
          accR[idx] += add * (r / 255);
          accG[idx] += add * (g / 255);
          accB[idx] += add * (b / 255);
        }
      }
    }
  }
  const img = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const idx = k * 4;
    const px = k % W;
    const py = (k / W) | 0;
    const cell = grid[Math.min(rows - 1, Math.floor(py / R))]?.[Math.min(cols - 1, Math.floor(px / R))];
    if (!cell || heatOf(cell.score, sens) <= 0) continue;
    img[idx + 3] = Math.round(Math.min(1, accA[k]) * 255);
    const w = accW[k];
    if (w > 0) {
      img[idx] = Math.round(Math.min(1, accR[k] / w) * 255);
      img[idx + 1] = Math.round(Math.min(1, accG[k] / w) * 255);
      img[idx + 2] = Math.round(Math.min(1, accB[k] / w) * 255);
    }
  }
  const size = 256;
  const png = new PNG({ width: size, height: size });
  const n = 2 ** z;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const wx = (x + (px + 0.5) / size) / n;
      const wy = (y + (py + 0.5) / size) / n;
      const lon = wx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
      const gx = ((lon - eStartLon) / cell) * R;
      const gy = ((lat - eStartLat) / cell) * R;
      const x0 = Math.max(0, Math.min(W - 1, Math.floor(gx)));
      const y0 = Math.max(0, Math.min(H - 1, Math.floor(gy)));
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, gx - x0));
      const ty = Math.max(0, Math.min(1, gy - y0));
      const idx = (py * size + px) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const v00 = img[(y0 * W + x0) * 4 + ch];
        const v10 = img[(y0 * W + x1) * 4 + ch];
        const v01 = img[(y1 * W + x0) * 4 + ch];
        const v11 = img[(y1 * W + x1) * 4 + ch];
        png.data[idx + ch] = Math.round(
          v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty,
        );
      }
    }
  }
  const buf = PNG.sync.write(png);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, buf);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", cacheControl);
  res.send(buf);
});

app.get("/api/debug/cell", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const key = String(req.query.species ?? "kantarell");
  const species = SPECIES[key];
  if (!species || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Expected query params: lat, lon, species." });
  }
  const asOf = parseAsOf(String(req.query.date ?? ""));
  const staticOnly = req.query.static === "1";
  const [forestPolys, exclusions] = await Promise.all([
    forestPolygonsForBox(lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2),
    exclusionsForBox(lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2),
  ]);
  const inForest = forestPolys === null ? true : pointInPolygon(forestPolys, lon, lat);
  const excluded = exclusions.polys.length > 0 && pointInPolygon(exclusions.polys, lon, lat);
  const roadFactor =
    exclusions.lines.length > 0 && distToLinesMeters(exclusions.lines, lon, lat) < 30 ? 0.2 : 1;
  const forestEdge =
    inForest &&
    forestPolys !== null &&
    forestPolys.length > 0 &&
    (!pointInPolygon(forestPolys, lon + 0.001, lat) ||
      !pointInPolygon(forestPolys, lon - 0.001, lat) ||
      !pointInPolygon(forestPolys, lon, lat + 0.001) ||
      !pointInPolygon(forestPolys, lon, lat - 0.001));
  const [e, n] = toSWEREF(lon, lat);
  const store = await getLayerStore();
  const clearcuts = store.vectors.get("avverkningar");
  const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
  const dbg: Record<string, unknown> = {};
  const habitat = staticHabitatScore(
    store,
    key,
    lon,
    lat,
    { forestOk: inForest, inClearcut, excluded, roadFactor, forestEdge },
    dbg,
  );
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(lat, lon, asOf);
  } catch {}
  const rainFactor = rain14 === null ? 0.5 : Math.min(1, rain14 / 60);
  const minTemp = staticOnly ? null : await minTempLast48h(lat, lon);
  const frost = species.frostSensitive && minTemp !== null && minTemp <= -3 ? 0 : 1;
  const dynamic = staticOnly ? 1 : seasonalFactor(species, lat, asOf) * rainFactor * frost;
  res.json({
    species: key,
    lon,
    lat,
    forestKnown: forestPolys !== null,
    forestPolys: forestPolys?.length ?? 0,
    inForest,
    excluded,
    inClearcut,
    roadFactor,
    forestEdge,
    ...dbg,
    habitat: Number(habitat.toFixed(4)),
    rain14,
    rainFactor: Number(rainFactor.toFixed(3)),
    seasonFactor: Number(seasonalFactor(species, lat, asOf).toFixed(2)),
    minTemp48h: minTemp,
    frost,
    score: Math.min(100, Math.round(100 * habitat * dynamic)),
    layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
  });
});

app.get("/api/tiles/hillshade/:z/:x/:y.png", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger) || z < 3 || z > 17) {
    return res.status(400).json({ error: "Ogiltig tile." });
  }
  const bbox = tileBBox(z, x, y);
  const cacheFile = path.join(TILES_DIR, "hillshade", String(z), `${x}_${y}.png`);
  if (fs.existsSync(cacheFile)) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(await fsp.readFile(cacheFile));
  }
  const store = await getLayerStore();
  const dem = store.rasters.get("hojd");
  if (!dem) return res.status(404).json({ error: "hojdmodell saknas." });
  const [w, s] = toSWEREF(bbox.minLon, bbox.minLat);
  const [e, n] = toSWEREF(bbox.maxLon, bbox.maxLat);
  const minE = Math.min(w, e);
  const maxE = Math.max(w, e);
  const minN = Math.min(s, n);
  const maxN = Math.max(s, n);
  const px0 = Math.max(0, Math.floor((minE - dem.originX) / dem.pixelX));
  const px1 = Math.min(dem.width, Math.ceil((maxE - dem.originX) / dem.pixelX));
  const py0 = Math.max(0, Math.floor((maxN - dem.originY) / dem.pixelY));
  const py1 = Math.min(dem.height, Math.ceil((minN - dem.originY) / dem.pixelY));
  const size = 256;
  const png = new PNG({ width: size, height: size });
  if (px1 - px0 < 2 || py1 - py0 < 2) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(PNG.sync.write(png));
  }
  const arr = await dem.readWindow(px0, py0, px1, py1);
  const bands = dem.bands();
  const winW = px1 - px0;
  const winH = py1 - py0;
  const cs = dem.pixelX;
  const at = (xx: number, yy: number): number => {
    const v = arr[(yy * winW + xx) * bands];
    return typeof v === "number" ? v : NaN;
  };
  const zenith = (45 * Math.PI) / 180;
  const azimuth = (315 * Math.PI) / 180;
  const n2 = 2 ** z;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const wx = (x + (px + 0.5) / size) / n2;
      const wy = (y + (py + 0.5) / size) / n2;
      const lon = wx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
      const [ee, nn] = toSWEREF(lon, lat);
      const sx = Math.round((ee - dem.originX) / dem.pixelX) - px0;
      const sy = Math.round((nn - dem.originY) / dem.pixelY) - py0;
      const idx = (py * size + px) * 4;
      if (sx < 1 || sy < 1 || sx >= winW - 1 || sy >= winH - 1) {
        png.data[idx + 3] = 0;
        continue;
      }
      const z0 = at(sx, sy);
      if (!Number.isFinite(z0)) {
        png.data[idx + 3] = 0;
        continue;
      }
      const dzdx = (at(sx + 1, sy) - at(sx - 1, sy)) / (2 * cs);
      const dzdy = (at(sx, sy + 1) - at(sx, sy - 1)) / (2 * cs);
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
  const buf = PNG.sync.write(png);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, buf);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(buf);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});

const PREWARM_POINTS: [number, number][] = [];
for (let lat = 55; lat <= 65; lat += 2) {
  for (let lon = 11; lon <= 23; lon += 3) PREWARM_POINTS.push([lat, lon]);
}
PREWARM_POINTS.push([59.35, 18.05]);

async function prewarmWeather(): Promise<void> {
  for (const [lat, lon] of PREWARM_POINTS) {
    await rainLast14Days(lat, lon, new Date()).catch(() => {});
    await minTempLast48h(lat, lon);
  }
}

setInterval(() => void prewarmWeather(), 6 * 3600 * 1000);
void prewarmWeather();
