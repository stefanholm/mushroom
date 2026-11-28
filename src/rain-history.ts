// rain-history.ts — ackumulerad nederbördshistorik (SMHI Metobs parameter 5, dygnssumma mm,
// CC BY 4.0) bakad till bandningsfria 256x320 RGBA-PNG-frames över Sverige.
//
// Persistent rullande 6-veckorsfil: data/rain-history/rolling-42d.json
//   { updatedAt, maxDays: 42, stations: {id: {lat, lon}}, days: { "YYYY-MM-DD": {id: mm} } }
// Var 6:e timme mergas nya SMHI latest-months in i filen; prune är hårt till max 42 dygn
// (cutoff = senaste datum - 41 d) och rensar även stationer som inte längre finns kvar.
// Skrivs atomiskt (.tmp + rename). Vid SMHI-fel serveras filen rakt från disk.
//
// Manifest stöder ?days=14|21|28|42 (default 28): ackumulerade frames — frame k visar
// TOTAL nederbörd från startDate till frame-slutdatum. Alla spann renderas från den
// 6h-cachade rolling-filen (ingen extra SMHI-hämtning per spann); PNG:er cachas per spann
// i data/rain-history/{days}d/ och gamla frames från tidigare referenceTime rensas bort.
//
// Render: 256x320 över [10.5,55.0,24.5,69.5], gaussisk IDW sigma=48 km × avståndsdämpning
// exp(-(minDist/75km)^2), 15% kant-feather, ±0.5 LSB dither → ytterkant alltid alpha=0,
// noll bandning. Färg normaliseras per vecka (mm/vecka) så 14d- och 42d-kartorna får samma
// tydliga kontrast mot sepia-baskartan.

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { PNG } from "pngjs";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);
const to3006 = ([lon, lat]: [number, number]) => proj4("EPSG:4326", "EPSG:3006", [lon, lat]) as [number, number];

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, "..", "data", "rain-history");
const ROLLING_FILE = path.join(DIR, "rolling-42d.json");

const METOBS = "https://opendata-download-metobs.smhi.se/api/version/latest";
const PARAM = "5"; // nederbörd summa 1 dygn (mm)

export const RAIN_BOUNDS = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const W = 256;
const H = 320;
const MAX_DAYS = 42; // hårt tak för rolling-filen
const REFRESH_MS = 6 * 3600 * 1000;
const SIGMA_M = 48_000;
const DECAY_M = 75_000;
const MAX_INTERP_M = 160_000;
const CONCURRENCY = 14;
const ALLOWED_DAYS = [14, 21, 28, 42] as const;
const DEFAULT_DAYS = 28;
// antal ackumulerade frames per spann
const FRAMES_PER_DAYS: Record<number, number> = { 14: 8, 21: 11, 28: 10, 42: 11 };
// andel av dygn i ett fönster som måste finnas för att en station ska ingå i en frame
const MIN_PRESENCE = 0.6;

const SELECT_BOUNDS = { minLon: 10.0, minLat: 54.5, maxLon: 25.0, maxLat: 70.0 };
const CELL_DEG = 0.7;
const MAX_PER_CELL = 1;
const MAX_DAILY_MM = 150; // felvärden över detta = saknad dag

type RollingFile = {
  updatedAt: string;
  maxDays: number;
  stations: Record<string, { lat: number; lon: number }>;
  days: Record<string, Record<string, number>>;
};
type FrameMeta = {
  id: string; startDate: string; endDate: string; daysAcc: number; daysAgoEnd: number;
  label: string; maxMm: number; url: string;
};
type Manifest = {
  updatedAt: string;
  referenceTime: string;
  requestedDays: number;
  spanDays: number;
  mode: "accumulated";
  stationCount: number;
  bounds: [number, number, number, number];
  width: number;
  height: number;
  attribution: string;
  frames: FrameMeta[];
};

let rollingCache: { at: number; data: RollingFile } | null = null;
let rollingInflight: Promise<RollingFile> | null = null;
let manifestCaches = new Map<number, { at: number; manifest: Manifest }>();
let manifestInflight = new Map<number, Promise<Manifest>>();

const hash8 = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const dayMs = 86400000;
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, k: number) => toDay(new Date(new Date(day + "T12:00:00Z").getTime() + k * dayMs));
const compactDay = (day: string) => day.replace(/-/g, "");

