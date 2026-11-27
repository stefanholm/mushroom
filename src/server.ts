import "dotenv/config";
import express from "express";
import compression from "compression";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { PNG } from "pngjs";
import { LayerStore, toSWEREF } from "./layers.js";
import { SPECIES, PACKS, REVIEW_REWARD_SPECIES, SVENSKA_KLASSIKER_SPECIES, FREE_SPECIES, SINGLE_PRICE_SEK, SOLO_ONLY_SPECIES, TOP_PICKS, MAX_REWARD_CLAIMS, MAX_REVIEW_CLAIMS, MAX_REFERRAL_CLAIMS, effectiveGdd5, hostFallback, isSpeciesUnlocked, isSpeciesPermanentlyOwned, isValidRewardClaim, isValidSingleClaim, seasonalFactor, staticHabitatScore } from "./habitat.js";
import { normalizeCode, checksumOk, loadCodes, saveCodes, appendLog, grantLabel, makeCode, validateGrant, LOG_FILE } from "./redeem.js";
import { reportSignal, leaderboard, myScore, nearbyFinds, allFinds, haversineKm, aliasFor, deleteDeviceData } from "./signals.js";
import { getCloudManifest, getCloudFrame } from "./clouds.js";
import { getRainManifest, getRainFrame, sampleRainForLive, rainGridsAvailable, warmRainGrids } from "./rain-history.js";
import { computeOptimalZone } from "./optimal-zone.js";

