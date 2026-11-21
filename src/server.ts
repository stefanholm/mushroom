import "dotenv/config";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { PNG } from "pngjs";
import { LayerStore, toSWEREF } from "./layers.js";
import { SPECIES, PACKS, effectiveGdd5, hostFallback, isSpeciesUnlocked, seasonalFactor, staticHabitatScore } from "./habitat.js";

// Entitlements skickas som ?entitlements=pro,expert (csv). I produktion ska detta INTE
// litas på från klienten — validera App Store-kvittot server-side (App Store Server API /
// StoreKit 2) och sätt entitlements där. Här är det dev/test-läge.
function resolveEntitlements(req: express.Request): Set<string> {
  return new Set(
    String(req.query.entitlements ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function gateSpecies(req: express.Request, keys: string[]): string[] {
  const ents = resolveEntitlements(req);
  return keys.filter((k) => SPECIES[k] && !isSpeciesUnlocked(k, ents));
}

function lockedResponse(res: express.Response, locked: string[]) {
  return res.status(403).json({ error: "Låst innehåll — köp svamppack eller Pro i appen.", locked });
}

const MODEL = "mistral-small-latest";
const SYSTEM_PROMPT =
  "Du är en kritisk och säkerhetsfokuserad assistent för svampplockning i Sverige. Svara alltid på svenska. " +
  "KRITISK GRANSKNING (gäller alltid): utgå aldrig från att användarens fråga eller beskrivning är korrekt eller komplett — " +
  "påpeka alltid vad som kan vara fel, vilseledande eller saknas för en bedömning, och ange tydligt när du är osäker. " +
  "Bekräfta aldrig att en svamp är ätlig utifrån en text- eller bildbeskrivning; kräv alltid kontroll mot en oberoende fälthandbok. " +
  "När du nämner en art, nämn alltid dess dödligt giftiga dubbelgångare i Sverige och vad som skiljer dem åt " +
  "(kantarell/trattkantarell har grenade trubbiga åsar, inte tunna skivor — toppig giftspindling har skivor och är dödligt giftig; " +
  "karljohan har vitt ådernät och rör under hatten, gallsopp har mörkt nät och är besk; " +
  "alla orange mjölksaftblödande riskor är ätliga). " +
  "Rekommendera bara lättidentifierade matsvampar utan dödligt giftiga dubbelgångare (t.ex. kantarell, karljohan, " +
  "trattkantarell, svart trumpetsvamp, rödgul trumpetsvamp, blek/rödgul taggsvamp, stolt fjällskivling, vårskivling, brunsopp). " +
  "Rekommendera aldrig murklor/Gyromitra, champinjoner (vit flugsvamp), små fjällskivlingar (Lepiota), " +
  "vårmusseron (bolmörtsskivling) eller spindelskivlingar (Cortinarius) som säkra — om användaren frågar om dem, " +
  "svara bara med deras varnings-checklista (stenmurkla är ALLTID dödligt giftig och aldrig en matsvamp). " +
  "Goliatmusseron är FRIDLYST och rödlistad VU — rekommendera aldrig att plocka den. " +
  "Påminn alltid om att äta aldrig svamp man inte är 100 % säker på, och att vid misstanke om förgiftning kontakta " +
  "Giftinformationscentralen (112 vid akuta symtom).";

const VERDICT_REQUEST =
  /(ätlig|ätbar|äta|plocka|giftig|ofarlig|säker på|safe to eat|edible|poisonous|toxic)/iu;

const SAFETY_CHECKLIST_REPLY =
  "Jag kan inte bekräfta att någon svamp är ätlig eller giftig utifrån en beskrivning — det kan vara livsfarligt fel. " +
  "Gör alltid så här:\n" +
  "1. Identifiera arten med en oberoende fälthandbok och kontrollera ALLA kännetecken: hatt, undersida (skivor/åsar/rör/taggar), fot, kött, mjölksaft, lukt och växtplats.\n" +
  "2. Jämför alltid med dödligt giftiga dubbelgångare: vit flugsvamp och toppig giftspindling (har skivor), stenmurkla och andra murklor/Gyromitra (gyromitrin — ALDRIG matsvamp), små Lepiota, bolmörtsskivling, spindelskivlingar (Cortinarius).\n" +
  "3. Är du inte 100 % säker — ät den inte.\n" +
  "4. Goliatmusseron är fridlyst (rödlistad VU) — plocka aldrig den.\n" +
  "5. Vid minsta misstanke om förgiftning: kontakta Giftinformationscentralen, tel 112 vid akuta symtom.\n" +
  "Beskriv gärna fyndet igen så går vi igenom kännetecknen kritiskt tillsammans — men slutbedömningen måste du göra mot fälthandboken, inte mot mig.";

const RISKY_AFFIRM =
  /(är|blir|var)\s+(ätlig|ätbar|ofarlig|säker)|100\s?%\s*säker|säker på att (äta|plocka)|inga (farliga|giftiga) förväxlingar|safe to eat|not poisonous|non-toxic/iu;

const CRITICAL_APPENDIX =
  "\n\n⚠️ Kritisk kontroll: en beskrivning räcker aldrig för att bekräfta att en svamp är ätlig. " +
  "Kontrollera alltid alla kännetecken mot en fälthandbok och tänk på dödligt giftiga dubbelgångare " +
  "(vit flugsvamp, toppig giftspindling). Ät aldrig svamp du inte är 100 % säker på. " +
  "Vid misstanke om förgiftning: Giftinformationscentralen, 112 vid akuta symtom.";

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

  const lastUser = messages[messages.length - 1].content;
  if (VERDICT_REQUEST.test(lastUser)) {
    return res.json({ reply: SAFETY_CHECKLIST_REPLY });
  }

  try {
    const response = await client.chat.complete({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });
    const content = response.choices?.[0]?.message?.content;
    let reply =
      typeof content === "string"
        ? content
        : (content ?? [])
            .map((chunk) => ("text" in chunk ? chunk.text : ""))
            .join("");
    if (RISKY_AFFIRM.test(reply)) reply += CRITICAL_APPENDIX;
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

const coolCache = new Map<string, { at: number; cool: number | null }>();

async function coolNightsLast7d(lat: number, lon: number, asOf: Date): Promise<number | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${asOf.toISOString().slice(0, 10)}`;
  const cached = coolCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.cool;
  try {
    const stations = await getStations();
    const active = stations.filter((s) => s.active);
    const candidates = active.length > 0 ? active : stations;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const ranked = [...candidates].sort(
      (a, b) =>
        (a.lat - lat) ** 2 + ((a.lon - lon) * cosLat) ** 2 - ((b.lat - lat) ** 2 + ((b.lon - lon) * cosLat) ** 2),
    );
    let body: { value?: { to?: unknown; value?: unknown }[] } | null = null;
    for (const station of ranked.slice(0, 4)) {
      const r = await fetch(
        `${SMHI_BASE}/parameter/${TEMP_PARAMETER}/station/${station.id}/period/latest-months/data.json`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (r.ok) {
        body = (await r.json()) as { value?: { to?: unknown; value?: unknown }[] };
        if ((body.value ?? []).length > 0) break;
      }
    }
    if (!body) return null;
    const values = (body.value ?? [])
      .map((v) => ({ to: Number(v.to), value: Number(v.value) }))
      .filter((v) => Number.isFinite(v.to) && Number.isFinite(v.value))
      .sort((a, b) => a.to - b.to);
    const end = asOf.getTime();
    const cutoff = end - 7 * 86400_000;
    const perDay = new Map<string, number>();
    for (const v of values) {
      if (v.to < cutoff || v.to > end) continue;
      const day = new Date(v.to).toISOString().slice(0, 10);
      const prev = perDay.get(day);
      if (prev === undefined || v.value < prev) perDay.set(day, v.value);
    }
    let cool = 0;
    for (const min of perDay.values()) if (min <= 10) cool++;
    coolCache.set(key, { at: Date.now(), cool });
    return cool;
  } catch {
    return null;
  }
}

function flushFactor(coolNights: number | null): number {
  if (coolNights === null) return 1;
  return 1 + 0.25 * Math.min(1, coolNights / 4);
}

const OVERPASS_HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

type OverpassElement = {
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { role?: string; geometry?: { lat: number; lon: number }[] }[];
};

export type Poly = { outer: [number, number][]; inner: [number, number][][] };

async function overpassQuery(q: string): Promise<{ elements?: OverpassElement[] }> {
  const errors: string[] = [];
  const attempts = OVERPASS_HOSTS.map((host) =>
    (async () => {
      try {
        const r = await fetch(`${host}?data=${encodeURIComponent(q)}`, {
          signal: AbortSignal.timeout(8_000),
          headers: { "User-Agent": "mushroom-finder/1.0 (local research app)" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { elements?: OverpassElement[]; remark?: string };
        if (body.remark) throw new Error(`remark: ${body.remark.slice(0, 80)}`);
        if ((body.elements ?? []).length === 0) throw new Error("empty result");
        return body as { elements?: OverpassElement[] };
      } catch (e) {
        errors.push(`${host.replace("https://", "")}: ${(e as Error).message}`);
        throw e;
      }
    })(),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    console.error(`Overpass misslyckades på alla ${OVERPASS_HOSTS.length} hostar — ${errors.join(" | ")}`);
    throw new Error("all overpass hosts failed");
  }
}

function assembleRings(geoms: [number, number][][]): [number, number][][] {
  const EPS = 1e-7;
  const rings: [number, number][][] = [];
  const open: [number, number][][] = [];
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
        if (Math.abs(ex - ox) < EPS && Math.abs(ey - oy) < EPS) {
          open[i] = [...seg, ...other.slice(1)];
        } else if (Math.abs(ex - px) < EPS && Math.abs(ey - py) < EPS) {
          open[i] = [...seg, ...[...other].reverse().slice(1)];
        } else if (Math.abs(sx - px) < EPS && Math.abs(sy - py) < EPS) {
          open[i] = [...other.slice(0, -1), ...seg];
        } else if (Math.abs(sx - ox) < EPS && Math.abs(sy - oy) < EPS) {
          open[i] = [...[...other].reverse().slice(0, -1), ...seg];
        } else {
          continue;
        }
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

function polysFromOverpass(body: { elements?: OverpassElement[] }): Poly[] {
  const polys: Poly[] = [];
  for (const e of body.elements ?? []) {
    const outerGeoms: [number, number][][] = [];
    const innerGeoms: [number, number][][] = [];
    if (e.geometry) outerGeoms.push(e.geometry.map((p) => [p.lon, p.lat] as [number, number]));
    for (const m of e.members ?? []) {
      if (!m.geometry) continue;
      const ring = m.geometry.map((p) => [p.lon, p.lat] as [number, number]);
      if (m.role === "inner") innerGeoms.push(ring);
      else outerGeoms.push(ring);
    }
    const outers = assembleRings(outerGeoms).filter((r) => r.length >= 3);
    const inners = assembleRings(innerGeoms).filter((r) => r.length >= 3);
    for (const o of outers) {
      polys.push({ outer: o, inner: inners.filter((i) => pointInRing(o, i[0][0], i[0][1])) });
    }
  }
  return polys;
}

function ringsFromOverpass(body: { elements?: OverpassElement[] }): [number, number][][] {
  return polysFromOverpass(body).map((p) => p.outer);
}

type OsmFeature = { tags: Record<string, string>; rings: [number, number][][] };

const isForestTag = (t: Record<string, string>): boolean =>
  t.landuse === "forest" || t.natural === "wood" || t.natural === "scrub";

const EXCLUDE_LANDUSE_RE =
  /^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$/;
const EXCLUDE_LEISURE = new Set(["pitch", "golf_course", "recreation_ground", "park", "garden", "playground", "dog_park"]);
const EXCLUDE_MAN_MADE = new Set(["wastewater_plant", "storage_tank"]);

const isWaterTag = (t: Record<string, string>): boolean =>
  t.natural === "water" || t.waterway !== undefined;

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

const PAVED_HIGHWAY_RE =
  /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|bus_guideway|raceway|road)$/;

const isLineTag = (t: Record<string, string>): boolean =>
  (t.highway !== undefined && PAVED_HIGHWAY_RE.test(t.highway)) ||
  t.railway !== undefined ||
  t.aeroway !== undefined;

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

const forestCache = new Map<string, { at: number; polys: Poly[]; ok: boolean }>();

function cacheFresh(entry: { at: number; ok: boolean } | undefined): boolean {
  if (!entry) return false;
  const ttl = entry.ok ? 24 * 3600 * 1000 : 10 * 60 * 1000;
  return Date.now() - entry.at < ttl;
}

const OSM_TILE_SIZES = [0.4, 0.2, 0.1];

async function diskForestTiles(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Poly[] | null> {
  for (const g of OSM_TILE_SIZES) {
    const polys: Poly[] = [];
    let allPresent = true;
    for (let i = Math.floor(minLon / g); i * g < maxLon + 1e-9 && allPresent; i++) {
      for (let j = Math.floor(minLat / g); j * g < maxLat + 1e-9 && allPresent; j++) {
        const key = `${(i * g).toFixed(6)},${(j * g).toFixed(6)},${((i + 1) * g).toFixed(6)},${((j + 1) * g).toFixed(6)}`;
        try {
          const raw = JSON.parse(
            await fsp.readFile(path.join(here, "..", "data", "osm", `forest_${key}.json`), "utf8"),
          );
          for (const p of Array.isArray(raw) ? raw : []) {
            polys.push(Array.isArray(p) ? { outer: p as [number, number][], inner: [] as [number, number][][] } : (p as Poly));
          }
        } catch {
          allPresent = false;
        }
      }
    }
    if (allPresent) return polys;
  }
  return null;
}

async function diskExclusionTiles(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Exclusions | null> {
  for (const g of OSM_TILE_SIZES) {
    const ex: Exclusions = { polys: [], lines: [] };
    let allPresent = true;
    for (let i = Math.floor(minLon / g); i * g < maxLon + 1e-9 && allPresent; i++) {
      for (let j = Math.floor(minLat / g); j * g < maxLat + 1e-9 && allPresent; j++) {
        const key = `${(i * g).toFixed(6)},${(j * g).toFixed(6)},${((i + 1) * g).toFixed(6)},${((j + 1) * g).toFixed(6)}`;
        try {
          const raw = JSON.parse(
            await fsp.readFile(path.join(here, "..", "data", "osm", `exclusion_${key}.json`), "utf8"),
          ) as { polys?: unknown; lines?: unknown; water?: unknown };
          for (const p of Array.isArray(raw?.polys) ? raw.polys : []) {
            ex.polys.push(Array.isArray(p) ? { outer: p as [number, number][], inner: [] as [number, number][][] } : (p as Poly));
          }
          for (const l of Array.isArray(raw?.lines) ? raw.lines : []) ex.lines.push(l as [number, number][]);
          for (const p of Array.isArray(raw?.water) ? raw.water : []) {
            (ex.water ??= []).push(Array.isArray(p) ? { outer: p as [number, number][], inner: [] as [number, number][][] } : (p as Poly));
          }
        } catch {
          allPresent = false;
        }
      }
    }
    if (allPresent) return ex;
  }
  return null;
}

async function forestPolygonsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Poly[] | null> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = forestCache.get(key);
  if (cacheFresh(cached)) return cached!.ok ? cached!.polys : null;
  const disk = await diskForestTiles(minLon, minLat, maxLon, maxLat);
  if (disk) {
    forestCache.set(key, { at: Date.now(), polys: disk, ok: true });
    return disk;
  }
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const q = `[out:json][timeout:60];(way["landuse"="forest"](${b});way["natural"="wood"](${b});way["natural"="scrub"](${b});relation["landuse"="forest"](${b});relation["natural"="wood"](${b}););out geom;`;
  let polys: Poly[] = [];
  let ok = true;
  try {
    polys = polysFromOverpass(await overpassQuery(q));
  } catch {
    ok = false;
  }
  if (polys.length === 0 && ok) {
    try {
      const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
      polys = features
        .filter((f) => isForestTag(f.tags))
        .flatMap((f) => f.rings)
        .filter((ring) => ring.length >= 3)
        .map((ring) => ({ outer: ring, inner: [] as [number, number][][] }));
    } catch {
      ok = false;
    }
  }
  forestCache.set(key, { at: Date.now(), polys, ok });
  return ok ? polys : null;
}

type Exclusions = { polys: Poly[]; lines: [number, number][][]; water?: Poly[] };

const EXCLUSION_BUFFER_M = 30;
const WATER_BUFFER_M = 50;
const ROAD_ZERO_M = 50;
const ROAD_HALF_M = 80;
const exclusionCache = new Map<string, { at: number; ex: Exclusions; ok: boolean }>();

async function exclusionsForBox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Promise<Exclusions | null> {
  const [kMinLon, kMinLat, kMaxLon, kMaxLat, key] = gridKey(minLon, minLat, maxLon, maxLat);
  const cached = exclusionCache.get(key);
  if (cacheFresh(cached)) return cached!.ok ? cached!.ex : null;
  const disk = await diskExclusionTiles(minLon, minLat, maxLon, maxLat);
  if (disk) {
    exclusionCache.set(key, { at: Date.now(), ex: disk, ok: true });
    return disk;
  }
  const b = `${kMinLat},${kMinLon},${kMaxLat},${kMaxLon}`;
  const area = `way["natural"="water"](${b});way["waterway"](${b});way["building"](${b});way["landuse"~"^(industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green)$"](${b});way["leisure"~"^(pitch|golf_course|recreation_ground|park|garden|playground|dog_park)$"](${b});way["amenity"="parking"](${b});way["natural"="grass"](${b});way["shop"](${b});way["man_made"~"^(wastewater_plant|storage_tank)$"](${b});relation["natural"="water"](${b});relation["building"](${b});relation["landuse"~"^(industrial|commercial|residential|urban|landfill|military|retail)$"](${b});`;
  const lines = `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|bus_guideway|raceway|road)"](${b});way["railway"](${b});way["aeroway"](${b});`;
  const q = `[out:json][timeout:60];(${area}${lines});out geom;`;
  const ex: Exclusions = { polys: [], lines: [], water: [] };
  let ok = true;
  try {
    const body = await overpassQuery(q);
    if ((body.elements ?? []).length === 0) throw new Error("empty overpass result");
    for (const e of body.elements ?? []) {
      const t = e.tags ?? {};
      const line = Boolean(t.highway || t.railway || t.aeroway);
      if (line) {
        for (const g of [e.geometry, ...(e.members ?? []).map((m) => m.geometry)]) {
          if (!Array.isArray(g)) continue;
          const ring = g.map((p) => [p.lon, p.lat] as [number, number]);
          if (ring.length >= 2) ex.lines.push(ring);
        }
      } else {
        const ps = polysFromOverpass({ elements: [e] });
        if (isWaterTag(t)) ex.water!.push(...ps);
        else ex.polys.push(...ps);
      }
    }
  } catch {
    ok = false;
  }
  if (ok && ex.polys.length === 0 && ex.lines.length === 0) {
    try {
      const features = await osmMainApiFeatures(kMinLat, kMinLon, kMaxLat, kMaxLon);
      for (const f of features) {
        if (isLineTag(f.tags)) ex.lines.push(...f.rings);
        else if (isExcludedAreaTag(f.tags)) {
          for (const ring of f.rings) {
            if (ring.length < 3) continue;
            if (isWaterTag(f.tags)) ex.water!.push({ outer: ring, inner: [] as [number, number][][] });
            else ex.polys.push({ outer: ring, inner: [] as [number, number][][] });
          }
        }
      }
    } catch {
      ok = false;
    }
  }
  exclusionCache.set(key, { at: Date.now(), ex, ok });
  return ok ? ex : null;
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

function pointInRing(ring: [number, number][], lon: number, lat: number): boolean {
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
  if (lon < minX || lon > maxX || lat < minY || lat > maxY) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolys(polys: Poly[], lon: number, lat: number): boolean {
  for (const p of polys) {
    if (pointInRing(p.outer, lon, lat) && !p.inner.some((r) => pointInRing(r, lon, lat))) return true;
  }
  return false;
}

function distToPolysMeters(polys: Poly[], lon: number, lat: number): number {
  let best = Infinity;
  for (const p of polys) {
    const closed = [...p.outer, p.outer[0]];
    const d = distToLinesMeters([closed], lon, lat);
    if (d < best) best = d;
  }
  return best;
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

// Artportalen-observationslager ("out of the box"): verkliga fynd per art ger en
// närhetsprior som höjer score nära tidigare fynd (gaussisk kernel, sigma 250 m, max +35 %).
// Läser data/validation/observations.geojson (git-ignored, från `npm run artfakta`).
type ObsIndex = Map<string, Map<string, [number, number][]>>;
let obsIndexCache: ObsIndex | null = null;
async function getObsIndex(): Promise<ObsIndex> {
  if (obsIndexCache) return obsIndexCache;
  const idx: ObsIndex = new Map();
  try {
    const p = path.join(here, "..", "data", "validation", "observations.geojson");
    if (fs.existsSync(p)) {
      const j = JSON.parse(await fsp.readFile(p, "utf8"));
      for (const f of j.features ?? []) {
        const sp = f.properties?.species;
        const c = f.geometry?.coordinates;
        if (typeof sp !== "string" || !Array.isArray(c) || c.length < 2) continue;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const key = `${Math.floor(lon / 0.05)}:${Math.floor(lat / 0.05)}`;
        let m = idx.get(sp);
        if (!m) {
          m = new Map();
          idx.set(sp, m);
        }
        let arr = m.get(key);
        if (!arr) {
          arr = [];
          m.set(key, arr);
        }
        arr.push([lon, lat]);
      }
      console.log(`Observationslager: ${idx.size} arter från observations.geojson`);
    }
  } catch (e) {
    console.error("Kunde inte läsa observations.geojson:", e);
  }
  obsIndexCache = idx;
  return idx;
}

function obsPrior(index: ObsIndex, species: string, lon: number, lat: number): number {
  const m = index.get(species);
  if (!m || m.size === 0) return 0;
  const ci = Math.floor(lon / 0.05);
  const cj = Math.floor(lat / 0.05);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const arr = m.get(`${ci + di}:${cj + dj}`);
      if (!arr) continue;
      for (const [olo, ala] of arr) {
        const dx = (olo - lon) * 111000 * cosLat;
        const dy = (ala - lat) * 111000;
        const d = Math.hypot(dx, dy);
        if (d > 750) continue;
        const v = Math.exp(-((d / 250) ** 2));
        if (v > best) best = v;
      }
    }
  }
  return best;
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
  let coolNights: number | null = null;
  let flush = 1;
  if (!staticOnly) {
    minTemp = await minTempLast48h(centerLat, centerLon);
    if (species.frostSensitive && minTemp !== null && minTemp <= -3) frost = 0;
    coolNights = await coolNightsLast7d(centerLat, centerLon, asOf);
    flush = flushFactor(coolNights);
  }

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  const store = await getLayerStore();
  const useMask = store.mask !== null;
  let forestPolys: Poly[] | null = null;
  let exclusions: Exclusions | null = null;
  if (span <= 2 && !useMask) {
    const jobs: Promise<unknown>[] = [];
    jobs.push(forestPolygonsForBox(minLon, minLat, maxLon, maxLat));
    jobs.push(exclusionsForBox(minLon, minLat, maxLon, maxLat));
    const settled = await Promise.allSettled(jobs);
    let idx = 0;
    if (!useMask) {
      const f = settled[idx++];
      if (f.status === "fulfilled") forestPolys = f.value as Poly[] | null;
      else console.error("Forest layer fetch failed:", f.reason);
    }
    const x = settled[idx];
    if (x.status === "fulfilled") exclusions = x.value as Exclusions | null;
    else console.error("Exclusion layer fetch failed:", x.reason);
  }
  const ex: Exclusions = exclusions ?? { polys: [], lines: [] };

  const clearcuts = store.vectors.get("avverkningar");

  const startLon = Math.floor(minLon / cell) * cell;
  const startLat = Math.floor(minLat / cell) * cell;
  const cells: CellScore[] = [];
  for (let lat = startLat; lat < maxLat; lat += cell) {
    for (let lon = startLon; lon < maxLon; lon += cell) {
      const clat = lat + cell / 2;
      const clon = lon + cell / 2;
      const [e0, n0] = toSWEREF(clon, clat);
      const inForest = useMask
        ? store.mask!.has(e0, n0) && store.mask!.allows(e0, n0)
        : forestPolys !== null && pointInPolys(forestPolys, clon, clat);
      const waterPolys = ex.water ?? [];
      const nearWater =
        waterPolys.length > 0 &&
        (pointInPolys(waterPolys, clon, clat) || distToPolysMeters(waterPolys, clon, clat) < WATER_BUFFER_M);
      const excluded =
        nearWater ||
        (ex.polys.length > 0 &&
          (pointInPolys(ex.polys, clon, clat) || distToPolysMeters(ex.polys, clon, clat) < EXCLUSION_BUFFER_M));
      const roadDist =
        ex.lines.length > 0 ? distToLinesMeters(ex.lines, clon, clat) : Infinity;
      const roadFactor = roadDist < ROAD_ZERO_M ? 0 : roadDist < ROAD_HALF_M ? 0.5 : 1;
      const forestEdge =
        inForest &&
        forestPolys !== null &&
        forestPolys.length > 0 &&
        (!pointInPolys(forestPolys, clon + 0.001, clat) ||
          !pointInPolys(forestPolys, clon - 0.001, clat) ||
          !pointInPolys(forestPolys, clon, clat + 0.001) ||
          !pointInPolys(forestPolys, clon, clat - 0.001));
      const [e, n] = [e0, n0];
      const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
      const habitat = staticHabitatScore(store, key, clon, clat, {
        forestOk: inForest,
        inClearcut,
        excluded,
        roadFactor,
        forestEdge,
      });
      const dynamic = staticOnly ? 1 : seasonalFactor(species, clat, asOf) * rainFactor * frost * flush;
      const prior = obsPrior(await getObsIndex(), key, clon, clat);
      const score = Math.min(100, Math.round(100 * habitat * dynamic * (1 + 0.35 * prior)));
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
      coolNights7d: coolNights,
      flush,
      hostFallback: hostFallback(store),
      staticOnly,
      asOf: asOf.toISOString().slice(0, 10),
      forestAreas: forestPolys?.length ?? 0,
      forestKnown: useMask ? true : forestPolys !== null,
      maskUsed: useMask,
      excludedAreas: ex.polys.length,
      layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
    },
  };
}

app.get("/api/hotspots", async (req, res) => {
  const keys = String(req.query.species ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k]);
  const locked0 = gateSpecies(req, keys);
  if (locked0.length > 0) return lockedResponse(res, locked0);
  const species = SPECIES[keys[0] ?? ""];
  const bboxParam = String(req.query.bbox ?? "");
  const box = bboxParam
    ? bboxParam.split(",").map(Number)
    : ["minLon", "minLat", "maxLon", "maxLat"].map((k) => Number(req.query[k]));
  if (!species || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return res
      .status(400)
      .json({ error: "Expected query params: species, minLon, minLat, maxLon, maxLat (or bbox=minLon,minLat,maxLon,maxLat)." });
  }
  let [minLon, minLat, maxLon, maxLat] = box;
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (maxLon - minLon > 4 || maxLat - minLat > 4) {
    return res.status(400).json({ error: "Bounding box too large (max 4 degrees per side)." });
  }
  const staticOnly = req.query.static === "1";
  const asOf = parseAsOf(String(req.query.date ?? ""));
  const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 80) || 80));

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  const cell = cellForSpan(span);

  if (bboxParam) {
    // Peak-pocket mode for the iOS symbol/icon layer: local maxima >= minScore,
    // thinned to ~120 m spacing, capped at 120 per viewport, across all checked species.
    const perSpecies = await Promise.all(
      keys.map((k) => computeCells(k, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly)),
    );
    const all: { lon: number; lat: number; score: number; species: string }[] = [];
    for (let si = 0; si < perSpecies.length; si++) {
      const { cells } = perSpecies[si];
      const grid = new Map<string, CellScore>();
      for (const c of cells) grid.set(`${c.lon.toFixed(6)},${c.lat.toFixed(6)}`, c);
      for (const c of cells) {
        if (c.score < minScore) continue;
        let isPeak = true;
        for (let dj = -1; dj <= 1 && isPeak; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const nb = grid.get(`${(c.lon + di * cell).toFixed(6)},${(c.lat + dj * cell).toFixed(6)}`);
            if (nb && nb.score > c.score) {
              isPeak = false;
              break;
            }
          }
        }
        if (isPeak) all.push({ lon: c.lon, lat: c.lat, score: c.score, species: keys[si] });
      }
    }
    all.sort((a, b) => b.score - a.score);
    const centerLat = (minLat + maxLat) / 2;
    const mPerDegLat = 111000;
    const mPerDegLon = 111000 * Math.cos((centerLat * Math.PI) / 180);
    const spacingDeg = 120 / Math.max(mPerDegLat, mPerDegLon);
    const picked: typeof all = [];
    for (const p of all) {
      if (picked.length >= 120) break;
      const tooClose = picked.some(
        (q) => Math.abs(q.lat - p.lat) < spacingDeg && Math.abs(q.lon - p.lon) < spacingDeg,
      );
      if (!tooClose) picked.push(p);
    }
    return res.json({
      hotspots: picked.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        species: p.species,
        label: SPECIES[p.species]?.label ?? p.species,
        eatScore: SPECIES[p.species]?.eatScore ?? null,
        score: p.score,
      })),
      meta: { count: picked.length, minScore, species: keys, asOf: asOf.toISOString().slice(0, 10), staticOnly },
    });
  }

  const key = keys[0];
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