async function fetchJson(url: string, timeoutMs = 25000): Promise<unknown> {
  const r = await fetch(url, { headers: { "accept-encoding": "gzip", accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`SMHI ${url} -> HTTP ${r.status}`);
  return r.json();
}

// ---------- persistent rolling-fil ----------

// Hård prune: behåll bara de maxDays senaste datumen (cutoff = latest - (maxDays-1)).
export function pruneRollingDays(
  days: Record<string, Record<string, number>>,
  latestDate: string,
  maxDays = MAX_DAYS,
): Record<string, Record<string, number>> {
  const cutoff = addDays(latestDate, -(maxDays - 1));
  const out: Record<string, Record<string, number>> = {};
  for (const [d, vals] of Object.entries(days)) {
    if (d >= cutoff && d <= latestDate && vals && Object.keys(vals).length > 0) out[d] = vals;
  }
  return out;
}

async function readRollingDisk(): Promise<RollingFile | null> {
  try {
    return JSON.parse(await fsp.readFile(ROLLING_FILE, "utf8")) as RollingFile;
  } catch {
    return null;
  }
}

async function writeRollingDisk(data: RollingFile): Promise<void> {
  await fsp.mkdir(DIR, { recursive: true });
  const tmp = ROLLING_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data));
  fs.renameSync(tmp, ROLLING_FILE); // atomiskt
}

async function selectStations(): Promise<{ id: string; lat: number; lon: number }[]> {
  const j = (await fetchJson(`${METOBS}/parameter/${PARAM}.json`, 40000)) as {
    station?: { key: unknown; summary?: string; active?: boolean }[];
  };
  const all: { id: string; lat: number; lon: number }[] = [];
  for (const s of j.station ?? []) {
    const m = /Latitud:\s*(-?[\d.]+)\s+Longitud:\s*(-?[\d.]+)/.exec(s.summary ?? "");
    if (!m || s.active === false) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (lon < SELECT_BOUNDS.minLon || lon > SELECT_BOUNDS.maxLon || lat < SELECT_BOUNDS.minLat || lat > SELECT_BOUNDS.maxLat) continue;
    all.push({ id: String(s.key), lat, lon });
  }
  const cells = new Map<string, number>();
  const picked: { id: string; lat: number; lon: number }[] = [];
  for (const s of all) {
    const key = `${Math.floor(s.lat / CELL_DEG)}:${Math.floor(s.lon / CELL_DEG)}`;
    const c = cells.get(key) ?? 0;
    if (c >= MAX_PER_CELL) continue;
    cells.set(key, c + 1);
    picked.push(s);
  }
  return picked;
}

async function fetchStationDays(id: string): Promise<Map<string, number>> {
  const j = (await fetchJson(`${METOBS}/parameter/${PARAM}/station/${id}/period/latest-months/data.json`)) as {
    value?: { ref?: string; to?: number; value?: string }[];
  };
  const days = new Map<string, number>();
  for (const v of j.value ?? []) {
    const day = v.ref ?? (v.to ? toDay(new Date(v.to)) : null);
    const mm = Number(v.value);
    if (day && Number.isFinite(mm) && mm >= 0 && mm <= MAX_DAILY_MM) days.set(day, mm);
  }
  return days;
}

async function pool<T, R>(items: T[], worker: (t: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx]);
      }
    }),
  );
  return out;
}

