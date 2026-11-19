import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
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

async function rainLast14Days(lat: number, lon: number): Promise<number> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
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
  const cutoff = Date.now() - 14 * 86400_000;
  const rain14 = values
    .filter((v) => v.to >= cutoff)
    .reduce((sum, v) => sum + Number(v.value), 0);
  rainCache.set(key, { at: Date.now(), rain14 });
  return rain14;
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const forestCache = new Map<string, { at: number; polys: [number, number][][] }>();

async function forestPolygonsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<[number, number][][]> {
  const g = 0.5;
  const kMinLon = Math.floor(minLon / g) * g;
  const kMinLat = Math.floor(minLat / g) * g;
  const kMaxLon = Math.ceil(maxLon / g) * g;
  const kMaxLat = Math.ceil(maxLat / g) * g;
  const key = `${kMinLon},${kMinLat},${kMaxLon},${kMaxLat}`;
  const cached = forestCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.polys;
  const q = `[out:json][timeout:60];(way["landuse"="forest"](${kMinLat},${kMinLon},${kMaxLat},${kMaxLon});way["natural"="wood"](${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}););out geom;`;
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`Overpass: HTTP ${r.status}`);
  const body = (await r.json()) as { elements?: { geometry?: { lat: number; lon: number }[] }[] };
  const polys = (body.elements ?? [])
    .map((e) => (e.geometry ?? []).map((p) => [p.lon, p.lat] as [number, number]))
    .filter((ring) => ring.length >= 3);
  forestCache.set(key, { at: Date.now(), polys });
  return polys;
}

function pointInForest(polys: [number, number][][], lon: number, lat: number): boolean {
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

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(centerLat, centerLon);
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  const now = new Date();
  const rainFactor = rain14 === null ? 0.5 : Math.min(1, rain14 / 60);
  const seasonAtCenter = seasonalFactor(species, centerLat, now);

  let forestPolys: [number, number][][] = [];
  if (Math.max(maxLon - minLon, maxLat - minLat) <= 2) {
    try {
      forestPolys = await forestPolygonsForBox(minLon, minLat, maxLon, maxLat);
    } catch (err) {
      console.error("Forest layer fetch failed:", err);
    }
  }

  const store = await getLayerStore();
  const clearcuts = store.vectors.get("avverkningar");

  const cell = Math.max((maxLon - minLon) / 40, (maxLat - minLat) / 40, 0.01);
  const features = [];
  for (let lat = minLat; lat < maxLat; lat += cell) {
    for (let lon = minLon; lon < maxLon; lon += cell) {
      const clat = lat + cell / 2;
      const clon = lon + cell / 2;
      const inForest = forestPolys.length === 0 || pointInForest(forestPolys, clon, clat);
      const [e, n] = toSWEREF(clon, clat);
      const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
      const habitat = await staticHabitatScore(store, key, clon, clat, inForest, inClearcut);
      const dynamic = staticOnly ? 1 : seasonalFactor(species, clat, now) * rainFactor;
      const score = Math.round(100 * habitat * dynamic);
      features.push({
        type: "Feature",
        properties: { score },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [lon, lat],
              [lon + cell, lat],
              [lon + cell, lat + cell],
              [lon, lat + cell],
              [lon, lat],
            ],
          ],
        },
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
      forestAreas: forestPolys.length,
      layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
      layers: ["smhi-precip-14d", "osm-forest-mask", ...store.rasters.keys(), ...store.vectors.keys()],
      generatedAt: now.toISOString(),
    },
    features,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});
