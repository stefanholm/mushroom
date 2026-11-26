// rain-history.ts — rullande 7-dagars UPPMÄTT regnhistorik (SMHI Metobs parameter 5,
// "Nederbördsmängd, summa 1 dygn", CC BY 4.0) bakad till bandningsfria 256x320 RGBA-PNG-frames
// över Sverige. Samma manifest/frame-kontrakt som molnen (src/clouds.ts) så iOS kan byta
// endpoint utan större patch.
//
// 11 frames i 2-dagarssteg över de senaste 20 dagarna: frame i visar summan mm under
// [endDate-6d .. endDate], endDate = senaste kompletta dygnet - (20-2i) dagar.
// Saknar en station någon dag i fönstret -> stationen skippas för just den framen.
//
// Interpolation: gaussisk kärna sigma=48 km viktad IDW + avståndsdämpning
// decay=exp(-(minDist/75km)^2) så områden långt från svenska stationer (Norge/Fjällen,
// Östersjön, Finland, söder om Skåne) tonar till alpha=0 utan rektangulär kant, plus
// 15% smoothstep-feather mot quadens kant. Kontinuerlig ramp + ±0.5 LSB dithering.
//
// Cache: minne + disk (data/rain-history/), uppdateras max var 6:e timme; vid SMHI-fel
// serveras senaste goda cache.

import fsp from "node:fs/promises";
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
const FRAMES_DIR = path.join(DIR, "frames");

const METOBS = "https://opendata-download-metobs.smhi.se/api/version/latest";
const PARAM = "5"; // nederbörd summa 1 dygn (mm)

export const RAIN_BOUNDS = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const W = 256;
const H = 320;
const WINDOW_DAYS = 7;
const SPAN_DAYS = 20;
const FRAME_STEP_DAYS = 2;
const N_FRAMES = 11;
const REFRESH_MS = 6 * 3600 * 1000;
const SIGMA_M = 48_000; // gaussisk kärna
const DECAY_M = 75_000; // avståndsdämpning mot närmaste station
const MAX_INTERP_M = 160_000; // längre än så till närmaste station -> alpha 0
const CONCURRENCY = 14;

// utökat urvalsområde (inkl. gränsstationer) så Sverige får täckning även vid kanterna
const SELECT_BOUNDS = { minLon: 10.0, minLat: 54.5, maxLon: 25.0, maxLat: 70.0 };
const CELL_DEG = 0.7; // ~78 km latitud-ruta; 1 station per ruta (landet ger ~150–200 stn)
const MAX_PER_CELL = 1;
const MAX_DAILY_MM = 150; // metobs-fel/ackumulerade värden över detta behandlas som saknad dag

type Station = { id: string; lat: number; lon: number; e: number; n: number; days: Map<string, number> };
type FrameMeta = {
  id: string; startDate: string; endDate: string; daysAgoEnd: number;
  label: string; maxMm: number; url: string;
};
type Manifest = {
  updatedAt: string;
  referenceTime: string;
  windowDays: number;
  spanDays: number;
  stationCount: number;
  bounds: [number, number, number, number];
  width: number;
  height: number;
  attribution: string;
  frames: FrameMeta[];
};

let cache: { at: number; manifest: Manifest } | null = null;
let inflight: Promise<Manifest> | null = null;
let stationDataCache: { at: number; stations: Station[]; endDate: string } | null = null;

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

// ---------- stationsurval ----------
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
  // tunna ut: max MAX_PER_CELL per CELL_DEG-ruta
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

async function loadStations(): Promise<{ stations: Station[]; endDate: string }> {
  if (stationDataCache && Date.now() - stationDataCache.at < REFRESH_MS) return stationDataCache;
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
  const stations: Station[] = [];
  let endDate = "";
  for (let i = 0; i < picked.length; i++) {
    const days = daysList[i];
    if (days.size < 20) continue; // för kort historik — kasta
    const [e, n] = to3006([picked[i].lon, picked[i].lat]);
    stations.push({ id: picked[i].id, lat: picked[i].lat, lon: picked[i].lon, e, n, days });
    for (const d of days.keys()) if (d > endDate) endDate = d;
  }
  if (stations.length < 40) throw new Error(`för få stationer med data: ${stations.length}`);
  if (!endDate) throw new Error("ingen endDate från Metobs");
  stationDataCache = { at: Date.now(), stations, endDate };
  // disk-cache
  try {
    await fsp.mkdir(DIR, { recursive: true });
    const slim = stations.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, days: [...s.days] }));
    await fsp.writeFile(path.join(DIR, "stations.json"), JSON.stringify({ at: Date.now(), endDate, stations: slim }));
  } catch {}
  console.log(`rain-history: ${stations.length} stationer, senaste dygn ${endDate}`);
  return stationDataCache;
}

// ---------- 7-dagars fönster ----------
function windowSum(days: Map<string, number>, end: string): number | null {
  let sum = 0;
  for (let k = WINDOW_DAYS - 1; k >= 0; k--) {
    const d = addDays(end, -k);
    const v = days.get(d);
    if (v === undefined) return null; // saknad dag -> skippa stationen för framen
    sum += v;
  }
  return sum;
}

// ---------- interpolation ----------
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
      // närsta station
      let minD2 = Infinity;
      for (const s of stations) {
        const d2 = (s.e - e) * (s.e - e) + (s.n - n) * (s.n - n);
        if (d2 < minD2) minD2 = d2;
      }
      const minD = Math.sqrt(minD2);
      if (minD > MAX_INTERP_M) continue; // utanför täckning -> alpha 0
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