// Hämta SMHI och merga in i rolling-filen; returnerar den uppdaterade filen.
async function updateRolling(): Promise<RollingFile> {
  const picked = await selectStations();
  const daysList = await pool(
    picked,
    async (s) => {
      try {
        return await fetchStationDays(s.id);
      } catch {
        return new Map<string, number>();
      }
    },
    CONCURRENCY,
  );
  const base = (await readRollingDisk()) ?? { updatedAt: "", maxDays: MAX_DAYS, stations: {}, days: {} };
  const rolling: RollingFile = { updatedAt: new Date().toISOString(), maxDays: MAX_DAYS, stations: { ...base.stations }, days: { ...base.days } };
  let latest = Object.keys(rolling.days).sort().pop() ?? "";
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i];
    rolling.stations[s.id] = { lat: s.lat, lon: s.lon };
    const days = daysList[i];
    for (const [d, mm] of days) {
      (rolling.days[d] ??= {})[s.id] = mm;
      if (d > latest) latest = d;
    }
  }
  if (!latest) throw new Error("ingen data från SMHI och ingen tidigare rolling-fil");
  rolling.days = pruneRollingDays(rolling.days, latest, MAX_DAYS);
  // rensa stationer som inte finns i någon kvarvarande dag
  const used = new Set<string>();
  for (const vals of Object.values(rolling.days)) for (const id of Object.keys(vals)) used.add(id);
  for (const id of Object.keys(rolling.stations)) if (!used.has(id)) delete rolling.stations[id];
  await writeRollingDisk(rolling);
  console.log(`rolling-42d.json: ${Object.keys(rolling.days).length} dygn (max ${MAX_DAYS}), ${Object.keys(rolling.stations).length} stationer, senaste ${latest}`);
  return rolling;
}

// Rolling-fil: 6h minnes-cache; vid SMHI-fel serveras senast sparade disk-fil.
async function getRolling(): Promise<RollingFile> {
  if (rollingCache && Date.now() - rollingCache.at < REFRESH_MS) return rollingCache.data;
  if (rollingInflight) return rollingInflight;
  rollingInflight = (async () => {
    try {
      const data = await updateRolling();
      rollingCache = { at: Date.now(), data };
      buildGrids(data); // live-rutnät för sampleRainForLive
      return data;
    } catch (e) {
      console.error("rain-history update failed, använder disk-cache:", (e as Error).message);
      const disk = await readRollingDisk();
      if (!disk) throw e;
      rollingCache = { at: Date.now() - REFRESH_MS + 60000, data: disk };
      buildGrids(disk);
      return disk;
    } finally {
      rollingInflight = null;
    }
  })();
  return rollingInflight;
}

// ---------- ackumulerad rendering ----------

function interpField(stations: { e: number; n: number; v: number }[]): Float32Array {
  const out = new Float32Array(W * H);
  const [minE, maxN] = to3006([RAIN_BOUNDS.minLon, RAIN_BOUNDS.maxLat]);
  const [maxE, minN] = to3006([RAIN_BOUNDS.maxLon, RAIN_BOUNDS.minLat]);
  const sx = (maxE - minE) / W;
  const sy = (maxN - minN) / H;
  const sig2 = 2 * SIGMA_M * SIGMA_M;
  const dec2 = 2 * DECAY_M * DECAY_M;
  for (let py = 0; py < H; py++) {
    const n = maxN - (py + 0.5) * sy;
    for (let px = 0; px < W; px++) {
      const e = minE + (px + 0.5) * sx;
      let minD2 = Infinity;
      for (const s of stations) {
        const d2 = (s.e - e) * (s.e - e) + (s.n - n) * (s.n - n);
        if (d2 < minD2) minD2 = d2;
      }
      if (Math.sqrt(minD2) > MAX_INTERP_M) continue;
      const decay = Math.exp(-minD2 / dec2);
      let wsum = 0;
      let vsum = 0;
      for (const s of stations) {
        const d2 = (s.e - e) * (s.e - e) + (s.n - n) * (s.n - n);
        if (d2 > MAX_INTERP_M * MAX_INTERP_M) continue;
        const w = Math.exp(-d2 / sig2) * decay;
        wsum += w;
        vsum += w * s.v;
      }
      out[py * W + px] = wsum > 1e-9 ? vsum / wsum : 0;
    }
  }
  return out;
}

// Mättad akvarell-skala per VECKA (mm/vecka): 0-3 transparent; 3-10 turkosblå slöja;
// 10-25 kobolt/skifferblå fuktzon; 25-50+ djup indigoblå kärna. Kontinuerlig i flyttal.
const STOPS: [mmPerWeek: number, r: number, g: number, b: number, a: number][] = [
  [0, 42, 132, 178, 0],
  [3, 42, 132, 178, 0],
  [10, 24, 96, 168, 0.42],
  [25, 18, 58, 138, 0.72],
  [50, 18, 58, 138, 0.88],
  [1e9, 18, 58, 138, 0.88],
];