app.get("/api/peaks", async (req, res) => {
  const key = String(req.query.species ?? "");
  const locked1 = gateSpecies(req, [key]);
  if (locked1.length > 0) return lockedResponse(res, locked1);
  const species = SPECIES[key];
  const box = ["minLon", "minLat", "maxLon", "maxLat"].map((k) => Number(req.query[k]));
  const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 80) || 80));
  if (!species || box.some((n) => !Number.isFinite(n))) {
    return res
      .status(400)
      .json({ error: "Expected query params: species, minLon, minLat, maxLon, maxLat, [minScore]." });
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
  const grid = new Map<string, CellScore>();
  for (const c of cells) grid.set(`${c.lon.toFixed(6)},${c.lat.toFixed(6)}`, c);
  const peaks: CellScore[] = [];
  for (const c of cells) {
    if (c.score < minScore) continue;
    let isPeak = true;
    for (let dj = -1; dj <= 1 && isPeak; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const n = grid.get(`${(c.lon + di * cell).toFixed(6)},${(c.lat + dj * cell).toFixed(6)}`);
        if (n && n.score > c.score) {
          isPeak = false;
          break;
        }
      }
    }
    if (isPeak) peaks.push(c);
  }
  res.json({
    type: "FeatureCollection",
    meta: { ...meta, minScore, peakCount: peaks.length },
    features: peaks.map((c) => ({
      type: "Feature",
      properties: { score: c.score, heat: c.heat, species: key, label: species.label, eatScore: species.eatScore },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    })),
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

const TILE_VERSION = "r15";
const TILES_DIR = path.join(here, "..", "data", "tile-cache", TILE_VERSION);

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
  [0.25, [0, 178, 190]],
  [0.42, [16, 185, 129]],
  [0.58, [245, 179, 1]],
  [0.74, [255, 122, 0]],
  [0.88, [227, 26, 28]],
  [0.97, [255, 42, 0]],
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
  const mLat = Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : 62.5;
  const mLon = Number.isFinite(Number(req.query.lon)) ? Number(req.query.lon) : 15.5;
  let rain14: number | null = null;
  try {
    rain14 = await rainLast14Days(mLat, mLon, asOf);
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  const store = await getLayerStore();
  const [f, x] =
    store.mask !== null
      ? [null, null]
      : await Promise.allSettled([
          forestPolygonsForBox(17.6, 59.0, 18.4, 59.6),
          exclusionsForBox(17.6, 59.0, 18.4, 59.6),
        ]);
  const minTemp = await minTempLast48h(mLat, mLon);
  const frost = species.frostSensitive && minTemp !== null && minTemp <= -3 ? 0 : 1;
  const coolNights = await coolNightsLast7d(mLat, mLon, asOf);
  const flush = flushFactor(coolNights);
  const gdd5 = effectiveGdd5(store, mLon, mLat);
  res.json({
    species: key,
    label: species.label,
    eatScore: species.eatScore,
    note: species.note,
    protected: !!species.protected,
    expertMode: !!species.expertMode,
    lookalikes: species.lookalikes ?? null,
    season: [species.seasonStart, species.seasonEnd],
    entitlements: [...resolveEntitlements(req)],
    packs: Object.values(PACKS).map((p) => ({ id: p.id, label: p.label, priceSek: p.priceSek, kind: p.kind, speciesCount: p.species.length })),
    speciesList: Object.entries(SPECIES).map(([id, s]) => ({
      id,
      label: s.label,
      eatScore: s.eatScore,
      season: [s.seasonStart, s.seasonEnd],
      note: s.note,
      protected: !!s.protected,
      expertMode: !!s.expertMode,
      lookalikes: s.lookalikes ?? null,
      pack: s.pack ?? null,
      locked: !isSpeciesUnlocked(id, resolveEntitlements(req)),
    })),
    rain14,
    rainFactor: rain14 === null ? 0.5 : Number(Math.min(1, rain14 / 60).toFixed(3)),
    seasonFactor: Number(seasonalFactor(species, mLat, asOf).toFixed(2)),
    lat: mLat,
    lon: mLon,
    gdd5: gdd5 === null ? null : Math.round(gdd5),
    minTemp48h: minTemp,
    frost,
    coolNights7d: coolNights,
    flush,
    hostFallback: hostFallback(store),
    asOf: asOf.toISOString().slice(0, 10),
    layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
    tileVersion: path.basename(TILES_DIR),
    forestAreas: f && f.status === "fulfilled" ? (f.value?.length ?? 0) : 0,
    forestKnown: store.mask !== null || (f !== null && f.status === "fulfilled" && f.value !== null),
    maskUsed: store.mask !== null,
    excludedAreas: x && x.status === "fulfilled" ? (x.value?.polys.length ?? 0) : 0,
    forestCount: f && f.status === "fulfilled" ? (f.value?.length ?? 0) : 0,
    exclCount: x && x.status === "fulfilled" ? (x.value?.polys.length ?? 0) : 0,
  });
});

async function renderHabitatTile(
  keys: string[],
  z: number,
  x: number,
  y: number,
  sens: number,
  asOf: Date,
  staticOnly: boolean,
  dateParam: string,
  cacheSub: string,
): Promise<{ buf: Buffer; cacheControl: string }> {
  const bbox = tileBBox(z, x, y);
  const cacheFile = path.join(
    TILES_DIR, cacheSub, staticOnly ? "static" : "live", dateParam || "now", String(sens), String(z), `${x}_${y}.png`,
  );
  const cacheControl = dateParam || staticOnly ? "public, max-age=86400" : "public, max-age=21600";
  if (fs.existsSync(cacheFile)) {
    return { buf: await fsp.readFile(cacheFile), cacheControl };
  }
  const span = Math.max(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat);
  const cell = cellForSpan(span);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerCell = cell * 111000 * Math.max(0.4, Math.cos((centerLat * Math.PI) / 180));
  const M = Math.max(2, Math.min(24, Math.ceil(150 / Math.max(1, mPerCell))));
  const eMinLon = bbox.minLon - M * cell;
  const eMaxLon = bbox.maxLon + M * cell;
  const eMinLat = bbox.minLat - M * cell;
  const eMaxLat = bbox.maxLat + M * cell;
  let cells: CellScore[];
  if (keys.length === 1) {
    cells = (await computeCells(keys[0], eMinLon, eMinLat, eMaxLon, eMaxLat, cell, asOf, staticOnly)).cells;
  } else {
    const parts = await Promise.all(
      keys.map((k) => computeCells(k, eMinLon, eMinLat, eMaxLon, eMaxLat, cell, asOf, staticOnly)),
    );
    const merged = new Map<string, CellScore>();
    for (const p of parts) {
      for (const c of p.cells) {
        const ck = `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`;
        const prev = merged.get(ck);
        if (!prev || c.score > prev.score) merged.set(ck, c);
      }
    }
    cells = [...merged.values()];
  }
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
  const clusterRadius = clusterRadiusCells(cell, centerLat);
  const R = 2;
  const W = cols * R;
  const H = rows * R;
  const heatF = new Float32Array(W * H);
  const maskF = new Float32Array(W * H);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = grid[j][i];
      const allowed = !!c && c.score > 0;
      let heat = 0;
      if (allowed) {
        const n =
          clusterRadius > 0 ? countHotNeighbors(grid, rows, cols, j, i, clusterRadius, sens) : 0;
        heat = heatWithCluster(c!.score, n, sens);
      }
      for (let dy = 0; dy < R; dy++) {
        for (let dx = 0; dx < R; dx++) {
          const idx = (j * R + dy) * W + (i * R + dx);
          heatF[idx] = heat;
          maskF[idx] = allowed ? 1 : 0;
        }
      }
    }
  }
  const blurPass = (src: Float32Array, w: number, h: number, radius: number, out: Float32Array) => {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let cnt = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += src[y * w + xx];
          cnt++;
        }
        tmp[y * w + x] = s / cnt;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0;
        let cnt = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          s += tmp[yy * w + x];
          cnt++;
        }
        out[y * w + x] = s / cnt;
      }
    }
  };
  const hm = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) hm[k] = heatF[k] * maskF[k];
  const hmB = new Float32Array(W * H);
  const maskB = new Float32Array(W * H);
  blurPass(hm, W, H, 2, hmB);
  blurPass(maskF, W, H, 2, maskB);
  blurPass(hmB, W, H, 2, hm);
  blurPass(maskB, W, H, 2, maskB);
  const heatB = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) heatB[k] = maskB[k] > 0.02 ? hm[k] / maskB[k] : 0;
  const img = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const idx = k * 4;
    if (maskF[k] <= 0) continue;
    const [r, g, b, a] = heatColor(Math.min(1, heatB[k]));
    img[idx] = r;
    img[idx + 1] = g;
    img[idx + 2] = b;
    img[idx + 3] = a;
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
  return { buf, cacheControl };
}