// Entitlements skickas som ?entitlements=pro,blandad-korg-6,reward:bjorksopp (csv).
// I produktion ska detta INTE litas på från klienten — validera App Store-kvittot server-side
// (App Store Server API / StoreKit 2) och sätt entitlements där. Här är det dev/test-läge.
// "reward:<id>" accepteras bara om arten finns i REVIEW_REWARD_SPECIES (server-validerad —
// topparter/exklusiva arter kan aldrig låsas upp via betyg/kommentar).
function resolveEntitlements(req: express.Request): Set<string> {
  // Acceptera både ?entitlements= och ?ents= (klienten skickar båda).
  const raw = String(req.query.entitlements ?? req.query.ents ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (let e of raw) {
    // StoreKit produkt-ID använder punkt (topspots.2026); backend internt kolon (topspots:2026) — normalisera.
    if (/^topspots\.\d{4}$/.test(e)) e = "topspots:" + e.slice("topspots.".length);
    if (e.startsWith("reward:")) {
      const id = e.slice(7);
      if (isValidRewardClaim(id)) out.add(e);
    } else if (e.startsWith("species:")) {
      const id = e.slice(8);
      if (isValidSingleClaim(id)) out.add(e);
    } else {
      out.add(e);
    }
  }
  return out;
}

function gateSpecies(req: express.Request, keys: string[]): string[] {
  const ents = resolveEntitlements(req);
  return keys.filter((k) => SPECIES[k] && !isSpeciesUnlocked(k, ents));
}

function lockedResponse(res: express.Response, locked: string[]) {
  return res.status(403).json({ error: "Låst innehåll — köp svamppack eller Pro i appen.", locked });
}

// --- Top-spot fraktion: free efter provperiod ser bara botten (1-frac) av topparna;
// de översta frac (default 30 %) försvinner. Med årskort (topspots:<år>/all/pro) kommer
// alla tillbaka och topp-frac får gold:true (glödande guld). Under provperiod (trial):
// alla pins, inget guld.
const FREE_HIDE_FRACTION = Math.max(0, Math.min(0.95, Number(process.env.FREE_HIDE_FRACTION ?? 0.3) || 0.3));
const TOP_SPOTS_PRICE_SEK = Math.max(0, Number(process.env.TOP_SPOTS_PRICE_SEK ?? 249) || 249);
const PASS_YEAR = new Date().getFullYear();
const PASS_ID = `topspots:${PASS_YEAR}`; // årskort för innevarande år; "topspots" (alla år) funkar också
function canSeeTopSpots(req: express.Request): boolean {
  const ents = resolveEntitlements(req);
  return ents.has("pro") || ents.has("topspots") || ents.has(PASS_ID);
}
// Provperiod: klient skickar ?trial=1 (i prod: från StoreKit/App Store Server API is_trial_period).
// Under trial: alla pins, INGET guld. Efter trial utan årskort: topparna över cap försvinner helt.
function isTrial(req: express.Request): boolean {
  return String(req.query.trial ?? "") === "1" || resolveEntitlements(req).has("trial");
}
function capMeta(req: express.Request) {
  const paid = canSeeTopSpots(req);
  const trial = isTrial(req);
  return {
    capped: !paid && !trial, // free efter provperiod: topp-fraktionen försvinner
    trial,
    topHiddenFraction: FREE_HIDE_FRACTION,
    passId: PASS_ID,
    passLabel: `Årskort ${PASS_YEAR}`,
    passPriceSek: TOP_SPOTS_PRICE_SEK,
    unlocked: paid, // gold visas BARA för betalande, aldrig under trial
  };
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
app.use(express.json({ limit: "256kb" })); // API:t behöver små bodies; tiles/filer är GET
// Gzip för JSON-svar (hotspots/overview/bootstrap) — stora vinster på mobilnät.
// PNG-tiles (image/png) är inte "compressible" och hoppas över automatiskt.
app.use(compression({ threshold: 1024 }));

// Grundläggande säkerhetsheaders (i prod ännu striktare via Cloudflare Workers).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  );
  next();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const noCache = { etag: false, lastModified: false, setHeaders: (res: express.Response) => res.setHeader("Cache-Control", "no-cache") };
app.use(express.static(path.join(here, "..", "public"), noCache));

// HTTP-cache för GET-API:er så iOS URLCache/HTTP-cache inte frågar igen vid varje pan.
// URL:en innehåller alltid species/bbox/lat/lon/ents/date, så olika anrop cachen separat.
app.use((req, res, next) => {
  if (req.method === "GET" && req.path.startsWith("/api/")) {
    if (req.path === "/api/debug/cell" || req.path === "/api/chat") {
      res.setHeader("Cache-Control", "no-cache");
    } else if (req.path === "/api/shop") {
      res.setHeader("Cache-Control", "public, max-age=300");
    } else if (req.path === "/api/hillshade") {
      res.setHeader("Cache-Control", "public, max-age=3600"); // terräng är statisk
    } else {
      res.setHeader("Cache-Control", "public, max-age=60"); // meta/hotspots/peaks/unlocked
    }
  }
  next();
});
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

// Enkel per-IP rate limit för dyra/tunga endpoints (chat kostar Mistral-anrop, debug/cells är tungt).
const heavyAttempts = new Map<string, number[]>();
function heavyRateLimited(req: express.Request, maxPer10min: number): boolean {
  const now = Date.now();
  const key = (req.ip ?? "x") + "|" + req.path;
  const arr = (heavyAttempts.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  heavyAttempts.set(key, arr);
  if (arr.length >= maxPer10min) return true;
  arr.push(now);
  return false;
}

app.post("/api/chat", async (req, res) => {
  if (heavyRateLimited(req, 20)) return res.status(429).json({ error: "För många frågor — vänta en stund." });
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

const rainCache = new Map<string, { at: number; values: { to: number; value: string }[] }>();

async function rainValues(lat: number, lon: number): Promise<{ to: number; value: string }[]> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const cached = rainCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.values;
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
  rainCache.set(key, { at: Date.now(), values });
  return values;
}

function sumRain(values: { to: number; value: string }[], asOf: Date, days: number): number | null {
  const end = asOf.getTime();
  const cutoff = end - days * 86400_000;
  const inWindow = values.filter((v) => v.to >= cutoff && v.to <= end);
  return inWindow.length === 0 ? null : inWindow.reduce((sum, v) => sum + Number(v.value), 0);
}

async function rainLast14Days(lat: number, lon: number, asOf: Date): Promise<number | null> {
  return sumRain(await rainValues(lat, lon), asOf, 14);
}

async function rainLastNDays(lat: number, lon: number, asOf: Date, days: number): Promise<number | null> {
  return sumRain(await rainValues(lat, lon), asOf, days);
}

const TEMP_PARAMETER = "1";
const tempCache = new Map<string, { at: number; min48: number | null }>();

async function minTempLast48h(lat: number, lon: number, asOf: Date): Promise<number | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${asOf.toISOString().slice(0, 10)}`;
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
    const end = asOf.getTime();
    const cutoff = end - 48 * 3600 * 1000;
    const recent = values.filter((v) => v.to >= cutoff && v.to <= end).map((v) => Number(v.value));
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
// Samma observationer men med datum (för "färska fynd" i nearbyActivity): art -> [{lon, lat, date}]
type ObsDated = Map<string, { lon: number; lat: number; date: number }[]>;
let obsDatedCache: ObsDated | null = null;
async function getObsIndex(): Promise<ObsIndex> {
  if (obsIndexCache) return obsIndexCache;
  const idx: ObsIndex = new Map();
  try {
    const p = path.join(here, "..", "data", "validation", "observations.geojson");
    if (fs.existsSync(p)) {
      const j = JSON.parse(await fsp.readFile(p, "utf8"));
      const dated: ObsDated = new Map();
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
        const ev = f.properties?.eventDate;
        const t = typeof ev === "string" ? Date.parse(ev) : NaN;
        if (Number.isFinite(t)) {
          let d = dated.get(sp);
          if (!d) {
            d = [];
            dated.set(sp, d);
          }
          d.push({ lon, lat, date: t });
        }
      }
      obsDatedCache = dated;
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
        if (d > 1200) continue;
        const v = Math.exp(-((d / 400) ** 2));
        if (v > best) best = v;
      }
    }
  }
  return best;
}

// --- Anonyma fynd + topplista + nearbyActivity (persistent SQLite, se src/signals.ts) ---

async function getObsDated(): Promise<Map<string, { lon: number; lat: number; date: number }[]>> {
  await getObsIndex();
  return obsDatedCache ?? new Map();
}

// --- Progressiv geografi för nearbyActivity ---
// local (30 km) -> area (region, t.ex. Mälardalen) -> part_of_sweden (Södra/Mellersta/Norra) -> sweden.
// 30 km-lokal nivå garanterar att inga exakta positioner röjs (fynd är bara 0.05° celler, svar
// innehåller aldrig koordinater).
const NEARBY_RADIUS_KM = 30;
const SCOPE_RANK: Record<string, number> = { local: 0, area: 1, part_of_sweden: 2, sweden: 3 };

function regionName(lat: number, lon: number): string {
  if (lat < 56.3) return "Skåne";
  if (lat < 57.6 && lon < 13.6) return "Sydöstra Götaland";
  if (lon < 14.9 && lat >= 56.4 && lat < 59.9) return "Västkusten";
  if (lon >= 15 && lon <= 19.6 && lat >= 58.3 && lat < 60.7) return "Mälardalen";
  if (lon >= 17.4 && lon <= 20.6 && lat >= 55.8 && lat < 58.4) return "Östra Götaland";
  if (lat < 60.5) return "Götaland";
  if (lat < 64.5) return "Svealand";
  return "Norrland";
}
function partOfSweden(lat: number): string {
  if (lat < 60.5) return "Södra Sverige";
  if (lat < 64.5) return "Mellersta Sverige";
  return "Norra Sverige";
}
function scopeOf(findLat: number, findLon: number, userLat: number, userLon: number): { scope: string; scopeLabel: string } {
  if (haversineKm(userLat, userLon, findLat, findLon) <= NEARBY_RADIUS_KM) return { scope: "local", scopeLabel: "Ditt närområde" };
  const region = regionName(userLat, userLon);
  if (regionName(findLat, findLon) === region) return { scope: "area", scopeLabel: region };
  const part = partOfSweden(userLat);
  if (partOfSweden(findLat) === part) return { scope: "part_of_sweden", scopeLabel: part };
  return { scope: "sweden", scopeLabel: "Hela Sverige" };
}

type FindRow = { species: string; at: number; lat: number; lon: number; source: "member" | "artportalen" };

// Kombinerad områdessignal med progressiv geografisk fallback: local 30 km, area, landsdel, hela
// Sverige. Medlemsfynd senaste `days` d + Artportalen senaste 30 d (hela katalogen). Arter måste
// vara i säsong och ha bra lokalt habitat. Nivåstyrd: free döljer arter; endast årskort får feed48h.
async function buildNearbyActivity(
  lat: number,
  lon: number,
  req: express.Request,
  cm: { capped: boolean; trial: boolean; unlocked: boolean },
  opts: { days?: number; feed48h?: boolean } = {},
) {
  const ents = resolveEntitlements(req);
  const now = Date.now();
  const days = opts.days ?? 14;
  const since = now - days * 86400000;
  // Alla fynd inom tidsfönstret (medlem) + Artportalen (30 d), med scope per fynd.
  const memberAll = allFinds(since);
  const dated = await getObsDated();
  const rows: FindRow[] = memberAll.map((f) => ({
    species: f.species,
    at: f.at,
    lat: f.cellLat + 0.025,
    lon: f.cellLon + 0.025,
    source: "member" as const,
  }));
  for (const [sp, arr] of dated) {
    for (const o of arr) {
      if (o.date >= now - 30 * 86400000) rows.push({ species: sp, at: o.date, lat: o.lat, lon: o.lon, source: "artportalen" as const });
    }
  }
  // Välj minsta scope som ger >= 3 fynd (annars bredaste som har något, annars local).
  const scopeCounts: Record<string, number> = { local: 0, area: 0, part_of_sweden: 0, sweden: 0 };
  for (const r of rows) scopeCounts[scopeOf(r.lat, r.lon, lat, lon).scope]++;
  let chosen: string = "sweden";
  for (const s of ["local", "area", "part_of_sweden", "sweden"]) {
    if (scopeCounts[s] >= 3) { chosen = s; break; }
  }
  if (scopeCounts[chosen] === 0) {
    for (const s of ["local", "area", "part_of_sweden", "sweden"]) if (scopeCounts[s] > 0) { chosen = s; break; }
  }
  const chosenRank = SCOPE_RANK[chosen];
  const inScope = rows.filter((r) => SCOPE_RANK[scopeOf(r.lat, r.lon, lat, lon).scope] <= chosenRank);
  const chosenLabel =
    chosen === "local" ? "Ditt närområde" : chosen === "area" ? regionName(lat, lon) : chosen === "part_of_sweden" ? partOfSweden(lat) : "Hela Sverige";

  // Gruppera per art.
  const bySp = new Map<string, { count: number; sources: Set<string>; latest: number; latestArt: number; scope: string; scopeLabel: string }>();
  for (const r of inScope) {
    const sc = scopeOf(r.lat, r.lon, lat, lon);
    const g = bySp.get(r.species) ?? { count: 0, sources: new Set<string>(), latest: 0, latestArt: 0, scope: sc.scope, scopeLabel: sc.scopeLabel };
    g.count++;
    g.sources.add(r.source);
    g.latest = Math.max(g.latest, r.at);
    if (r.source === "artportalen") g.latestArt = Math.max(g.latestArt, r.at);
    // behåll tajtaste scope för arten
    if (SCOPE_RANK[sc.scope] < SCOPE_RANK[g.scope]) {
      g.scope = sc.scope;
      g.scopeLabel = sc.scopeLabel;
    }
    bySp.set(r.species, g);
  }
  const store = await getLayerStore();
  const nowDate = new Date(now);
  const [e0, n0] = toSWEREF(lon, lat);
  const maskOk = store.mask ? store.mask.has(e0, n0) && store.mask.allows(e0, n0) : true;
  function habOf(sp: string): number {
    return staticHabitatScore(store, sp, lon, lat, { forestOk: maskOk, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false });
  }
  function highlight(sp: string, g: { count: number; sources: Set<string>; latest: number; latestArt: number; scope: string; scopeLabel: string } | null, hab: number) {
    const s = SPECIES[sp];
    if (!s) return null;
    if (seasonalFactor(s, lat, nowDate) <= 0) return null;
    if (hab < 0.6) return null;
    const unlocked = isSpeciesUnlocked(sp, ents);
    let summary: string | null = null;
    if (g) {
      if (g.latestArt > 0 && now - g.latestArt <= 36 * 3600000) summary = `Gårdagens toppfynd i ${g.scopeLabel.toLowerCase()}`;
      else if (g.latestArt > 0) summary = `Nya fynd i ${g.scopeLabel.toLowerCase()} (Artportalen)`;
      else summary = `Nya medlemsfynd i ${g.scopeLabel.toLowerCase()}`;
    } else {
      summary = `Bra habitat i ${chosenLabel.toLowerCase()} — låst art`;
    }
    return {
      species: sp,
      kind: unlocked ? "report" : "upsell",
      findCount: g?.count ?? 0,
      sources: g ? [...g.sources] : [],
      scope: g?.scope ?? chosen,
      scopeLabel: g?.scopeLabel ?? chosenLabel,
      habitatScore: Math.round(hab * 100),
      isUnlocked: unlocked,
      packId: s.pack ?? null,
      summary,
      timestamp: g && g.latest > 0 ? new Date(g.latest).toISOString() : null,
    };
  }
  const highlights: NonNullable<ReturnType<typeof highlight>>[] = [];
  for (const [sp, g] of bySp) {
    const h = highlight(sp, g, habOf(sp));
    if (h) highlights.push(h);
  }
  highlights.sort(
    (a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "") || b.findCount - a.findCount || b.habitatScore - a.habitatScore,
  );
  const top = highlights.slice(0, 8);
  const total = inScope.length;
  const tierMode = cm.trial ? "trial" : cm.unlocked ? "annual" : "free";
  const full = tierMode !== "free";
  let ctaType = "none";
  if (tierMode === "free") ctaType = "upgrade_annual_pass";
  else if (tierMode === "trial") ctaType = "trial_upsell";
  else if (top.some((h) => !h.isUnlocked)) ctaType = "buy_species_or_pack";
  const sources = [...new Set(inScope.map((r) => r.source))];

  // feed48h: bara årskort. Senaste 48 h från båda källor + köprekommendationer för låsta arter
  // i säsong med riktigt bra habitat (även utan fynd).
  let feed48h: typeof highlights = [];
  if (tierMode === "annual" || opts.feed48h) {
    const since48 = now - 48 * 3600000;
    const rows48 = rows.filter((r) => r.at >= since48);
    const bySp48 = new Map<string, { count: number; sources: Set<string>; latest: number; latestArt: number; scope: string; scopeLabel: string }>();
    for (const r of rows48) {
      const sc = scopeOf(r.lat, r.lon, lat, lon);
      const g = bySp48.get(r.species) ?? { count: 0, sources: new Set<string>(), latest: 0, latestArt: 0, scope: sc.scope, scopeLabel: sc.scopeLabel };
      g.count++;
      g.sources.add(r.source);
      g.latest = Math.max(g.latest, r.at);
      if (r.source === "artportalen") g.latestArt = Math.max(g.latestArt, r.at);
      if (SCOPE_RANK[sc.scope] < SCOPE_RANK[g.scope]) {
        g.scope = sc.scope;
        g.scopeLabel = sc.scopeLabel;
      }
      bySp48.set(r.species, g);
    }
    const feed: NonNullable<ReturnType<typeof highlight>>[] = [];
    for (const [sp, g] of bySp48) {
      const h = highlight(sp, g, habOf(sp));
      if (h) feed.push(h);
    }
    // låsta arter i säsong med starkt habitat blir köprekommendationer även utan fynd
    for (const sp of Object.keys(SPECIES)) {
      if (bySp48.has(sp)) continue;
      const s = SPECIES[sp];
      if (!s.pack || isSpeciesUnlocked(sp, ents)) continue;
      if (seasonalFactor(s, lat, nowDate) <= 0) continue;
      const hab = habOf(sp);
      if (hab < 0.8) continue;
      const h = highlight(sp, null, hab);
      if (h) feed.push(h);
    }
    feed.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "") || b.findCount - a.findCount || b.habitatScore - a.habitatScore);
    feed48h = feed.slice(0, 10);
  }

  return {
    hasRecentFinds: total > 0,
    totalRecentFinds: total,
    scope: chosen,
    scopeLabel: chosenLabel,
    radiusKm: NEARBY_RADIUS_KM,
    sources,
    tierMode,
    ctaType,
    // free efter provperiod: dölj vilka arter — bara att fynd gjorts i området
    highlights: full ? top : [],
    feed48h: tierMode === "annual" ? feed48h : [],
  };
}

app.post("/api/report-signal", async (req, res) => {
  if (heavyRateLimited(req, 30)) return res.status(429).json({ error: "För många fynd — vänta en stund." });
  const device = String(req.body?.device ?? req.body?.gridDevice ?? "");
  const species = String(req.body?.species ?? "");
  // bakåtkompat: äldre klienter skickar gridLat/gridLon
  const lat = Number(req.body?.lat ?? req.body?.gridLat);
  const lon = Number(req.body?.lon ?? req.body?.gridLon);
  if (!device) return res.status(400).json({ error: "device krävs" });
  if (!SPECIES[species]) return res.status(400).json({ error: "Okänd art." });
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat/lon krävs" });
  const store = await getLayerStore();
  const [e, n] = toSWEREF(lon, lat);
  const maskOk = store.mask ? store.mask.has(e, n) && store.mask.allows(e, n) : true;
  const hab = staticHabitatScore(store, species, lon, lat, {
    forestOk: maskOk,
    inClearcut: false,
    excluded: false,
    roadFactor: 1,
    forestEdge: false,
  });
  const sf = seasonalFactor(SPECIES[species], lat, new Date());
  const result = reportSignal({ device, species, lat, lon, habitatScore: hab, seasonFactor: sf });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // bakåtkompat: recentAreaReports = antal fynd samma art+cell senaste 14 d (inkl. detta)
  const recentAreaReports = nearbyFinds(result.cellLat + 0.025, result.cellLon + 0.025, 3, Date.now() - 14 * 86400000)
    .filter((f) => f.species === species).length;
  res.json({ ...result, recentAreaReports });
});

app.get("/api/leaderboard", (req, res) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 5) || 5));
  res.json({ days, leaderboard: leaderboard(days, 10) });
});

app.get("/api/leaderboard/score", (req, res) => {
  const device = String(req.query.device ?? "");
  if (!device) return res.status(400).json({ error: "device krävs" });
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 5) || 5));
  res.json({ days, alias: aliasFor(device), ...myScore(device, days) });
});

// --- GDPR / App Store 5.1.1(v): radera ALL enhetsdata (idempotent — alltid 200 om device giltig) ---
// Raderar från signals.db (fynd/poäng/alias/restids-meta), referrals.json (codes/redeemedBy/
// earnedBy/rewardClaims), redeem-codes.json (usedBy) och redeem-log.json. Aggregerade fynd från
// andra enheter ligger kvar (de är redan anonyma 0.05°-celler utan GPS).
app.delete("/api/privacy/delete", (req, res) => {
  if (heavyRateLimited(req, 10)) return res.status(429).json({ ok: false, deleted: false, error: "För många anrop — vänta en stund." });
  const device = String(req.query.device ?? "").trim();
  if (!device || device.length > 128) {
    return res.status(400).json({ ok: false, deleted: false, error: "device krävs (icke-tom sträng)" });
  }
  const dbCounts = deleteDeviceData(device);
  // referrals.json
  const st = loadReferrals();
  delete st.redeemedBy[device];
  delete st.earnedBy[device];
  delete st.rewardClaims[device];
  for (const c of Object.values(st.codes)) {
    if (c.owner === device) c.owner = "[raderad]";
    if (c.usedBy === device) c.usedBy = null;
  }
  saveReferrals(st);
  // redeem-codes.json: ta bort device från usedBy-listor
  const codes = loadCodes();
  let codesChanged = false;
  for (const c of Object.values(codes)) {
    if (c.redeemedBy?.includes(device)) {
      c.redeemedBy = c.redeemedBy.filter((d) => d !== device);
      codesChanged = true;
    }
  }
  if (codesChanged) saveCodes(codes);
  // redeem-log.json (JSONL): skriv om utan rader för device
  let logRemoved = 0;
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const kept = lines.filter((l) => {
      try {
        return JSON.parse(l).device !== device;
      } catch {
        return true;
      }
    });
    logRemoved = lines.length - kept.length;
    if (logRemoved > 0) fs.writeFileSync(LOG_FILE, kept.length > 0 ? kept.join("\n") + "\n" : "");
  } catch {}
  res.json({ ok: true, deleted: true, details: { ...dbCounts, logRemoved } });
});

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
  let rain30: number | null = null;
  let rain90: number | null = null;
  try {
    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;
    // Vid utzoomade bboxes (> 0.15°): sampla 5 punkter parallellt (centrum + 4 kvadranter)
    if (latSpan > 0.15 || lonSpan > 0.15) {
      const qLat = latSpan * 0.25;
      const qLon = lonSpan * 0.25;
      const pts: Array<[number, number]> = [
        [centerLat, centerLon],
        [centerLat - qLat, centerLon - qLon],
        [centerLat - qLat, centerLon + qLon],
        [centerLat + qLat, centerLon - qLon],
        [centerLat + qLat, centerLon + qLon],
      ];
      const settled = await Promise.allSettled(pts.map(([la, lo]) => rainValues(la, lo)));
      const ok = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rainValues>>> => r.status === "fulfilled")
        .map((r) => r.value);
      if (ok.length > 0) {
        const avg = (days: number): number | null => {
          const nums = ok.map((v) => sumRain(v, asOf, days)).filter((n): n is number => n !== null);
          return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        };
        rain14 = avg(14);
        rain30 = avg(30);
        rain90 = avg(90);
      }
    } else {
      const vals = await rainValues(centerLat, centerLon);
      rain14 = sumRain(vals, asOf, 14);
      rain30 = sumRain(vals, asOf, 30);
      rain90 = sumRain(vals, asOf, 90);
    }
  } catch (err) {
    console.error("SMHI fetch failed:", err);
  }
  // Kort regn driver fruktning nu; långsiktigt regn (90 d) laddar markfukten före det.
  // Mättande kurvor (deep-dive): 1-exp(-r/32) för 14 d (halvering ~22 mm) och
  // 0.75+0.25*(1-exp(-r/120)) för 90 d — linjära ramper gav oproportionerligt utslag vid skyfall.
  const rainFactor =
    (rain14 === null ? 0.5 : 1 - Math.exp(-rain14 / 32)) *
    (rain90 === null ? 1 : 0.75 + 0.25 * (1 - Math.exp(-rain90 / 120)));
  // Live-läge: regnfaktor per cell från det förinterpolerade ackumulerade regn-rutnätet
  // (samma källa som regnkartan) när rolling-42d.json är laddad; annars punkt-SMHI-fallback.
  const rainWin = species.rainWindowDays ?? 28;
  const gridsAvail = rainGridsAvailable();
  let minTemp: number | null = null;
  let frost = 1;
  let coolNights: number | null = null;
  let flush = 1;
  if (!staticOnly) {
    [minTemp, coolNights] = await Promise.all([
      minTempLast48h(centerLat, centerLon, asOf),
      coolNightsLast7d(centerLat, centerLon, asOf),
    ]);
    if (species.frostSensitive && minTemp !== null && minTemp <= -3) frost = 0;
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
    let cellCount = 0;
    for (let lon = startLon; lon < maxLon; lon += cell) {
      // Släpp igenom event-loopen regelbundet så /api/meta m.m. inte tajmar ut medan tiles körs
      if (++cellCount % 96 === 0) await new Promise((r) => setImmediate(r));
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
      const dynRain = !staticOnly && gridsAvail ? sampleRainForLive(clat, clon, rainWin).factor : rainFactor;
      const dynamic = staticOnly ? 1 : seasonalFactor(species, clat, asOf) * dynRain * frost * flush;
      let prior = obsPrior(await getObsIndex(), key, clon, clat);
      if (species.protected) prior = 0;
      const score = Math.min(100, Math.round(100 * habitat * dynamic * (1 + 0.15 * prior)));
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
      rainWindowDays: rainWin,
      rainGrids: gridsAvail,
      asOf: asOf.toISOString().slice(0, 10),
      forestAreas: forestPolys?.length ?? 0,
      forestKnown: useMask ? true : forestPolys !== null,
      maskUsed: useMask,
      excludedAreas: ex.polys.length,
      layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
      layersTooBig: [...store.rasters.values()].filter((r) => r.tooBig).map((r) => r.id),
    },
  };
}

// In-memory-cache för computeCells: samma bbox+art+datum begärs ofta flera gånger
// vid pan/zoom — cachen dedupar även pågående anrop (samma Promise) och kortar svarstiden.
const cellsCache = new Map<string, { at: number; value: Promise<{ cells: CellScore[]; meta: Record<string, unknown> }> }>();
const CELLS_CACHE_MAX = 64;
const CELLS_CACHE_TTL_MS = 10 * 60 * 1000;
async function computeCellsCached(
  key: string,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  cell: number,
  asOf: Date,
  staticOnly: boolean,
): Promise<{ cells: CellScore[]; meta: Record<string, unknown> }> {
  const ck = [key, minLon.toFixed(5), minLat.toFixed(5), maxLon.toFixed(5), maxLat.toFixed(5), cell, asOf.toISOString(), staticOnly ? 1 : 0].join("|");
  const hit = cellsCache.get(ck);
  if (hit && Date.now() - hit.at < CELLS_CACHE_TTL_MS) return hit.value;
  const p = computeCells(key, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly);
  p.catch(() => cellsCache.delete(ck)); // cacha inte misslyckade beräkningar
  cellsCache.set(ck, { at: Date.now(), value: p });
  if (cellsCache.size > CELLS_CACHE_MAX) {
    const first = cellsCache.keys().next().value;
    if (first !== undefined) cellsCache.delete(first);
  }
  return p;
}

// ---------- Nationell overview (Tier 1) ----------
// Bakad av scripts/bake-overview.mjs: data/overview/<art>.json (2 km-celler, max+p95)
// + data/overview/species-pyramid-profile.json. Används för Sverige-vy (span > MACRO_SPAN)
// och av /api/v1/fungi/overview. Live-läge viktar cellerna med säsong × regn × frost × flush
// på ett grovt 1°-rutnät (SMHI cachas 6 h per 0.1°) så topparna flyttas mellan landsdelar.
const OVERVIEW_DIR = path.join(here, "..", "data", "overview");
const SWEDEN_BBOX = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const MACRO_SPAN = 1.5; // ° — större bbox än så går via overview-JSON istället för rasterceller
const MAXP_MACRO = 180; // pin-budget i makroläge (rättvist fördelad per art, se nedan)

type OverviewCell = { e: number; n: number; lon: number; lat: number; max: number; p95: number };
type OverviewFile = {
  species: string; tier: number; cellM: number; minScore: number;
  generatedAt: string; count: number; truncated?: boolean; cells: OverviewCell[];
};
type PyramidProfile = {
  nationalCells: Record<string, number>;
  topScore: number; p95Score: number; rarityWeight: number; updatedAt: string;
};

const overviewFileCache = new Map<string, { mtimeMs: number; data: OverviewFile | null }>();
async function readOverviewFile(sp: string): Promise<OverviewFile | null> {
  const p = path.join(OVERVIEW_DIR, `${sp}.json`);
  try {
    const st = await fsp.stat(p);
    const c = overviewFileCache.get(sp);
    if (c && c.mtimeMs === st.mtimeMs) return c.data;
    const data = JSON.parse(await fsp.readFile(p, "utf8")) as OverviewFile;
    overviewFileCache.set(sp, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    overviewFileCache.set(sp, { mtimeMs: -1, data: null });
    return null;
  }
}

let profileCache: { mtimeMs: number; data: { generatedAt: string; profiles: Record<string, PyramidProfile> } | null } = {
  mtimeMs: -1,
  data: null,
};
async function readPyramidProfile(): Promise<{ generatedAt: string; profiles: Record<string, PyramidProfile> } | null> {
  const p = path.join(OVERVIEW_DIR, "species-pyramid-profile.json");
  try {
    const st = await fsp.stat(p);
    if (profileCache.mtimeMs === st.mtimeMs) return profileCache.data;
    const data = JSON.parse(await fsp.readFile(p, "utf8")) as { generatedAt: string; profiles: Record<string, PyramidProfile> };
    profileCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

function defaultProfile(sp: string, ov: OverviewFile | null): PyramidProfile {
  const cells = ov?.cells ?? [];
  const nationalCells: Record<string, number> = {};
  for (const size of [140000, 55000, 18000, 6000, 2000]) {
    nationalCells[`${size / 1000}km`] = new Set(cells.map((c) => `${Math.floor(c.e / size)},${Math.floor(c.n / size)}`)).size;
  }
  const maxes = cells.map((c) => c.max);
  return {
    nationalCells,
    topScore: maxes.length ? Number(Math.max(...maxes).toFixed(1)) : 0,
    p95Score: maxes.length ? Number(maxes.slice().sort((a, b) => a - b)[Math.floor(0.95 * (maxes.length - 1))].toFixed(1)) : 0,
    rarityWeight: 1,
    updatedAt: ov?.generatedAt ?? new Date().toISOString(),
  };
}

// Live-faktor på 1°-rutnät (SMHI-värden cachas i rainValues/tempCache per 0.1°, 6 h).
const liveGridCache = new Map<
  string,
  { at: number; rain14: number | null; rain90: number | null; minT: number | null; cool: number | null }
>();
async function liveGridAt(lat: number, lon: number, asOf: Date) {
  const key = `${Math.round(lat)}:${Math.round(lon)}:${asOf.toISOString().slice(0, 10)}`;
  const c = liveGridCache.get(key);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c;
  const [rv, minT, cool] = await Promise.allSettled([
    rainValues(lat, lon),
    minTempLast48h(lat, lon, asOf),
    coolNightsLast7d(lat, lon, asOf),
  ]);
  const entry = {
    at: Date.now(),
    rain14: rv.status === "fulfilled" ? sumRain(rv.value, asOf, 14) : null,
    rain90: rv.status === "fulfilled" ? sumRain(rv.value, asOf, 90) : null,
    minT: minT.status === "fulfilled" ? minT.value : null,
    cool: cool.status === "fulfilled" ? cool.value : null,
  };
  liveGridCache.set(key, entry);
  return entry;
}

async function overviewLiveFactor(speciesKey: string, lat: number, lon: number, asOf: Date): Promise<number> {
  const s = SPECIES[speciesKey];
  if (!s) return 0;
  const season = seasonalFactor(s, lat, asOf);
  if (season <= 0) return 0;
  const g = await liveGridAt(lat, lon, asOf);
  // samma ackumulerade regn-rutnät som regnkartan när det finns — annars punkt-SMHI
  const lr = sampleRainForLive(lat, lon, s.rainWindowDays ?? 28);
  const rainFactor = lr.available
    ? lr.factor
    : (g.rain14 === null ? 0.5 : 1 - Math.exp(-g.rain14 / 32)) *
      (g.rain90 === null ? 1 : 0.75 + 0.25 * (1 - Math.exp(-g.rain90 / 120)));
  let frost = 1;
  if (s.frostSensitive && g.minT !== null && g.minT <= -3) frost = 0;
  return season * rainFactor * frost * flushFactor(g.cool);
}

// Lättviktig makro-fallback när data/overview/<art>.json saknas: grov raster-sampling
// (1°) över Sverige där masken tillåter + obsPrior för icke-skyddade arter.
async function macroFallbackCells(
  sp: string,
  minScore: number,
  asOf: Date,
  staticOnly: boolean,
): Promise<OverviewCell[]> {
  const store = await getLayerStore();
  const out: OverviewCell[] = [];
  const step = 1.0;
  for (let lat = SWEDEN_BBOX.minLat; lat < SWEDEN_BBOX.maxLat; lat += step) {
    for (let lon = SWEDEN_BBOX.minLon; lon < SWEDEN_BBOX.maxLon; lon += step) {
      const clat = lat + step / 2;
      const clon = lon + step / 2;
      const [e, n] = toSWEREF(clon, clat);
      if (store.mask && !(store.mask.has(e, n) && store.mask.allows(e, n))) continue;
      const habitat = staticHabitatScore(store, sp, clon, clat, {
        forestOk: true, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false,
      });
      let score = Math.min(100, habitat * 100);
      if (!staticOnly) score = Math.min(100, score * (await overviewLiveFactor(sp, clat, clon, asOf)));
      const prior = SPECIES[sp].protected ? 0 : obsPrior(await getObsIndex(), sp, clon, clat);
      score = Math.min(100, Math.round(score * (1 + 0.15 * prior)));
      if (score >= minScore) {
        out.push({ e: Math.round(e), n: Math.round(n), lon: Number(clon.toFixed(5)), lat: Number(clat.toFixed(5)), max: score, p95: score });
      }
    }
  }
  return out.slice(0, 400);
}

async function overviewCellsForSpecies(
  sp: string,
  minScore: number,
  asOf: Date,
  staticOnly: boolean,
): Promise<OverviewCell[]> {
  const ov = await readOverviewFile(sp);
  return ov ? ov.cells : macroFallbackCells(sp, minScore, asOf, staticOnly);
}

// Makro-pins för /api/hotspots vid stor span: overview-celler inom bbox, live-viktade
// när static != "1", filtrerade på minScore, sorterade på score.
async function overviewPeaksForSpecies(
  sp: string,
  minLon: number, minLat: number, maxLon: number, maxLat: number,
  minScore: number,
  asOf: Date,
  staticOnly: boolean,
): Promise<{ lon: number; lat: number; score: number; species: string }[]> {
  const cells = await overviewCellsForSpecies(sp, minScore, asOf, staticOnly);
  const out: { lon: number; lat: number; score: number; species: string }[] = [];
  for (const c of cells) {
    if (c.lon < minLon || c.lon > maxLon || c.lat < minLat || c.lat > maxLat) continue;
    let score = c.max;
    if (!staticOnly) score = Math.min(100, Math.round(c.max * (await overviewLiveFactor(sp, c.lat, c.lon, asOf))));
    if (score < minScore) continue;
    out.push({ lon: c.lon, lat: c.lat, score, species: sp });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Gold/cap med per-art-garanti: när free är capped döljs topp-fraktionen, men varje art
// hålls alltid representerad med minst 1 synlig pin (ovanliga arter klipps aldrig bort helt).
function applyGoldCap<T extends { score: number; species: string }>(
  picked: T[],
  cm: ReturnType<typeof capMeta>,
): { visible: T[]; goldSet: Set<T>; goldN: number } {
  picked.sort((a, b) => b.score - a.score);
  const goldN = picked.length > 0 ? Math.max(1, Math.round(picked.length * FREE_HIDE_FRACTION)) : 0;
  const goldSet = new Set(picked.slice(0, goldN));
  let visible = cm.capped ? picked.slice(goldN) : picked;
  if (cm.capped) {
    const visSp = new Set(visible.map((p) => p.species));
    for (const p of picked) {
      if (goldSet.has(p) && !visSp.has(p.species)) {
        goldSet.delete(p);
        visible.push(p);
        visSp.add(p.species);
      }
    }
    visible.sort((a, b) => b.score - a.score);
  }
  return { visible, goldSet, goldN };
}

async function macroHotspotsResponse(
  req: express.Request,
  res: express.Response,
  keys: string[],
  minLon: number, minLat: number, maxLon: number, maxLat: number,
  minScore: number,
  asOf: Date,
  staticOnly: boolean,
) {
  // Rättvis budget: reservera floor(MAXP/keys) per art, fyll resten globalt på score —
  // en vanlig art får alltså inte svälta ut en ovanlig redan i serverns JSON.
  const quota = Math.floor(MAXP_MACRO / Math.max(1, keys.length));
  const perSpecies = await Promise.all(
    keys.map((k) => overviewPeaksForSpecies(k, minLon, minLat, maxLon, maxLat, minScore, asOf, staticOnly)),
  );
  const picked: { lon: number; lat: number; score: number; species: string }[] = [];
  const rest: typeof picked = [];
  for (const list of perSpecies) {
    picked.push(...list.slice(0, quota));
    rest.push(...list.slice(quota));
  }
  rest.sort((a, b) => b.score - a.score);
  while (picked.length < MAXP_MACRO && rest.length > 0) picked.push(rest.shift()!);

  const cm = capMeta(req);
  const centerLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111000;
  const mPerDegLon = 111000 * Math.cos((centerLat * Math.PI) / 180);
  const spacingDeg = 120 / Math.max(mPerDegLat, mPerDegLon);
  const thinned: typeof picked = [];
  for (const p of picked) {
    if (thinned.length >= MAXP_MACRO) break;
    const tooClose = thinned.some((q) => Math.abs(q.lat - p.lat) < spacingDeg && Math.abs(q.lon - p.lon) < spacingDeg);
    if (!tooClose) thinned.push(p);
  }
  const { visible, goldSet, goldN } = applyGoldCap(thinned, cm);
  return res.json({
    hotspots: visible.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      species: p.species,
      label: SPECIES[p.species]?.label ?? p.species,
      eatScore: SPECIES[p.species]?.eatScore ?? null,
      score: p.score,
      gold: cm.unlocked === true && goldSet.has(p),
    })),
    meta: {
      count: visible.length,
      minScore,
      species: keys,
      asOf: asOf.toISOString().slice(0, 10),
      staticOnly,
      source: "overview",
      ...cm,
      goldPeaks: goldN,
      skipped: (res.locals.skipped as string[] | undefined) ?? [],
      nearbyActivity: await buildNearbyActivity(
        Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : centerLat,
        Number.isFinite(Number(req.query.lon)) ? Number(req.query.lon) : (minLon + maxLon) / 2,
        req,
        cm,
      ),
    },
  });
}

async function overviewHandler(req: express.Request, res: express.Response) {
  // Rate limit även på GET: motverkar scraping av hela landet (se docs/IP-PROTECTION.md)
  if (heavyRateLimited(req, 60)) return res.status(429).json({ error: "För många frågor — vänta en stund." });
  const keys = String(req.query.species ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k]);
  if (keys.length === 0) {
    return res.status(400).json({ error: "Expected query params: species=id1,id2,..." });
  }
  const locked = gateSpecies(req, keys);
  const open = keys.filter((k) => !locked.includes(k));
  if (open.length === 0 && locked.length > 0) return lockedResponse(res, locked);
  res.locals.skipped = locked;
  const staticOnly = req.query.static === "1";
  const asOf = parseAsOf(String(req.query.date ?? ""));
  const sens = Math.max(-50, Math.min(50, Number(req.query.sensitivity ?? 0) || 0));
  const minScore = Math.max(0, Math.min(100, (Number(req.query.minScore ?? 55) || 55) - sens));
  const cm = capMeta(req);
  const profile = await readPyramidProfile();

  const profiles: Record<string, PyramidProfile> = {};
  const tiers: Record<string, { species: string; lat: number; lon: number; northing: number; easting: number; score: number; count: number; gold: boolean }[]> = {
    "55km": [],
    "18km": [],
    "6km": [],
  };
  const TIER_SIZES: [string, number][] = [["55km", 55000], ["18km", 18000], ["6km", 6000]];
  for (const sp of open) {
    const ov = await readOverviewFile(sp);
    const cells = ov ? ov.cells : await macroFallbackCells(sp, minScore, asOf, staticOnly);
    profiles[sp] = profile?.profiles?.[sp] ?? defaultProfile(sp, ov);
    const tierMaps = new Map<string, Map<string, (typeof tiers)["55km"][number]>>();
    for (const [label] of TIER_SIZES) tierMaps.set(label, new Map());
    for (const c of cells) {
      let score = c.max;
      if (!staticOnly) score = Math.min(100, Math.round(c.max * (await overviewLiveFactor(sp, c.lat, c.lon, asOf))));
      if (score < minScore) continue;
      for (const [label, size] of TIER_SIZES) {
        const m = tierMaps.get(label)!;
        const k = `${Math.floor(c.e / size)},${Math.floor(c.n / size)}`;
        const prev = m.get(k);
        if (!prev || score > prev.score) {
          m.set(k, { species: sp, lat: c.lat, lon: c.lon, northing: c.n, easting: c.e, score, count: (prev?.count ?? 0) + 1, gold: false });
        } else {
          prev.count++;
        }
      }
    }
    for (const [label, m] of tierMaps) tiers[label].push(...m.values());
  }

  // Gold/cap per art och tier (samma princip som applyGoldCap: minst 1 synlig per art/tier).
  let goldPeaks = 0;
  const visibleTiers: typeof tiers = {};
  for (const [label, spots] of Object.entries(tiers)) {
    const bySp = new Map<string, typeof spots>();
    for (const s of spots) {
      const arr = bySp.get(s.species) ?? [];
      arr.push(s);
      bySp.set(s.species, arr);
    }
    const vis: typeof spots = [];
    for (const arr of bySp.values()) {
      arr.sort((a, b) => b.score - a.score);
      const goldN = Math.max(1, Math.round(arr.length * FREE_HIDE_FRACTION));
      for (let i = 0; i < goldN; i++) {
        arr[i].gold = true;
        goldPeaks++;
      }
      if (cm.capped) {
        const hidden = arr.filter((s) => s.gold);
        vis.push(...arr.filter((s) => !s.gold));
        if (vis.filter((s) => s.species === arr[0]?.species).length === 0 && hidden.length > 0) {
          vis.push({ ...hidden[hidden.length - 1], gold: false });
        }
      } else {
        vis.push(...arr);
      }
    }
    for (const s of vis) s.gold = cm.unlocked === true && s.gold;
    vis.sort((a, b) => b.score - a.score);
    visibleTiers[label] = vis;
  }

  res.json({
    overviewRevision: profile?.generatedAt ?? new Date().toISOString(),
    mode: staticOnly ? "habitat" : "live",
    capped: cm.capped,
    trial: cm.trial,
    goldPeaks,
    profiles,
    tiers: visibleTiers,
    skipped: locked,
    asOf: asOf.toISOString().slice(0, 10),
    minScore,
  });
}
app.get("/api/v1/fungi/overview", overviewHandler);
app.get("/api/overview", overviewHandler);

// ---------- Optimal zon (gröna zonen) — en sammanhängande polygon, se src/optimal-zone.ts ----------
// Cache med stale-while-revalidate: ett gammalt svar serveras DIREKT (aldrig vänta på
// omberäkning) och om TTL gått ut triggas omberäkning i bakgrunden. ZONE_TTL_MS styr TTL.
const ZONE_TTL_MS = Math.max(1000, Number(process.env.ZONE_TTL_MS ?? 15 * 60 * 1000) || 15 * 60 * 1000);
const zoneCache = new Map<string, { at: number; value: unknown }>();
const zoneInflight = new Set<string>();
async function zoneComputeBackground(cacheKey: string, open: string[], asOf: Date, staticOnly: boolean): Promise<void> {
  if (zoneInflight.has(cacheKey)) return;
  zoneInflight.add(cacheKey);
  try {
    const store = await getLayerStore();
    const result = await computeOptimalZone(store, open, asOf, { static: staticOnly });
    zoneCache.set(cacheKey, { at: Date.now(), value: result });
  } catch (e) {
    console.error("optimal-zone bakgrundsberäkning misslyckades:", (e as Error).message);
  } finally {
    zoneInflight.delete(cacheKey);
  }
}
app.get("/api/v1/fungi/optimal-zone", async (req, res) => {
  if (heavyRateLimited(req, 30)) return res.status(429).json({ error: "För många frågor — vänta en stund." });
  const keys = String(req.query.species ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k]);
  if (keys.length === 0) return res.status(400).json({ error: "Expected species=id1,id2,..." });
  const locked = gateSpecies(req, keys);
  const open = keys.filter((k) => !locked.includes(k));
  if (open.length === 0 && locked.length > 0) return lockedResponse(res, locked);
  const asOf = parseAsOf(String(req.query.date ?? ""));
  // static=1 = HABITAT-läge (året-runt biotop): F_season=F_climate=1, W_rain+H_static kvar
  const staticOnly = req.query.static === "1";
  const cacheKey = `${open.sort().join(",")}|${asOf.toISOString().slice(0, 10)}|static=${staticOnly ? "1" : "0"}`;
  const c = zoneCache.get(cacheKey);
  if (c) {
    // SWR: servera direkt; om TTL gått ut, beräkna om i bakgrunden (en gång åt gången)
    if (Date.now() - c.at >= ZONE_TTL_MS) void zoneComputeBackground(cacheKey, open, asOf, staticOnly);
    return res.json({ ...(c.value as object), cached: true, cacheAgeMs: Date.now() - c.at, skipped: locked });
  }
  try {
    const store = await getLayerStore();
    const result = await computeOptimalZone(store, open, asOf, { static: staticOnly });
    zoneCache.set(cacheKey, { at: Date.now(), value: result });
    res.json({ ...result, skipped: locked, asOf: asOf.toISOString().slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: "optimal-zone kunde inte beräknas", detail: (e as Error).message });
  }
});

// ---------- Bootstrap: EN round-trip vid app-start ----------
// Buntar det som är billigt och cachat server-side (meta fast=1 utan väder, shop, unlocked,
// moln-manifest, regn-manifest alla spann, leaderboard) — sparar 5-6 rundor på mobilnät.
// Kartdata (hotspots/tiles/overview/optimal-zone) hämtas fortfarande per vy som vanligt.
app.get("/api/v1/bootstrap", bootstrapHandler);
app.get("/api/bootstrap", bootstrapHandler);

// Publikt manifest — styr cache-busting (tileRev) i klienten utan att läcka interna
// lager (tileVersion i /api/meta är fortfarande DEBUG_API-gated). Workern servar samma
// struktur från R2 som manifest.json (se docs/R2-LAYOUT.md).
app.get("/api/v1/manifest", manifestHandler);
app.get("/manifest.json", manifestHandler);

// Publikt katalog — det Workern behöver för att vara origin-fri (R2: catalog.json).
// Innehåller bara produkt-info (labels/säsong/pack/pris/free), aldrig vikter eller lager.
app.get("/api/v1/catalog", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    api: "v1",
    generatedAt: new Date().toISOString(),
    tileRev: TILE_VERSION,
    freeSpecies: FREE_SPECIES,
    klassiker: SVENSKA_KLASSIKER_SPECIES,
    packs: Object.values(PACKS).map((p) => ({ id: p.id, label: p.label, priceSek: p.priceSek, species: p.species, kind: p.kind, forSale: p.forSale !== false })),
    singlePriceSek: SINGLE_PRICE_SEK,
    species: Object.entries(SPECIES).map(([id, s]) => ({
      id, label: s.label, season: [s.seasonStart, s.seasonEnd], pack: s.pack ?? null,
      protected: !!s.protected, eatScore: s.eatScore, rainWindowDays: s.rainWindowDays ?? 28,
    })),
  });
});
async function manifestHandler(req: express.Request, res: express.Response) {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    api: "v1",
    tileRev: TILE_VERSION, // publikt, avsiktligt: "r15" osv — cache-nyckel, inte intern metadata
    generatedAt: new Date().toISOString(),
    bounds: [SWEDEN_BBOX.minLon, SWEDEN_BBOX.minLat, SWEDEN_BBOX.maxLon, SWEDEN_BBOX.maxLat],
    speciesCount: Object.keys(SPECIES).length,
    freeSpecies: FREE_SPECIES,
    rainSpans: [14, 21, 28, 42],
    endpoints: {
      bootstrap: "/api/v1/bootstrap",
      overview: "/api/v1/fungi/overview",
      optimalZone: "/api/v1/fungi/optimal-zone",
      hotspots: "/api/hotspots",
      clouds: "/api/v1/weather/clouds/manifest",
      rainHistory: "/api/v1/weather/rain-history/manifest",
      tiles: "/api/tiles/{habitat|multi|hillshade}/...",
    },
  });
}
async function bootstrapHandler(req: express.Request, res: express.Response) {
  if (heavyRateLimited(req, 60)) return res.status(429).json({ error: "För många frågor — vänta en stund." });
  try {
    const firstSpecies = String(req.query.species ?? "kantarell").split(",")[0].trim() || "kantarell";
    const [meta, clouds, r14, r21, r28, r42, ovProfile] = await Promise.all([
      buildMetaPayload(req, SPECIES[firstSpecies] ? firstSpecies : "kantarell", { fast: true }).catch(() => null),
      getCloudManifest().catch(() => null),
      getRainManifest(14).catch(() => null),
      getRainManifest(21).catch(() => null),
      getRainManifest(28).catch(() => null),
      getRainManifest(42).catch(() => null),
      readPyramidProfile().catch(() => null),
    ]);
    // Per-art-buntar: ?species=a,b,c (max 6) ger ALLT klienten behöver per vald art i samma
    // svar — profil, topp-overviewceller, pyramid-profil och optimalzon (via samma SWR-cache
    // som /api/v1/fungi/optimal-zone). Telefonen ska inte behöva flera anrop eller räkna själv.
    const want = String(req.query.species ?? "")
      .split(",").map((s) => s.trim()).filter((k) => SPECIES[k]).slice(0, 6);
    const lockedF = gateSpecies(req, want);
    const openF = want.filter((k) => !lockedF.includes(k));
    const asOfB = parseAsOf(String(req.query.date ?? ""));
    const staticB = req.query.static === "1";
    const fungi: Record<string, unknown> = {};
    for (const id of openF) {
      const sp = SPECIES[id];
      const ov = await readOverviewFile(id).catch(() => null);
      const cells = (ov?.cells ?? [])
        .slice().sort((a, b) => b.max - a.max).slice(0, 120)
        .map((c) => ({ lon: c.lon, lat: c.lat, score: Math.round(c.max), e: Math.round(c.e), n: Math.round(c.n) }));
      const cacheKey = `${id}|${asOfB.toISOString().slice(0, 10)}|static=${staticB ? "1" : "0"}`;
      const zc = zoneCache.get(cacheKey);
      let zone: unknown = null;
      let zonePending = false;
      if (zc) zone = zc.value;
      else {
        zonePending = true;
        void zoneComputeBackground(cacheKey, [id], asOfB, staticB); // nästa anrop får zonen direkt
      }
      fungi[id] = {
        label: sp.label,
        season: [sp.seasonStart, sp.seasonEnd],
        rainWindowDays: sp.rainWindowDays ?? 28,
        pack: sp.pack ?? null,
        protected: !!sp.protected,
        profile: ovProfile?.profiles?.[id] ?? null,
        overviewCells: cells,
        zone,
        zonePending,
      };
    }
    res.json({
      api: "v1",
      tileRev: TILE_VERSION, // publik cache-nyckel (se /api/v1/manifest) — läcker inga lager
      serverTime: new Date().toISOString(),
      asOf: new Date().toISOString().slice(0, 10),
      meta,
      shop: buildShopPayload(req),
      unlocked: buildUnlockedPayload(req),
      leaderboard: { days: 5, leaderboard: leaderboard(5, 10) },
      clouds,
      rainHistory: { "14": r14, "21": r21, "28": r28, "42": r42 },
      fungi: want.length > 0 ? fungi : undefined,
      skippedSpecies: lockedF.length > 0 ? lockedF : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: "bootstrap misslyckades", detail: (e as Error).message });
  }
}

// ---------- Live molnprognos (SMHI SNOW1gv1, bakade PNG-frames; se src/clouds.ts) ----------
// Manifest cachas 30 min server-side; frames är immutable (id innehåller referenceTime-hash).
app.get("/api/v1/weather/clouds/manifest", async (req, res) => {
  try {
    const m = await getCloudManifest();
    res.set("Cache-Control", "public, max-age=300");
    res.json(m);
  } catch (e) {
    res.status(502).json({ error: "SMHI molnprognos otillgänglig just nu.", detail: (e as Error).message });
  }
});
app.get("/api/v1/weather/clouds/frame/:id.png", async (req, res) => {
  const buf = await getCloudFrame(String(req.params.id ?? ""));
  if (!buf) return res.status(404).json({ error: "Okänd moln-frame." });
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(buf);
});

// ---------- Rullande 7-dagars regnhistorik (SMHI Metobs param 5; se src/rain-history.ts) ----------
// Samma manifest/frame-kontrakt som molnen — iOS byter bara endpoint + pill-text.
app.get("/api/v1/weather/rain-history/manifest", async (req, res) => {
  try {
    // ?days=14|21|28|42 (default 28; ogiltigt värde -> default)
    const days = Number(req.query.days ?? 28);
    const m = await getRainManifest(Number.isFinite(days) ? days : 28);
    res.set("Cache-Control", "public, max-age=600");
    res.json(m);
  } catch (e) {
    res.status(502).json({ error: "SMHI regnhistorik otillgänglig just nu.", detail: (e as Error).message });
  }
});
app.get("/api/v1/weather/rain-history/frame/:id.png", async (req, res) => {
  const buf = await getRainFrame(String(req.params.id ?? ""));
  if (!buf) return res.status(404).json({ error: "Okänd regn-frame." });
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(buf);
});

app.get("/api/hotspots", async (req, res) => {
  if (heavyRateLimited(req, 120)) return res.status(429).json({ error: "För många frågor — vänta en stund." });
  const keys = String(req.query.species ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k]);
  // Låsta arter slängs bort här (200 + skipped) så kartan/pins fortfarande fungerar;
  // 403 bara när ALLA efterfrågade arter är låsta.
  const locked0 = gateSpecies(req, keys);
  const open0 = keys.filter((k) => !locked0.includes(k));
  if (open0.length === 0 && locked0.length > 0) return lockedResponse(res, locked0);
  keys.length = 0;
  keys.push(...open0);
  res.locals.skipped = locked0;
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
  // Stora bboxes (t.ex. hela Sverige) är tillåtna nu — klampas till Sverige; vid span > MACRO_SPAN
  // serveras pins från den bakade overview-JSON:en (med live-viktning när static != "1").
  minLon = Math.max(minLon, SWEDEN_BBOX.minLon);
  maxLon = Math.min(maxLon, SWEDEN_BBOX.maxLon);
  minLat = Math.max(minLat, SWEDEN_BBOX.minLat);
  maxLat = Math.min(maxLat, SWEDEN_BBOX.maxLat);
  if (maxLon - minLon <= 0 || maxLat - minLat <= 0) {
    return res.status(400).json({ error: "Bounding box outside Sweden coverage." });
  }
  const staticOnly = req.query.static === "1";
  const asOf = parseAsOf(String(req.query.date ?? ""));
  // Default 50 (was 80): dynamiska score (säsong×regn) ligger oftast 30–60, så 80 gav alltid tomma pins.
  // Med static=1 är score = habitat×100 och 80+ är "hett" — skicka då högre minScore från klienten.
  const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 50) || 50));

  const span = Math.max(maxLon - minLon, maxLat - minLat);
  // Lås rutnätet till en fast koordinatupplösning vid inzoomning (span <= 0.06°)
  // så att svamparna står helt stilla på exakt samma punkt när man zoomar in/ut.
  const cell = span <= 0.06 ? 0.0004 : cellForSpan(span);

  // Makroläge: hela Sverige (eller stor region) — bakad overview + rättvis artkvot.
  if (span > MACRO_SPAN) {
    return macroHotspotsResponse(req, res, keys, minLon, minLat, maxLon, maxLat, minScore, asOf, staticOnly);
  }

  if (bboxParam) {
    // Peak-pocket mode for the iOS symbol/icon layer: local maxima >= minScore,
    // thinned to ~120 m spacing, capped at 120 per viewport, across all checked species.
    const perSpecies = await Promise.all(
      keys.map((k) => computeCellsCached(k, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly)),
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
    const cm = capMeta(req);
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
    // Top-fraktion på den färdiga pin-listan: free efter trial ser bara botten (1-frac),
    // betalat ser alla och topp-frac får gold:true.
    const goldN = picked.length > 0 ? Math.max(1, Math.round(picked.length * FREE_HIDE_FRACTION)) : 0;
    const goldSet = new Set(picked.slice(0, goldN));
    const visible = cm.capped ? picked.slice(goldN) : picked;
    return res.json({
      hotspots: visible.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        species: p.species,
        label: SPECIES[p.species]?.label ?? p.species,
        eatScore: SPECIES[p.species]?.eatScore ?? null,
        score: p.score,
        gold: cm.unlocked === true && goldSet.has(p),
      })),
      meta: {
        count: visible.length,
        minScore,
        species: keys,
        asOf: asOf.toISOString().slice(0, 10),
        staticOnly,
        ...cm,
        goldPeaks: goldN,
        // nearbyActivity utgår från användarens riktiga GPS när klienten skickar lat/lon,
        // annars från kartkamerans mittpunkt.
        nearbyActivity: await buildNearbyActivity(
          Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : centerLat,
          Number.isFinite(Number(req.query.lon)) ? Number(req.query.lon) : (minLon + maxLon) / 2,
          req,
          cm,
        ),
      },
    });
  }

  const key = keys[0];
  const { cells, meta } = await computeCellsCached(key, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly);
  const cm = capMeta(req);
  const sorted = [...cells].sort((a, b) => b.score - a.score);
  const goldN = sorted.length > 0 ? Math.max(1, Math.round(sorted.length * FREE_HIDE_FRACTION)) : 0;
  const goldSet = new Set(sorted.slice(0, goldN));
  const visibleCells = cm.capped ? sorted.slice(goldN) : sorted;
  const features = visibleCells.map((c) => ({
    type: "Feature",
    properties: { score: c.score, heat: c.heat, gold: cm.unlocked === true && goldSet.has(c) },
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
  }));
  res.json({
    type: "FeatureCollection",
    meta: {
      ...meta,
      ...cm,
      goldCells: goldN,
      layers: [
        "smhi-precip-14d",
        "osm-forest-mask",
        "osm-exclusions(water/urban/roads/buildings)",
        "dem-water-cutoff",
        ...(meta.layersLoaded as string[]),
      ],
      generatedAt: new Date().toISOString(),
      skipped: (res.locals.skipped as string[] | undefined) ?? [],
      nearbyActivity: await buildNearbyActivity(
        Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : (minLat + maxLat) / 2,
        Number.isFinite(Number(req.query.lon)) ? Number(req.query.lon) : (minLon + maxLon) / 2,
        req,
        cm,
      ),
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
  const minScore = Math.max(0, Math.min(100, Number(req.query.minScore ?? 50) || 50));
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
  const { cells, meta } = await computeCellsCached(key, minLon, minLat, maxLon, maxLat, cell, asOf, staticOnly);
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
  const cm = capMeta(req);
  const sortedPeaks = [...peaks].sort((a, b) => b.score - a.score);
  const goldN = sortedPeaks.length > 0 ? Math.max(1, Math.round(sortedPeaks.length * FREE_HIDE_FRACTION)) : 0;
  const goldSet = new Set(sortedPeaks.slice(0, goldN));
  const visiblePeaks = cm.capped ? sortedPeaks.slice(goldN) : sortedPeaks;
  res.json({
    type: "FeatureCollection",
    meta: {
      ...meta,
      minScore,
      peakCount: visiblePeaks.length,
      ...cm,
      goldPeaks: goldN,
    },
    features: visiblePeaks.map((c) => ({
      type: "Feature",
      properties: {
        score: c.score,
        heat: c.heat,
        species: key,
        label: species.label,
        eatScore: species.eatScore,
        gold: cm.unlocked === true && goldSet.has(c),
      },
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
  res.setHeader("Cache-Control", "public, max-age=3600");
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
  if (!SPECIES[key]) return res.status(400).json({ error: "Okänd art." });
  res.json(await buildMetaPayload(req, key));
});

// Payload för /api/meta — delas även av /api/v1/bootstrap (där opts.fast=true för att
// slippa vänta på SMHI-väder vid app-start).
async function buildMetaPayload(req: express.Request, key: string, opts: { fast?: boolean } = {}): Promise<Record<string, unknown>> {
  const species = SPECIES[key];
  if (!species) throw new Error("Okänd art.");
  const asOf = parseAsOf(String(req.query.date ?? ""));
  const mLat = Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : 62.5;
  const mLon = Number.isFinite(Number(req.query.lon)) ? Number(req.query.lon) : 15.5;
  const store = await getLayerStore();
  // Väderhämtningar parallellt (SMHI) så /api/meta inte står och väntar seriellt.
  // ?fast=1 hoppar över väder helt (cache eller null) — räcker för artlista/GDD i klienten.
  const fast = opts.fast === true || req.query.fast === "1";
  const [rain14, minTemp, coolNights] = fast
    ? [null, null, null]
    : await Promise.all([
        rainLast14Days(mLat, mLon, asOf).catch((err) => {
          console.error("SMHI fetch failed:", err);
          return null;
        }),
        minTempLast48h(mLat, mLon, asOf),
        coolNightsLast7d(mLat, mLon, asOf),
      ]);
  const [f, x] =
    store.mask !== null
      ? [null, null]
      : await Promise.allSettled([
          forestPolygonsForBox(17.6, 59.0, 18.4, 59.6),
          exclusionsForBox(17.6, 59.0, 18.4, 59.6),
        ]);
  const frost = species.frostSensitive && minTemp !== null && minTemp <= -3 ? 0 : 1;
  const flush = flushFactor(coolNights);
  const gdd5 = effectiveGdd5(store, mLon, mLat);
  const nearbyActivity = await buildNearbyActivity(mLat, mLon, req, capMeta(req));
  return {
    nearbyActivity,
    species: key,
    label: species.label,
    eatScore: species.eatScore,
    note: species.note,
    protected: !!species.protected,
    expertMode: !!species.expertMode,
    lookalikes: species.lookalikes ?? null,
    season: [species.seasonStart, species.seasonEnd],
    entitlements: [...resolveEntitlements(req)],
    topSpots: capMeta(req),
    reviewRewardSpecies: REVIEW_REWARD_SPECIES,
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
    rainFactor: rain14 === null ? 0.5 : Number((1 - Math.exp(-rain14 / 32)).toFixed(3)),
    seasonFactor: Number(seasonalFactor(species, mLat, asOf).toFixed(2)),
    lat: mLat,
    lon: mLon,
    gdd5: gdd5 === null ? null : Math.round(gdd5),
    minTemp48h: minTemp,
    frost,
    coolNights7d: coolNights,
    flush,
    asOf: asOf.toISOString().slice(0, 10),
    forestKnown: store.mask !== null || (f !== null && f.status === "fulfilled" && f.value !== null),
    maskUsed: store.mask !== null,
    // Diagnostik som avslöjar interna lager/datamodell skickas BARA lokalt (DEBUG_API=1) —
    // i prod får klienten inte veta vilka rasters/vikter som används (docs/IP-PROTECTION.md).
    ...(process.env.DEBUG_API === "1"
      ? {
          hostFallback: hostFallback(store),
          layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
          layersTooBig: [...store.rasters.values()].filter((r) => r.tooBig).map((r) => r.id),
          tileVersion: path.basename(TILES_DIR),
          forestAreas: f && f.status === "fulfilled" ? (f.value?.length ?? 0) : 0,
          excludedAreas: x && x.status === "fulfilled" ? (x.value?.polys.length ?? 0) : 0,
          forestCount: f && f.status === "fulfilled" ? (f.value?.length ?? 0) : 0,
          exclCount: x && x.status === "fulfilled" ? (x.value?.polys.length ?? 0) : 0,
        }
      : {}),
  };
}

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
    cells = (await computeCellsCached(keys[0], eMinLon, eMinLat, eMaxLon, eMaxLat, cell, asOf, staticOnly)).cells;
  } else {
    const parts = await Promise.all(
      keys.map((k) => computeCellsCached(k, eMinLon, eMinLat, eMaxLon, eMaxLat, cell, asOf, staticOnly)),
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
  if (heavyRateLimited(req, 900)) return res.status(429).send("Too many tile requests");
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
  if (heavyRateLimited(req, 900)) return res.status(429).send("Too many tile requests");
  const keys = String(req.query.species ?? "kantarell")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => SPECIES[k])
    .slice(0, 6);
  if (keys.length === 0) return res.status(400).json({ error: "Okända arter i species=." });
  const lockedM = gateSpecies(req, keys);
  const openM = keys.filter((k) => !lockedM.includes(k));
  if (openM.length === 0 && lockedM.length > 0) return lockedResponse(res, lockedM);
  keys.length = 0;
  keys.push(...openM);
  res.locals.skipped = lockedM;
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

// Batch-variant av /api/debug/cell: många punkter i ett anrop (används av scripts/validate-auc.mjs
// som annars gör ~200k individuella HTTP-anrop). ents skickas som query param (?ents=all).
// Debug-endpoints är AVSTÄNGDA i prod (sätt DEBUG_API=1 lokalt). I Workers finns de inte alls.
function debugOff(res: express.Response): boolean {
  if (process.env.DEBUG_API === "1") return false;
  res.status(404).json({ error: "not found" });
  return true;
}

app.post("/api/debug/cells", async (req, res) => {
  if (debugOff(res)) return;
  if (heavyRateLimited(req, 10)) return res.status(429).json({ error: "För många batch-anrop — vänta en stund." });
  const key = String(req.body?.species ?? "");
  const species = SPECIES[key];
  if (!species) return res.status(400).json({ error: "Okänd art." });
  const lockedB = gateSpecies(req, [key]);
  if (lockedB.length > 0) return lockedResponse(res, lockedB);
  const rawPts: unknown = Array.isArray(req.body?.points) ? req.body.points : [];
  const pts = (rawPts as unknown[])
    .filter((p): p is unknown[] => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(Number(v))))
    .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    .slice(0, 20000);
  const staticOnly = req.body?.static === 1 || req.body?.static === true || req.query.static === "1";
  const asOf = parseAsOf(String(req.body?.date ?? req.query.date ?? ""));
  const store = await getLayerStore();
  const useMask = store.mask !== null;
  let forestPolys: Poly[] | null = null;
  let exclusions: Exclusions | null = null;
  if (!useMask && pts.length > 0) {
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const b = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    const [fp, ex] = await Promise.all([
      forestPolygonsForBox(b[0], b[1], b[2], b[3]),
      exclusionsForBox(b[0], b[1], b[2], b[3]),
    ]);
    forestPolys = fp;
    exclusions = ex;
  }
  const ex = exclusions ?? { polys: [] as Poly[], lines: [] as [number, number][][] };
  const waterPolys = ex.water ?? [];
  // Väder en gång vid mittpunkten (samma approximation som computeCells).
  let rainFactor = 0.5;
  let frost = 1;
  let flush = 1;
  if (!staticOnly && pts.length > 0) {
    const cLat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const cLon = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    try {
      const vals = await rainValues(cLat, cLon);
      const r14 = sumRain(vals, asOf, 14);
      const r90 = sumRain(vals, asOf, 90);
      rainFactor =
        (r14 === null ? 0.5 : 1 - Math.exp(-r14 / 32)) *
        (r90 === null ? 1 : 0.75 + 0.25 * (1 - Math.exp(-r90 / 120)));
    } catch {}
    const [minTemp, coolNights] = await Promise.all([minTempLast48h(cLat, cLon, asOf), coolNightsLast7d(cLat, cLon, asOf)]);
    if (species.frostSensitive && minTemp !== null && minTemp <= -3) frost = 0;
    flush = flushFactor(coolNights);
  }
  const obsIdx = await getObsIndex();
  const clearcuts = store.vectors.get("avverkningar");
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [lon, lat] = pts[i];
    const [e0, n0] = toSWEREF(lon, lat);
    const inForest = useMask
      ? store.mask!.has(e0, n0) && store.mask!.allows(e0, n0)
      : forestPolys !== null && pointInPolys(forestPolys, lon, lat);
    const nearWater =
      waterPolys.length > 0 &&
      (pointInPolys(waterPolys, lon, lat) || distToPolysMeters(waterPolys, lon, lat) < WATER_BUFFER_M);
    const excluded =
      nearWater ||
      (ex.polys.length > 0 &&
        (pointInPolys(ex.polys, lon, lat) || distToPolysMeters(ex.polys, lon, lat) < EXCLUSION_BUFFER_M));
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
    const inClearcut = clearcuts ? clearcuts.contains(e0, n0) : false;
    const habitat = staticHabitatScore(store, key, lon, lat, {
      forestOk: inForest,
      inClearcut,
      excluded,
      roadFactor,
      forestEdge,
    });
    const dynamic = staticOnly ? 1 : seasonalFactor(species, lat, asOf) * rainFactor * frost * flush;
    let prior = obsPrior(obsIdx, key, lon, lat);
    if (species.protected) prior = 0;
    const score = Math.min(100, Math.round(100 * habitat * dynamic * (1 + 0.15 * prior)));
    results.push({
      lon,
      lat,
      score,
      habitat: Number(habitat.toFixed(4)),
      inForest,
      excluded,
      gddEff: effectiveGdd5(store, lon, lat),
      obsPrior: Number(prior.toFixed(3)),
    });
    if (i % 500 === 499) await new Promise((r) => setImmediate(r));
  }
  res.json({ species: key, staticOnly, count: results.length, results });
});

app.get("/api/debug/cell", async (req, res) => {
  if (debugOff(res)) return;
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
  let rain30: number | null = null;
  let rain90: number | null = null;
  try {
    const vals = await rainValues(lat, lon);
    rain14 = sumRain(vals, asOf, 14);
    rain30 = sumRain(vals, asOf, 30);
    rain90 = sumRain(vals, asOf, 90);
  } catch {}
  const rainFactor =
    (rain14 === null ? 0.5 : 1 - Math.exp(-rain14 / 32)) *
    (rain90 === null ? 1 : 0.75 + 0.25 * (1 - Math.exp(-rain90 / 120)));
  const [minTemp, coolNights] = staticOnly
    ? [null, null]
    : await Promise.all([minTempLast48h(lat, lon, asOf), coolNightsLast7d(lat, lon, asOf)]);
  const frost = species.frostSensitive && minTemp !== null && minTemp <= -3 ? 0 : 1;
  const flush = flushFactor(coolNights);
  // Live: regnfaktor från ackumulerat regn-rutnät (samma som regnkarta); static=1 helt oberört.
  const rainWin = species.rainWindowDays ?? 28;
  const liveRain = staticOnly ? null : sampleRainForLive(lat, lon, rainWin);
  const dynRainF = staticOnly || !liveRain?.available ? rainFactor : liveRain.factor;
  const dynamic = staticOnly ? 1 : seasonalFactor(species, lat, asOf) * dynRainF * frost * flush;
  let prior = obsPrior(await getObsIndex(), key, lon, lat);
  if (species.protected) prior = 0;
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
    rain30,
    rain90,
    rainFactor: Number(rainFactor.toFixed(3)),
    // Live-regnförklaring (för iOS vid tryck på kartan); null i Habitat-läge (static=1)
    rainWindowDays: rainWin,
    rainAccumulatedMm: liveRain?.available ? liveRain.totalMm : null,
    rainFlushMm: liveRain?.available ? liveRain.flushMm : null,
    rainRecentMm: liveRain?.available ? liveRain.recentMm : null,
    mmPerWeek: liveRain?.available ? liveRain.mmPerWeek : null,
    effMmPerWeek: liveRain?.available ? liveRain.effMmPerWeek : null,
    rainFlushWindow: liveRain?.available ? liveRain.flushWindow : null,
    rainFactorLive: staticOnly ? null : Number(dynRainF.toFixed(3)),
    rainGrids: rainGridsAvailable(),
    seasonFactor: Number(seasonalFactor(species, lat, asOf).toFixed(2)),
    minTemp48h: minTemp,
    frost,
    coolNights7d: coolNights,
    flush,
    score: Math.min(100, Math.round(100 * habitat * dynamic * (1 + 0.15 * prior))),
    layersLoaded: [...store.rasters.keys(), ...store.vectors.keys()],
    layersTooBig: [...store.rasters.values()].filter((r) => r.tooBig).map((r) => r.id),
  });
});

app.get("/api/tiles/hillshade/:z/:x/:y.png", async (req, res) => {
  if (heavyRateLimited(req, 900)) return res.status(429).send("Too many tile requests");
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

// Affärs-katalog för StoreKit-vyn (ingen species-param behövs).
function buildShopPayload(req: express.Request): Record<string, unknown> {
  // ägande beräknas från ?ents= (i prod: från server-validerat kvitto) — stycklistan/topplistan
  // visar då bara arter användaren INTE redan har PERMANENT. Årskortets Svenska Klassiker är
  // temporära, så t.ex. kantarell syns fortfarande i singel-listan för årskort-användare
  // (köp = permanent). Utan ents = free-tier (alla låsta syns).
  const ents = resolveEntitlements(req);
  const owned = (id: string) => isSpeciesPermanentlyOwned(id, ents);
  const allSingles = Object.entries(SPECIES).filter(([id, s]) => s.pack && isValidSingleClaim(id));
  return {
    packs: Object.values(PACKS)
      .filter((p) => p.forSale)
      .map((p) => {
        const top = [...p.species].sort((a, b) => (SPECIES[b]?.eatScore ?? 0) - (SPECIES[a]?.eatScore ?? 0))[0];
        return {
          id: p.id,
          label: p.label,
          priceSek: p.priceSek,
          kind: p.kind,
          species: p.species,
          image: top ? `/icons/${top}.png` : null,
          topSpecies: top ?? null,
          owned: ents.has("all") || ents.has(p.id), // pro/årskort låser inte paket
        };
      }),
    reviewRewardSpecies: REVIEW_REWARD_SPECIES,
    svenskaKlassiker: SVENSKA_KLASSIKER_SPECIES,
    svenskaKlassikerActive: ents.has("pro") || ents.has("topspots") || [...ents].some((e) => e.startsWith("topspots:")),
    topSpotsPass: {
      id: PASS_ID,
      label: `Årskort ${PASS_YEAR} — de hetaste ~${Math.round(FREE_HIDE_FRACTION * 100)} % av ställena glöder i guld`,
      priceSek: TOP_SPOTS_PRICE_SEK,
      kind: "year-pass",
      year: PASS_YEAR,
      topHiddenFraction: FREE_HIDE_FRACTION,
    },
    freeSpecies: FREE_SPECIES,
    singlePriceSek: SINGLE_PRICE_SEK,
    soloOnlySpecies: SOLO_ONLY_SPECIES,
    topPicks: TOP_PICKS.map((id) => {
      const s = SPECIES[id];
      return {
        id,
        label: s.label,
        eatScore: s.eatScore,
        image: `/icons/${id}.png`,
        free: FREE_SPECIES.includes(id),
        priceSek: s.pack ? SINGLE_PRICE_SEK : 0,
        pack: s.pack ?? null,
      };
    }).filter((t) => !owned(t.id)),
    // Stycklista: bara arter användaren saknar. jattemusseron/goliatmusseron är solo-only
    // (SOLO_ONLY_SPECIES) och finns bara som eget paket goliatmusseron-solo (79 kr) — aldrig här.
    singles: allSingles
      .filter(([id]) => !owned(id))
      .map(([id, s]) => ({ id, label: s.label, eatScore: s.eatScore, image: `/icons/${id}.png`, priceSek: SINGLE_PRICE_SEK })),
    singlesTotal: allSingles.length,
    maxRewardClaims: MAX_REWARD_CLAIMS,
    singlesNote: "Efter att du använt dina gratis-upplåsningar via betyg (max " + MAX_REWARD_CLAIMS + ") kan du köpa vilken låst art som helst enskilt för " + SINGLE_PRICE_SEK + " kr.",
  };
}
app.get("/api/shop", (req, res) => {
  res.json(buildShopPayload(req));
});

// Dev-läge: köp enskild svamp (39 kr). I produktion: StoreKit-produkt per art + server-validerat kvitto.
app.post("/api/single/claim", (req, res) => {
  const id = String(req.body?.species ?? "");
  if (!isValidSingleClaim(id)) {
    return res.status(403).json({ error: "Arten kan inte köpas enskilt (endast via sitt paket).", soloOnly: SOLO_ONLY_SPECIES });
  }
  res.json({ ok: true, entitlements: `species:${id}`, unlocked: id, priceSek: SINGLE_PRICE_SEK });
});

// Vilka arter är upplåsta för dessa entitlements? (klienten kan synka detta efter köp)
function buildUnlockedPayload(req: express.Request): Record<string, unknown> {
  const ents = resolveEntitlements(req);
  return {
    entitlements: [...ents],
    unlocked: Object.keys(SPECIES).filter((id) => isSpeciesUnlocked(id, ents)),
    svenskaKlassiker: SVENSKA_KLASSIKER_SPECIES,
    svenskaKlassikerActive: ents.has("pro") || ents.has("topspots") || [...ents].some((e) => e.startsWith("topspots:")),
    topSpots: canSeeTopSpots(req),
  };
}
app.get("/api/unlocked", (req, res) => {
  res.json(buildUnlockedPayload(req));
});

// --- Referral-koder (dev-läge, in-memory; i produktion i DB) ---
// POST /api/referral/create {device} -> {code}  (användaren delar koden)
// POST /api/referral/redeem {code, device} -> 200 om giltig, ej egen, ej använd; då får
//   enheten ett referral-claim (max MAX_REFERRAL_CLAIMS st).
// --- Referrals: persistenta i data/referrals.json (överlever omstarter) ---
interface ReferralState {
  codes: Record<string, { owner: string; usedBy: string | null }>;
  redeemedBy: Record<string, number>; // device -> inlösta referral-koder
  earnedBy: Record<string, number>; // ägare -> inbjudna vänner (förtjänade claims)
  rewardClaims: Record<string, { id: string; type: string; at: string }[]>; // device -> claims
}
const REFERRALS_FILE = path.join(here, "..", "data", "referrals.json");
function loadReferrals(): ReferralState {
  try {
    return { codes: {}, redeemedBy: {}, earnedBy: {}, rewardClaims: {}, ...JSON.parse(fs.readFileSync(REFERRALS_FILE, "utf8")) };
  } catch {
    return { codes: {}, redeemedBy: {}, earnedBy: {}, rewardClaims: {} };
  }
}
function saveReferrals(s: ReferralState): void {
  fs.mkdirSync(path.dirname(REFERRALS_FILE), { recursive: true });
  const tmp = REFERRALS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, REFERRALS_FILE);
}
function newCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
app.post("/api/referral/create", (req, res) => {
  const device = String(req.body?.device ?? "anon");
  const code = newCode();
  const st = loadReferrals();
  st.codes[code] = { owner: device, usedBy: null };
  saveReferrals(st);
  res.json({ code, earned: st.earnedBy[device] ?? 0, shareText: `SvampRadar: prova appen! Använd min kod ${code} så får vi båda en gratis svamp-art.` });
});
app.post("/api/referral/redeem", (req, res) => {
  const code = String(req.body?.code ?? "").toUpperCase();
  const device = String(req.body?.device ?? "anon");
  const st = loadReferrals();
  const entry = st.codes[code];
  if (!entry) return res.status(404).json({ error: "Ogiltig kod." });
  if (entry.owner === device) return res.status(403).json({ error: "Kan inte lösa in sin egen kod." });
  if (entry.usedBy) return res.status(409).json({ error: "Koden är redan använd." });
  entry.usedBy = device;
  st.redeemedBy[device] = (st.redeemedBy[device] ?? 0) + 1;
  st.earnedBy[entry.owner] = (st.earnedBy[entry.owner] ?? 0) + 1; // ägaren får också en referral-credit
  saveReferrals(st);
  res.json({ ok: true, referralClaims: Math.min(st.redeemedBy[device] ?? 1, MAX_REFERRAL_CLAIMS), earned: st.earnedBy[entry.owner] ?? 0, maxReferralClaims: MAX_REFERRAL_CLAIMS });
});

// --- Inlösenkoder (redeem codes) — admin skapar via `npm run redeem`, fil data/redeem-codes.json ---
// POST /api/redeem {code, device} -> 200 {ok, entitlement, label, alreadyRedeemed}
// GET  /api/redeem?device=x -> vilka koder enheten redan löst in (återställning efter ominstallation)
const redeemAttempts = new Map<string, number[]>();
function redeemRateLimited(key: string): boolean {
  const now = Date.now();
  const arr = (redeemAttempts.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  redeemAttempts.set(key, arr);
  if (arr.length >= 20) return true;
  arr.push(now);
  return false;
}

app.post("/api/redeem", (req, res) => {
  const device = String(req.body?.device ?? "anon");
  const code = normalizeCode(String(req.body?.code ?? ""));
  if (redeemRateLimited(device + "|" + (req.ip ?? ""))) {
    return res.status(429).json({ error: "För många försök — vänta några minuter." });
  }
  if (!code) return res.status(400).json({ error: "Ange en kod (SVAMP-XXXX-XXXX-XXXX)." });
  const codes = loadCodes(); // läses per anrop så CLI-ändringar gäller direkt utan omstart
  const entry = codes[code];
  if (!entry || !checksumOk(code)) return res.status(404).json({ error: "Ogiltig kod (kontrollera stavningen)." });
  if (entry.revoked) return res.status(410).json({ error: "Koden är återkallad." });
  if (entry.expires && entry.expires < new Date().toISOString().slice(0, 10)) {
    return res.status(410).json({ error: "Koden har gått ut." });
  }
  const already = entry.redeemedBy.includes(device);
  if (!already) {
    if (entry.uses > 0 && entry.redeemedBy.length >= entry.uses) {
      return res.status(409).json({ error: "Koden är förbrukad (max antal enheter nått)." });
    }
    entry.redeemedBy.push(device);
    codes[code] = entry;
    saveCodes(codes);
    appendLog({ at: new Date().toISOString(), code, device, grant: entry.grant, note: entry.note });
  }
  res.json({ ok: true, code, grant: entry.grant, entitlement: entry.grant, label: grantLabel(entry.grant), alreadyRedeemed: already });
});

app.get("/api/redeem", (req, res) => {
  const device = String(req.query.device ?? "");
  const codes = loadCodes();
  const redeemed = Object.entries(codes)
    .filter(([, e]) => e.redeemedBy.includes(device))
    .map(([code, e]) => ({ code, grant: e.grant, label: grantLabel(e.grant) }));
  res.json({ device, redeemed });
});

// Dev-läge: lås upp en pool-art via verifierad belöning.
// type: "review" (max MAX_REVIEW_CLAIMS, kräver rating/comment i body) eller
//       "referral" (max MAX_REFERRAL_CLAIMS, kräver att enheten löst in en kod —
//       här godkänns body.types från klienten; i produktion kollas referralCodes/redeemedByDevice i DB).
app.post("/api/reward/claim", (req, res) => {
  const device = String(req.body?.device ?? "anon");
  const id = String(req.body?.species ?? "");
  const type = String(req.body?.type ?? "review");
  if (!isValidRewardClaim(id)) {
    return res.status(403).json({ error: "Arten kan inte lösas ut via belöning.", allowed: REVIEW_REWARD_SPECIES });
  }
  const st = loadReferrals();
  const claims = st.rewardClaims[device] ?? [];
  if (claims.some((c) => c.id === id)) {
    return res.status(409).json({ error: "Redan upplåst via belöning.", entitlements: "reward:" + id });
  }
  if (claims.length >= MAX_REWARD_CLAIMS) {
    return res.status(403).json({ error: `Max ${MAX_REWARD_CLAIMS} gratis-arter (1 recension + ${MAX_REFERRAL_CLAIMS} referrals) — köp resten för ${SINGLE_PRICE_SEK} kr.`, maxRewardClaims: MAX_REWARD_CLAIMS });
  }
  if (type === "review") {
    const nReview = claims.filter((c) => c.type === "review").length;
    const rating = Number(req.body?.rating ?? 0);
    const comment = String(req.body?.comment ?? "").trim();
    if (nReview >= MAX_REVIEW_CLAIMS) return res.status(403).json({ error: "App-recensionen är redan använd (max 1)." });
    if (!(rating >= 1 && rating <= 5) && comment.length < 3) {
      return res.status(400).json({ error: "Ange betyg 1–5 eller en kommentar." });
    }
  } else if (type === "referral") {
    const nRef = claims.filter((c) => c.type === "referral").length;
    if (nRef >= MAX_REFERRAL_CLAIMS) return res.status(403).json({ error: `Max ${MAX_REFERRAL_CLAIMS} referral-belöningar.`, maxReferralClaims: MAX_REFERRAL_CLAIMS });
    // både egna inlösta koder OCH inbjudna vänner (earnedBy) ger referral-credit
    if ((st.redeemedBy[device] ?? 0) + (st.earnedBy[device] ?? 0) <= nRef) {
      return res.status(403).json({ error: "Lös in en referral-kod (eller få en vän att lösa in din) först — kontrolleras server-side.", maxReferralClaims: MAX_REFERRAL_CLAIMS });
    }
  } else {
    return res.status(400).json({ error: "Ogiltig belöningstyp (review|referral)." });
  }
  claims.push({ id, type, at: new Date().toISOString() });
  st.rewardClaims[device] = claims;
  saveReferrals(st);
  res.json({ ok: true, type, entitlements: `reward:${id}`, unlocked: id, rewardClaimsLeft: MAX_REWARD_CLAIMS - claims.length, referralClaims: Math.min((st.redeemedBy[device] ?? 0) + (st.earnedBy[device] ?? 0), MAX_REFERRAL_CLAIMS), maxReferralClaims: MAX_REFERRAL_CLAIMS });
});

// --- Admin-API (PIN från .env ADMIN_PIN) — skapa/återkalla inlösenkoder inifrån appen ---
const ADMIN_PIN = process.env.ADMIN_PIN ?? "";
const adminAttempts = new Map<string, number[]>();
function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!ADMIN_PIN) {
    res.status(404).json({ error: "Admin avstängt — sätt ADMIN_PIN i .env." });
    return false;
  }
  const now = Date.now();
  const key = req.ip ?? "x";
  const arr = (adminAttempts.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  adminAttempts.set(key, arr);
  arr.push(now);
  if (arr.length > 10) {
    res.status(429).json({ error: "För många admin-försök." });
    return false;
  }
  const pin = String(req.query.pin ?? req.body?.pin ?? "");
  if (pin !== ADMIN_PIN) {
    res.status(403).json({ error: "Fel PIN." });
    return false;
  }
  return true;
}

app.post("/api/admin/redeem", (req, res) => {
  if (!adminGuard(req, res)) return;
  const grant = String(req.body?.grant ?? "");
  const err = validateGrant(grant);
  if (err) return res.status(400).json({ error: err });
  const uses = Math.max(0, Math.min(100000, Math.floor(Number(req.body?.uses ?? 1)) || 1));
  const expiresRaw = String(req.body?.expires ?? "").trim();
  const expires = expiresRaw || null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return res.status(400).json({ error: "expires ska vara YYYY-MM-DD" });
  const note = String(req.body?.note ?? "").slice(0, 200);
  const code = makeCode();
  const codes = loadCodes();
  codes[code] = { grant, uses, expires, note, createdAt: new Date().toISOString(), revoked: false, redeemedBy: [] };
  saveCodes(codes);
  appendLog({ at: new Date().toISOString(), code, device: "admin", grant, note, via: "admin-api" });
  res.json({ ok: true, code, grant, label: grantLabel(grant), uses, expires, note });
});

app.post("/api/admin/redeem/revoke", (req, res) => {
  if (!adminGuard(req, res)) return;
  const code = normalizeCode(String(req.body?.code ?? ""));
  const codes = loadCodes();
  const e = codes[code];
  if (!e) return res.status(404).json({ error: "Hittades inte." });
  e.revoked = true;
  saveCodes(codes);
  res.json({ ok: true, code, revoked: true });
});

app.get("/api/admin/overview", (req, res) => {
  if (!adminGuard(req, res)) return;
  const codes = Object.entries(loadCodes()).map(([code, e]) => ({
    code,
    grant: e.grant,
    label: grantLabel(e.grant),
    uses: e.uses,
    used: e.redeemedBy.length,
    expires: e.expires,
    revoked: e.revoked,
    note: e.note,
    createdAt: e.createdAt,
  }));
  let log: unknown[] = [];
  try {
    log = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-100).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return l;
      }
    });
  } catch {}
  const st = loadReferrals();
  res.json({
    codes,
    log,
    referrals: {
      codesIssued: Object.keys(st.codes).length,
      redeemedBy: st.redeemedBy,
      earnedBy: st.earnedBy,
      rewardClaims: Object.fromEntries(Object.entries(st.rewardClaims).map(([d, c]) => [d, c.map((x) => `${x.id}:${x.type}`)])),
    },
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
  // Värm regn-rutnäten (rolling-42d.json) i bakgrunden så Live-läge får grid-baserad regnfaktor direkt
  void warmRainGrids().catch((e) => console.error("warmRainGrids misslyckades:", (e as Error).message));
  // Förvärm optimalzonen för gratis-/toppartisterna (båda lägen) så första kartvyn är omedelbar.
  // PREWARM_ZONES=0 stänger av; PREWARM_ZONE_MAX begränsar antal arter (default 10).
  if ((process.env.PREWARM_ZONES ?? "1") === "1") {
    void prewarmZones().catch((e) => console.error("prewarmZones misslyckades:", (e as Error).message));
  }
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
    await getLayerStore().catch(() => {}); // förvärm raster så första riktiga anropet är snabbt
    await getObsIndex().catch(() => {});
    await minTempLast48h(lat, lon, new Date());
  }
}

// Förvärm zoneCache för de arter som visas först (FREE_SPECIES + TOP_PICKS), båda lägen.
// Körs sekventiellt i bakgrunden efter boot — blockerar aldrig lyssnaren eller första anropet.
async function prewarmZones(): Promise<void> {
  const max = Math.max(1, Number(process.env.PREWARM_ZONE_MAX ?? 10) || 10);
  const ids = [...new Set([...FREE_SPECIES, ...TOP_PICKS])].filter((k) => SPECIES[k]).slice(0, max);
  const asOf = new Date();
  const store = await getLayerStore();
  let n = 0;
  for (const staticOnly of [false, true]) {
    for (const id of ids) {
      const cacheKey = `${id}|${asOf.toISOString().slice(0, 10)}|static=${staticOnly ? "1" : "0"}`;
      if (zoneCache.has(cacheKey) || zoneInflight.has(cacheKey)) continue;
      try {
        const t = Date.now();
        const result = await computeOptimalZone(store, [id], asOf, { static: staticOnly });
        zoneCache.set(cacheKey, { at: Date.now(), value: result });
        n++;
        console.log(`prewarm zone ${id} static=${staticOnly ? 1 : 0} klar på ${Date.now() - t} ms (peak=${(result.meta as Record<string, unknown>).peakScore})`);
      } catch (e) {
        console.error(`prewarm zone ${id} misslyckades:`, (e as Error).message);
      }
    }
  }
  console.log(`prewarm zones klar: ${n} art/läge-kombinationer i zoneCache`);
}

setInterval(() => void prewarmWeather(), 6 * 3600 * 1000);
void prewarmWeather();