function ramp(mmPerWeek: number): [number, number, number, number] {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [m0, r0, g0, b0, a0] = STOPS[i];
    const [m1, r1, g1, b1, a1] = STOPS[i + 1];
    if (mmPerWeek <= m1) {
      const t = m1 === m0 ? 0 : (mmPerWeek - m0) / (m1 - m0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, a0 + (a1 - a0) * t];
    }
  }
  const s = STOPS[STOPS.length - 1];
  return [s[1], s[2], s[3], s[4]];
}

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const dither = (x: number, y: number, seed: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return (s - Math.floor(s)) - 0.5;
};

function renderFrame(field: Float32Array, spanDays: number, seed: number): Buffer {
  const weeks = spanDays / 7;
  const png = new PNG({ width: W, height: H });
  const feather = 0.15;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const [r, g, b, a] = ramp(field[k] / weeks); // normalisera per vecka
      const fx = smoothstep(Math.min(x / W, (W - 1 - x) / W) / feather);
      const fy = smoothstep(Math.min(y / H, (H - 1 - y) / H) / feather);
      const alpha = a * fx * fy;
      if (alpha <= 0.008) {
        png.data[k * 4 + 3] = 0;
        continue;
      }
      const o = k * 4;
      const d = dither(x, y, seed);
      png.data[o] = Math.max(0, Math.min(255, Math.round(r + d)));
      png.data[o + 1] = Math.max(0, Math.min(255, Math.round(g + d)));
      png.data[o + 2] = Math.max(0, Math.min(255, Math.round(b + d)));
      png.data[o + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255 + d)));
    }
  }
  return PNG.sync.write(png, { deflateLevel: 9 });
}

function labelFor(startDay: string, endDay: string, suffix = ""): string {
  const f = (d: string) => {
    const dt = new Date(d + "T12:00:00Z");
    const mon = new Intl.DateTimeFormat("sv-SE", { month: "short", timeZone: "UTC" }).format(dt).replace(/\.$/, "");
    return `${dt.getUTCDate()} ${mon}`;
  };
  return `${f(startDay)}–${f(endDay)}${suffix}`;
}

// Ackumulerad summa per station över [start..end]; stationen krävs ha minst MIN_PRESENCE
// av dygn i fönstret, annars skippas den för just den framen.
export function accumulateWindow(rolling: RollingFile, start: string, end: string): { e: number; n: number; v: number }[] {
  const pts: { e: number; n: number; v: number }[] = [];
  const dayKeys = Object.keys(rolling.days).filter((d) => d >= start && d <= end).sort();
  if (dayKeys.length === 0) return pts;
  for (const [id, st] of Object.entries(rolling.stations)) {
    let sum = 0;
    let present = 0;
    for (const d of dayKeys) {
      const v = rolling.days[d]?.[id];
      if (v !== undefined) {
        sum += v;
        present++;
      }
    }
    if (present / dayKeys.length < MIN_PRESENCE) continue;
    const [e, n] = to3006([st.lon, st.lat]);
    pts.push({ e, n, v: sum });
  }
  return pts;
}

// Exponera rå rolling-fil + ackumulering + grid-interpolation för optimal-zone.ts
export async function getRollingRaw(): Promise<RollingFile> {
  return getRolling();
}
const accumulate = accumulateWindow;
export { accumulate };
export function interpPointsToGrid(pts: { e: number; n: number; v: number }[]): Float32Array {
  return interpField(pts);
}
export const RAIN_GRID_W = W;
export const RAIN_GRID_H = H;