// ---------- färg/alfa + dithering ----------
// akvarell-skala: 0-4 mm transparent; 4-15 ljus skiffer; 15-35 akvarell blågrönt (svampregn);
// 35-75+ djup skifferblå kärna. Helt kontinuerlig i flyttal, ±0.5 LSB dither före 8-bit.
const STOPS: [mm: number, r: number, g: number, b: number, a: number][] = [
  [0, 190, 200, 210, 0],
  [4, 190, 200, 210, 0],
  [15, 152, 178, 188, 0.26],
  [35, 110, 165, 155, 0.54],
  [75, 70, 95, 125, 0.74],
  [1e9, 70, 95, 125, 0.74],
];

function ramp(mm: number): [number, number, number, number] {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [m0, r0, g0, b0, a0] = STOPS[i];
    const [m1, r1, g1, b1, a1] = STOPS[i + 1];
    if (mm <= m1) {
      const t = m1 === m0 ? 0 : (mm - m0) / (m1 - m0);
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
// deterministisk brus per pixel+frame (±0.5 LSB dither)
const dither = (x: number, y: number, seed: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return (s - Math.floor(s)) - 0.5;
};

function renderFrame(field: Float32Array, seed: number): Buffer {
  const png = new PNG({ width: W, height: H });
  const feather = 0.15;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const mm = field[k];
      const [r, g, b, a] = ramp(mm);
      // 15% smoothstep-feather mot quadens ytterkanter
      const fx = smoothstep(Math.min(x / W, (W - 1 - x) / W) / feather);
      const fy = smoothstep(Math.min(y / H, (H - 1 - y) / H) / feather);
      let alpha = a * fx * fy;
      if (alpha <= 0.008) {
        // under ~2/255 även efter dither -> helt transparent (ytterkanten blir exakt alpha=0)
        const o = k * 4;
        png.data[o + 3] = 0;
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

function labelFor(startDay: string, endDay: string): string {
  const f = (d: string) => {
    const dt = new Date(d + "T12:00:00Z");
    const day = dt.getUTCDate();
    const mon = new Intl.DateTimeFormat("sv-SE", { month: "short", timeZone: "UTC" }).format(dt).replace(/\.$/, "");
    return `${day} ${mon}`;
  };
  return `${f(startDay)}–${f(endDay)}`;
}

async function buildManifest(): Promise<Manifest> {
  await fsp.mkdir(FRAMES_DIR, { recursive: true });
  const { stations, endDate } = await loadStations();
  const frames: FrameMeta[] = [];
  for (let i = 0; i < N_FRAMES; i++) {
    const daysAgoEnd = SPAN_DAYS - i * FRAME_STEP_DAYS;
    const end = addDays(endDate, -daysAgoEnd);
    const start = addDays(end, -(WINDOW_DAYS - 1));
    const pts: { e: number; n: number; v: number }[] = [];
    for (const s of stations) {
      const sum = windowSum(s.days, end);
      if (sum !== null) pts.push({ e: s.e, n: s.n, v: sum });
    }
    if (pts.length < 30) {
      console.error(`rain frame ${end}: för få stationer (${pts.length}), hoppar över`);
      continue;
    }
    const field = interpField(pts);
    let maxMm = 0;
    for (const v of field) if (v > maxMm) maxMm = v;
    const id = `${compactDay(end)}-7d-${hash8(end + ":" + pts.length + ":" + maxMm.toFixed(3))}`;
    const seed = parseInt(hash8(id).slice(0, 8), 16);
    const png = renderFrame(field, seed);
    await fsp.writeFile(path.join(FRAMES_DIR, `${id}.png`), png);
    frames.push({
      id,
      startDate: start,
      endDate: end,
      daysAgoEnd,
      label: labelFor(start, end),
      maxMm: Number(maxMm.toFixed(1)),
      url: `/api/v1/weather/rain-history/frame/${id}.png`,
    });
    console.log(`rain frame ${id} ${start}..${end} max=${maxMm.toFixed(1)}mm ${(png.length / 1024).toFixed(1)} kB (${pts.length} stn)`);
  }
  if (frames.length === 0) throw new Error("inga rain-frames byggda");
  const manifest: Manifest = {
    updatedAt: new Date().toISOString(),
    referenceTime: endDate,
    windowDays: WINDOW_DAYS,
    spanDays: SPAN_DAYS,
    stationCount: stations.length,
    bounds: [RAIN_BOUNDS.minLon, RAIN_BOUNDS.minLat, RAIN_BOUNDS.maxLon, RAIN_BOUNDS.maxLat],
    width: W,
    height: H,
    attribution: "Nederbörd: SMHI öppna data (Metobs), CC BY 4.0 — © SMHI",
    frames,
  };
  await fsp.writeFile(path.join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  cache = { at: Date.now(), manifest };
  return manifest;
}

export async function getRainManifest(): Promise<Manifest> {
  if (cache && Date.now() - cache.at < REFRESH_MS) return cache.manifest;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return await buildManifest();
    } catch (e) {
      console.error("rain manifest build failed, disk-cache:", (e as Error).message);
      try {
        const disk = JSON.parse(await fsp.readFile(path.join(DIR, "manifest.json"), "utf8")) as Manifest;
        cache = { at: Date.now() - REFRESH_MS + 60000, manifest: disk };
        return disk;
      } catch {
        cache = null;
        throw e;
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getRainFrame(id: string): Promise<Buffer | null> {
  if (!/^\d{8}-7d-[0-9a-f]{8}$/.test(id)) return null;
  const p = path.join(FRAMES_DIR, `${id}.png`);
  try {
    return await fsp.readFile(p);
  } catch {
    try {
      await getRainManifest();
      return await fsp.readFile(p);
    } catch {
      return null;
    }
  }
}