app.get("/api/tiles/habitat/:species/:z/:x/:y.png", async (req, res) => {
  const key = req.params.species;
  if (!SPECIES[key]) return res.status(404).json({ error: "Okänd art." });
  const lockedT = gateSpecies(req, [key]);
  if (lockedT.length > 0) return lockedResponse(res, lockedT);
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
  const { buf, cacheControl } = await renderHabitatTile([key], z, x, y, sens, asOf, staticOnly, dateParam, path.join("habitat", key));
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", cacheControl);
  res.send(buf);
});

// Multi-species composite tile: per-pixel MAX score across the checked species.
app.get("/api/tiles/multi/:z/:x/:y.png", async (req, res) => {
  const keys = String(req.query.species ?? "kantarell")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k])
    .slice(0, 6);
  if (keys.length === 0) return res.status(400).json({ error: "Okända arter i species=." });
  const lockedM = gateSpecies(req, keys);
  if (lockedM.length > 0) return lockedResponse(res, lockedM);
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
  const { buf, cacheControl } = await renderHabitatTile(
    keys, z, x, y, sens, asOf, staticOnly, dateParam, path.join("habitat-multi", keys.join("+")),
  );
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", cacheControl);
  res.send(buf);
});

app.get("/api/debug/cell", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const key = String(req.query.species ?? "kantarell");
  const lockedD = gateSpecies(req, [key]);
  if (lockedD.length > 0) return lockedResponse(res, lockedD);
  const species = SPECIES[key];
  if (!species || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Expected query params: lat, lon, species." });
  }
  const asOf = parseAsOf(String(req.query.date ?? ""));
  const staticOnly = req.query.static === "1";
  const store = await getLayerStore();
  const useMask = store.mask !== null;
  const [forestPolys, exclusions] = useMask
    ? [null, null]
    : await Promise.all([
        forestPolygonsForBox(lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2),
        exclusionsForBox(lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2),
      ]);
  const [e0, n0] = toSWEREF(lon, lat);
  const inForest = useMask
    ? store.mask!.has(e0, n0) && store.mask!.allows(e0, n0)
    : forestPolys !== null && pointInPolys(forestPolys, lon, lat);
  const ex = exclusions ?? { polys: [] as Poly[], lines: [] as [number, number][][] };
  const waterPolys = ex.water ?? [];
  const nearWater =
    waterPolys.length > 0 && (pointInPolys(waterPolys, lon, lat) || distToPolysMeters(waterPolys, lon, lat) < WATER_BUFFER_M);
  const excluded =
    nearWater ||
    (ex.polys.length > 0 && (pointInPolys(ex.polys, lon, lat) || distToPolysMeters(ex.polys, lon, lat) < EXCLUSION_BUFFER_M));
  const roadDist = ex.lines.length > 0 ? distToLinesMeters(ex.lines, lon, lat) : Infinity;
  const roadFactor = roadDist < ROAD_ZERO_M ? 0 : roadDist < ROAD_HALF_M ? 0.5 : 1;
  const forestEdge =
    inForest &&
    forestPolys !== null &&
    forestPolys.length > 0 &&
    (!pointInPolys(forestPolys, lon + 0.001, lat) ||
      !pointInPolys(forestPolys, lon - 0.001, lat) ||
      !pointInPolys(forestPolys, lon, lat + 0.001) ||
      !pointInPolys(forestPolys, lon, lat - 0.001));
  const [e, n] = [e0, n0];
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
  const coolNights = staticOnly ? null : await coolNightsLast7d(lat, lon, asOf);
  const flush = flushFactor(coolNights);
  const dynamic = staticOnly ? 1 : seasonalFactor(species, lat, asOf) * rainFactor * frost * flush;
  const prior = obsPrior(await getObsIndex(), key, lon, lat);
  res.json({
    species: key,
    lon,
    lat,
    obsPrior: Number(prior.toFixed(3)),
    forestKnown: useMask ? true : forestPolys !== null,
    maskUsed: useMask,
    forestPolys: forestPolys?.length ?? 0,
    inForest,
    excluded,
    nearWater,
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
    coolNights7d: coolNights,
    flush,
    score: Math.min(100, Math.round(100 * habitat * dynamic * (1 + 0.35 * prior))),
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
      const v = Math.max(0, Math.min(255, Math.round(128 + (shade - 128) * 1.7)));
      png.data[idx] = v;
      png.data[idx + 1] = v;
      png.data[idx + 2] = v;
      png.data[idx + 3] = 190;
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
  (async () => {
    try {
      const dir = path.join(here, "..", "data", "osm");
      const files = await fsp.readdir(dir);
      const forest = files.filter((f) => f.startsWith("forest_")).length;
      const excl = files.filter((f) => f.startsWith("exclusion_")).length;
      let forestRings = 0;
      let exclPolys = 0;
      for (const f of files.filter((f) => f.startsWith("forest_"))) {
        const j = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
        forestRings += Array.isArray(j) ? j.length : 0;
      }
      for (const f of files.filter((f) => f.startsWith("exclusion_"))) {
        const j = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
        exclPolys +=
          (Array.isArray(j?.polys) ? j.polys.length : 0) + (Array.isArray(j?.water) ? j.water.length : 0);
      }
      let nmdOk = false;
      try {
        const mf = JSON.parse(await fsp.readFile(path.join(here, "..", "data", "layers", "manifest.json"), "utf8")) as { mask?: { file?: string } };
        if (mf.mask?.file) await fsp.access(path.join(here, "..", "data", "layers", mf.mask.file));
        nmdOk = true;
      } catch { /* no nmd */ }
      if (forest === 0 || excl === 0 || forestRings === 0 || exclPolys === 0) {
        if (nmdOk) {
          console.log("NMD-mask hittad — OSM-mask behövs inte (bara om du vill ha vägar).");
        } else {
          console.error(
            `VARNING: OSM-mask saknas/tom och ingen NMD-mask (skog-filer: ${forest} med ${forestRings} polygoner, exkl-filer: ${excl} med ${exclPolys} polygoner) — karta blir tom tills du kör: npm run osm-cache -- <minLon> <minLat> <maxLon> <maxLat> eller lägger in data/layers/nmd_10m.tif`,
          );
        }
      } else {
        console.log(`OSM-mask: ${forest} skog-tiles (${forestRings} polygoner), ${excl} exkl-tiles (${exclPolys} polygoner)`);
      }
    } catch {
      console.error("VARNING: ingen data/osm-mapp — kör: npm run osm-cache -- <minLon> <minLat> <maxLon> <maxLat>");
    }
  })();
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