// Dygns-min temperatur senaste 48 h (Metobs parameter 1, timvärden) på 0.5°-grid, 6h-cache.
const TEMP_PARAM = "1";
const minTempCache = new Map<string, { at: number; min48: number | null }>();
export async function minTempLast48hAt(lat: number, lon: number, asOf: Date): Promise<number | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${asOf.toISOString().slice(0, 10)}`;
  const c = minTempCache.get(key);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.min48;
  try {
    const stations = (await fetchJson(`${METOBS}/parameter/${TEMP_PARAM}.json`, 40000)) as {
      station?: { key: unknown; summary?: string; active?: boolean }[];
    };
    const all: { id: string; lat: number; lon: number }[] = [];
    for (const s of stations.station ?? []) {
      const m = /Latitud:\s*(-?[\d.]+)\s+Longitud:\s*(-?[\d.]+)/.exec(s.summary ?? "");
      if (m && s.active !== false) all.push({ id: String(s.key), lat: Number(m[1]), lon: Number(m[2]) });
    }
    const cosLat = Math.cos((lat * Math.PI) / 180);
    all.sort((a, b) => (a.lat - lat) ** 2 + ((a.lon - lon) * cosLat) ** 2 - ((b.lat - lat) ** 2 + ((b.lon - lon) * cosLat) ** 2));
    const st = all[0];
    if (!st) return null;
    const j = (await fetchJson(`${METOBS}/parameter/${TEMP_PARAM}/station/${st.id}/period/latest-months/data.json`)) as {
      value?: { to?: number; value?: string }[];
    };
    const cutoff = asOf.getTime() - 48 * 3600 * 1000;
    let min = Infinity;
    for (const v of j.value ?? []) {
      if (v.to !== undefined && v.to >= cutoff && v.to <= asOf.getTime()) {
        const t = Number(v.value);
        if (Number.isFinite(t) && t < min) min = t;
      }
    }
    const min48 = min === Infinity ? null : min;
    minTempCache.set(key, { at: Date.now(), min48 });
    return min48;
  } catch {
    return null;
  }
}

async function buildManifest(requestedDays: number): Promise<Manifest> {
  const days = ALLOWED_DAYS.includes(requestedDays as (typeof ALLOWED_DAYS)[number])
    ? requestedDays
    : DEFAULT_DAYS;
  const rolling = await getRolling();
  const dayKeys = Object.keys(rolling.days).sort();
  const latest = dayKeys[dayKeys.length - 1];
  if (!latest) throw new Error("rolling-42d.json är tom");
  const actualDays = Math.min(days, dayKeys.length);
  const startDate = addDays(latest, -(actualDays - 1));
  const nFrames = FRAMES_PER_DAYS[days] ?? FRAMES_PER_DAYS[DEFAULT_DAYS];

  const framesDir = path.join(DIR, `${days}d`);
  await fsp.mkdir(framesDir, { recursive: true });
  const frames: FrameMeta[] = [];
  const keepIds = new Set<string>();
  for (let k = 1; k <= nFrames; k++) {
    const endOffset = Math.round((k * actualDays) / nFrames) - 1; // 0-baserat, sista = actualDays-1
    const end = addDays(startDate, Math.min(endOffset, actualDays - 1));
    const span = Math.round((new Date(end + "T12:00:00Z").getTime() - new Date(startDate + "T12:00:00Z").getTime()) / dayMs) + 1;
    const pts = accumulate(rolling, startDate, end);
    if (pts.length < 30) continue;
    const field = interpField(pts);
    let maxMm = 0;
    for (const v of field) if (v > maxMm) maxMm = v;
    const id = `${compactDay(end)}-acc${span}d-${hash8(startDate + ":" + end + ":" + pts.length + ":" + maxMm.toFixed(3))}`;
    keepIds.add(id + ".png");
    const file = path.join(framesDir, `${id}.png`);
    if (!fs.existsSync(file)) {
      const seed = parseInt(hash8(id).slice(0, 8), 16);
      await fsp.writeFile(file, renderFrame(field, span, seed));
    }
    const isLast = k === nFrames;
    frames.push({
      id,
      startDate,
      endDate: end,
      daysAcc: span,
      daysAgoEnd: Math.round((new Date(latest + "T12:00:00Z").getTime() - new Date(end + "T12:00:00Z").getTime()) / dayMs),
      label: labelFor(startDate, end, isLast ? ` (${span} d)` : ""),
      maxMm: Number(maxMm.toFixed(1)),
      url: `/api/v1/weather/rain-history/frame/${id}.png`,
    });
    console.log(`rain frame ${id} ${startDate}..${end} (${span}d) max=${maxMm.toFixed(1)}mm ${pts.length} stn`);
  }
  // rensa gamla PNG:er från tidigare referenceTime så disken inte växer
  try {
    for (const f of await fsp.readdir(framesDir)) {
      if (f.endsWith(".png") && !keepIds.has(f)) await fsp.unlink(path.join(framesDir, f)).catch(() => {});
    }
  } catch {}
  if (frames.length === 0) throw new Error("inga rain-frames byggda");

  const manifest: Manifest = {
    updatedAt: new Date().toISOString(),
    referenceTime: latest,
    requestedDays: days,
    spanDays: actualDays,
    mode: "accumulated",
    stationCount: Object.keys(rolling.stations).length,
    bounds: [RAIN_BOUNDS.minLon, RAIN_BOUNDS.minLat, RAIN_BOUNDS.maxLon, RAIN_BOUNDS.maxLat],
    width: W,
    height: H,
    attribution: "Nederbörd: SMHI öppna data (Metobs), CC BY 4.0 — © SMHI",
    frames,
  };
  const outPath = path.join(DIR, `manifest-${days}d.json`);
  await fsp.writeFile(outPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function getRainManifest(requestedDays = DEFAULT_DAYS): Promise<Manifest> {
  const days = ALLOWED_DAYS.includes(requestedDays as (typeof ALLOWED_DAYS)[number]) ? requestedDays : DEFAULT_DAYS;
  const c = manifestCaches.get(days);
  if (c && Date.now() - c.at < REFRESH_MS) return c.manifest;
  const inf = manifestInflight.get(days);
  if (inf) return inf;
  const p = (async () => {
    try {
      return await buildManifest(days);
    } catch (e) {
      try {
        const disk = JSON.parse(await fsp.readFile(path.join(DIR, `manifest-${days}d.json`), "utf8")) as Manifest;
        manifestCaches.set(days, { at: Date.now() - REFRESH_MS + 60000, manifest: disk });
        return disk;
      } catch {
        throw e;
      }
    } finally {
      manifestInflight.delete(days);
    }
  })();
  manifestInflight.set(days, p);
  const m = await p;
  manifestCaches.set(days, { at: Date.now(), manifest: m });
  return m;
}

export async function getRainFrame(id: string): Promise<Buffer | null> {
  if (!/^\d{8}-acc\d+d-[0-9a-f]{8}$/.test(id)) return null;
  // försök alla spann-kataloger
  for (const d of ALLOWED_DAYS) {
    try {
      return await fsp.readFile(path.join(DIR, `${d}d`, `${id}.png`));
    } catch {}
  }
  return null;
}

// ---------- live-rutnät: sampleRainForLive (kopplar regnkarta 1-till-1 till Live-score) ----------
// Fyra förinterpolerade Float32-rutnät (256x320) för 14/21/28/42 dagar ur rolling-42d.json,
// plus per-spann flush-rutnät (artgruppens "viktigaste flush-period", dagar bakåt) och
// recent-rutnät (senaste 5 dygn = nylig ytfukt).
type RainGrid = { field: Float32Array; startDate: string; latest: string; days: number };
// flush-fönster [start, end] dagar bakåt per spann: 14d -> 3..10, 21d -> 5..16, 28d -> 7..24, 42d -> 10..40
const FLUSH_WINDOW: Record<number, [number, number]> = {
  14: [3, 10],
  21: [5, 16],
  28: [7, 24],
  42: [10, 40],
};
const RECENT_DAYS = 5;
// flush vägs 75 % mot 25 % nylig ytfukt i den effektiva veckodosen
const FLUSH_WEIGHT = 0.75;

let rainGrids: Map<number, RainGrid> | null = null;
let flushGrids: Map<number, Float32Array> | null = null;
let recentGrid: Float32Array | null = null;

export function rainGridsAvailable(): boolean {
  return rainGrids !== null && rainGrids.size > 0;
}

function buildGrids(rolling: RollingFile): void {
  const dayKeys = Object.keys(rolling.days).sort();
  const latest = dayKeys[dayKeys.length - 1];
  if (!latest) return;
  const grids = new Map<number, RainGrid>();
  const flushes = new Map<number, Float32Array>();
  for (const D of ALLOWED_DAYS) {
    const actualDays = Math.min(D, dayKeys.length);
    const start = addDays(latest, -(actualDays - 1));
    const pts = accumulate(rolling, start, latest);
    if (pts.length < 30) continue;
    grids.set(D, { field: interpField(pts), startDate: start, latest, days: actualDays });
    // artgruppens flush-fönster för detta spann
    const [fs, fe] = FLUSH_WINDOW[D];
    const fStart = addDays(latest, -Math.min(fe, actualDays - 1));
    const fEnd = addDays(latest, -fs);
    const fPts = accumulate(rolling, fStart, fEnd);
    if (fPts.length >= 30) flushes.set(D, interpField(fPts));
  }
  const recentPts = accumulate(rolling, addDays(latest, -(RECENT_DAYS - 1)), latest);
  recentGrid = recentPts.length >= 30 ? interpField(recentPts) : null;
  rainGrids = grids;
  flushGrids = flushes;
}

// Bygg rutnäten när rolling-filen uppdateras (anropas från getRolling).
export async function warmRainGrids(): Promise<void> {
  buildGrids(await getRolling());
}

function sampleField(field: Float32Array, lat: number, lon: number): number {
  const [minE, maxN] = to3006([RAIN_BOUNDS.minLon, RAIN_BOUNDS.maxLat]);
  const [maxE, minN] = to3006([RAIN_BOUNDS.maxLon, RAIN_BOUNDS.minLat]);
  const [e, n] = to3006([lon, lat]);
  const fx = ((e - minE) / (maxE - minE)) * W - 0.5;
  const fy = ((maxN - n) / (maxN - minN)) * H - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : field[y * W + x]);
  const v =
    at(x0, y0) * (1 - tx) * (1 - ty) +
    at(x0 + 1, y0) * tx * (1 - ty) +
    at(x0, y0 + 1) * (1 - tx) * ty +
    at(x0 + 1, y0 + 1) * tx * ty;
  return Math.max(0, v);
}

// Kontinuerlig regnkurva på mm/vecka: torkstraff <3, ramp 3–15, flush-boost 15–35,
// platt 35–65, mjuk avtrappning >65 mot 0.92.
export function rainFactorCurve(mmPerWeek: number): number {
  if (mmPerWeek < 3) return 0.3 + 0.15 * (mmPerWeek / 3);
  if (mmPerWeek < 15) return 0.45 + 0.55 * ((mmPerWeek - 3) / 12);
  if (mmPerWeek < 35) return 1.0 + 0.18 * ((mmPerWeek - 15) / 20);
  if (mmPerWeek <= 65) return 1.18;
  return 1.18 + (0.92 - 1.18) * smoothstep((mmPerWeek - 65) / 35);
}

export type RainLiveSample = {
  totalMm: number;
  flushMm: number;
  recentMm: number;
  mmPerWeek: number;
  effMmPerWeek: number;
  flushWindow: [number, number];
  factor: number;
  available: boolean;
  windowDays: number;
};

export function sampleRainForLive(
  lat: number,
  lon: number,
  windowDays: 14 | 21 | 28 | 42,
): RainLiveSample {
  const D = (ALLOWED_DAYS as readonly number[]).includes(windowDays) ? windowDays : DEFAULT_DAYS;
  const g = rainGrids?.get(D);
  const flushWindow = FLUSH_WINDOW[D];
  if (!g) {
    return {
      totalMm: 0, flushMm: 0, recentMm: 0, mmPerWeek: 0, effMmPerWeek: 0,
      flushWindow, factor: 1, available: false, windowDays: D,
    };
  }
  const totalMm = sampleField(g.field, lat, lon);
  const mmPerWeek = totalMm / (g.days / 7);
  const flushMm = flushGrids?.get(D) ? sampleField(flushGrids.get(D)!, lat, lon) : 0;
  const recentMm = recentGrid ? sampleField(recentGrid, lat, lon) : 0;
  // effektiv veckodos: 75 % flush-fönstrets dos + 25 % nylig ytfukt (0–4 d)
  const flushDays = flushWindow[1] - flushWindow[0] + 1;
  const effMmPerWeek =
    FLUSH_WEIGHT * (flushMm / (flushDays / 7)) + (1 - FLUSH_WEIGHT) * (recentMm / (RECENT_DAYS / 7));
  return {
    totalMm: Number(totalMm.toFixed(1)),
    flushMm: Number(flushMm.toFixed(1)),
    recentMm: Number(recentMm.toFixed(1)),
    mmPerWeek: Number(mmPerWeek.toFixed(2)),
    effMmPerWeek: Number(effMmPerWeek.toFixed(2)),
    flushWindow,
    factor: Number(rainFactorCurve(effMmPerWeek).toFixed(3)),
    available: true,
    windowDays: D,
  };
}
