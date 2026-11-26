// clouds.ts — live molnprognos (SMHI SNOW1gv1) bakad till små alpha-PNG-frames över Sverige.
//
// Var 30:e minut (eller vid första anrop): hämta punktprognos (tider) -> hämta multipoint
// cloud_area_fraction + precipitation_amount_mean_deterministic för 8–12 validTimes
// (nu .. +24h i 2h-steg), med downsample=10 (~25 km grid). Rasterisera till 160x200 över
// Sverige-rutan [10.5, 55.0, 24.5, 69.5], gauss-blur + brus, PNG (alpha = molntäckning,
// slate-blue ton där det regnar). Cachas i minne + på disk (data/clouds/) — vid
// SMHI-fel serveras senaste goda cache.
//
// Licens: SMHI öppna data CC BY 4.0 (© SMHI) — attribuering i appen.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOUDS_DIR = path.join(here, "..", "data", "clouds");
const FRAMES_DIR = path.join(CLOUDS_DIR, "frames");

const METFCST = "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1";
// Sverige-rutan som moln-rastren täcker (samma som SWEDEN_BBOX i server.ts)
export const CLOUD_BOUNDS = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const W = 160;
const H = 200;
const DOWNSAMPLE = 4; // ~10 km grid — tätare än vår 160x200-ruta (~6–10 km/px), annars blir splat blockig
const FRAME_STEP_H = 2;
const FRAME_HORIZON_H = 24;
const MAX_FRAMES = 12;
const REFRESH_MS = 30 * 60 * 1000;

const PARAM_CLOUD = "cloud_area_fraction"; // oktas 0–8
const PARAM_RAIN = "precipitation_amount_mean_deterministic"; // kg/m2 per timme (avg_tprate)

type Frame = { id: string; validTime: string; offsetHours: number; label: string; file: string };
type Manifest = {
  updatedAt: string;
  referenceTime: string | null;
  bounds: [number, number, number, number];
  width: number;
  height: number;
  attribution: string;
  frames: { id: string; validTime: string; offsetHours: number; label: string; url: string }[];
};

let manifestCache: { at: number; manifest: Manifest } | null = null;
let manifestPromise: Promise<Manifest> | null = null;
let geoCache: { at: number; coords: [number, number][] } | null = null;

const compactTime = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const hash8 = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

async function fetchJson(url: string, timeoutMs = 45000): Promise<unknown> {
  const r = await fetch(url, {
    headers: { "accept-encoding": "gzip", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`SMHI ${url} -> HTTP ${r.status}`);
  return r.json();
}

// Tider från punktprognos (Stockholm) — samma giltiga tider gäller för multipoint.
async function fetchTimes(): Promise<{ referenceTime: string; times: string[] }> {
  const j = (await fetchJson(
    `${METFCST}/geotype/point/lon/18.0686/lat/59.3293/data.json?parameters=${PARAM_CLOUD}&timeseries=30`,
  )) as { referenceTime?: string; timeSeries?: { time: string }[] };
  const times = (j.timeSeries ?? []).map((t) => t.time).filter(Boolean);
  if (!j.referenceTime || times.length === 0) throw new Error("SMHI point: saknar referenceTime/timeSeries");
  return { referenceTime: j.referenceTime, times };
}

// Grid-geometrin är statisk per downsample — hämta en gång (med geo), cacha 24 h.
async function fetchGeometry(): Promise<[number, number][]> {
  if (geoCache && Date.now() - geoCache.at < 24 * 3600 * 1000) return geoCache.coords;
  const { times } = await fetchTimes();
  const j = (await fetchJson(
    `${METFCST}/geotype/multipoint/time/${compactTime(times[Math.min(6, times.length - 1)])}/parameter/${PARAM_CLOUD}/data.json?downsample=${DOWNSAMPLE}`,
  )) as { geometry?: { coordinates?: [number, number][] } };
  const coords = j.geometry?.coordinates ?? [];
  if (coords.length < 100) throw new Error(`SMHI multipoint: bara ${coords.length} gridpunkter`);
  geoCache = { at: Date.now(), coords };
  return coords;
}

// Värden (utan geo) för ett validTime + parameter — samma ordning som geometrin.
async function fetchValues(validTime: string, param: string): Promise<number[]> {
  const j = (await fetchJson(
    `${METFCST}/geotype/multipoint/time/${compactTime(validTime)}/parameter/${param}/data.json?with-geo=false&downsample=${DOWNSAMPLE}`,
  )) as { timeSeries?: { time: string; data?: Record<string, number[]> }[] };
  const ts = (j.timeSeries ?? []).find((t) => t.time === validTime) ?? j.timeSeries?.[0];
  const vals = ts?.data?.[param];
  if (!vals || !Array.isArray(vals)) throw new Error(`SMHI multipoint: parameter ${param} saknas för ${validTime}`);
  return vals.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
}

// ---- rasterisering ----
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fyll mål-rutnätet genom forward-splat (medelvärde per målcell), sedan saknade celler
// fylls med närmaste grannar.
function splat(coords: [number, number][], values: number[], rain: number[]): {
  cloud: Float32Array;
  rain: Float32Array;
  hits: Uint16Array;
} {
  const cloud = new Float32Array(W * H);
  const rainA = new Float32Array(W * H);
  const hits = new Uint16Array(W * H);
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (lon < CLOUD_BOUNDS.minLon || lon > CLOUD_BOUNDS.maxLon || lat < CLOUD_BOUNDS.minLat || lat > CLOUD_BOUNDS.maxLat) continue;
    const gx = Math.min(W - 1, Math.max(0, Math.floor(((lon - CLOUD_BOUNDS.minLon) / (CLOUD_BOUNDS.maxLon - CLOUD_BOUNDS.minLon)) * W)));
    const gy = Math.min(H - 1, Math.max(0, Math.floor(((CLOUD_BOUNDS.maxLat - lat) / (CLOUD_BOUNDS.maxLat - CLOUD_BOUNDS.minLat)) * H)));
    const k = gy * W + gx;
    cloud[k] += values[i] ?? 0;
    rainA[k] += rain[i] ?? 0;
    hits[k]++;
  }
  for (let k = 0; k < W * H; k++) {
    if (hits[k] > 0) {
      cloud[k] /= hits[k];
      rainA[k] /= hits[k];
    }
  }
  // fyll tomma celler med medel av grannar (2 omgångar)
  for (let pass = 0; pass < 2; pass++) {
    const c2 = cloud.slice();
    const r2 = rainA.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (hits[k] > 0) continue;
        let sc = 0, sr = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const kk = yy * W + xx;
            if (hits[kk] > 0) {
              sc += c2[kk];
              sr += r2[kk];
              n++;
            }
          }
        }
        if (n > 0) {
          cloud[k] = sc / n;
          rainA[k] = sr / n;
          hits[k] = 1;
        }
      }
    }
  }
  return { cloud, rain: rainA, hits };
}

function gaussBlur(src: Float32Array, radius = 2, sigma = 1.1): Float32Array {
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const xx = Math.min(W - 1, Math.max(0, x + i));
        acc += src[y * W + xx] * kernel[i + radius];
      }
      tmp[y * W + x] = acc;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const yy = Math.min(H - 1, Math.max(0, y + i));
        acc += tmp[yy * W + x] * kernel[i + radius];
      }
      out[y * W + x] = acc;
    }
  }
  return out;
}

// Mjukt brus (lågupplöst slump som bilinjärt skalas upp) — molnkanter ser naturliga ut.
function noiseField(seed: number): Float32Array {
  const rng = mulberry32(seed);
  const gw = 20;
  const gh = 25;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = (x / W) * (gw - 1);
      const fy = (y / H) * (gh - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const a = g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx;
      const b = g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx;
      out[y * W + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function renderFramePNG(cloud: Float32Array, rain: Float32Array, seed: number): Buffer {
  const blurred = gaussBlur(cloud, 3, 1.6);
  const noise = noiseField(seed);
  const png = new PNG({ width: W, height: H });
  for (let k = 0; k < W * H; k++) {
    const cover = Math.min(1, Math.max(0, blurred[k] / 8)); // oktas 0–8 -> 0..1
    const n = 0.85 + 0.3 * noise[k]; // wispy modulation
    const alpha = Math.round(Math.min(1, Math.pow(cover, 0.9) * n) * 235);
    // vitt moln, slate-blue ton där det regnar (avg_tprate kg/m2/h)
    const rt = Math.min(1, rain[k] / 2);
    const rC = Math.round(242 + (110 - 242) * rt);
    const gC = Math.round(246 + (135 - 246) * rt);
    const bC = Math.round(250 + (168 - 250) * rt);
    const o = k * 4;
    png.data[o] = rC;
    png.data[o + 1] = gC;
    png.data[o + 2] = bC;
    png.data[o + 3] = alpha;
  }
  return PNG.sync.write(png, { deflateLevel: 9 });
}

function labelFor(validTime: string, now: Date): { label: string; offsetHours: number } {
  const t = new Date(validTime);
  const offsetHours = Math.round((t.getTime() - now.getTime()) / 3600000);
  const wd = new Intl.DateTimeFormat("sv-SE", { weekday: "short", timeZone: "Europe/Stockholm" }).format(t);
  const hh = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", hour12: false, timeZone: "Europe/Stockholm" }).format(t);
  return { label: `${wd} ${hh}:00`, offsetHours };
}

async function buildManifest(): Promise<Manifest> {
  await fsp.mkdir(FRAMES_DIR, { recursive: true });
  const now = new Date();
  const { referenceTime, times } = await fetchTimes();
  const coords = await fetchGeometry();

  // välj 8–12 frames: nu (första timme framåt) .. +24h i 2h-steg
  const nowMs = now.getTime();
  const future = times
    .map((t) => new Date(t).getTime())
    .filter((ms) => ms >= nowMs - 30 * 60 * 1000)
    .sort((a, b) => a - b);
  const picked: number[] = [];
  for (const ms of future) {
    if (picked.length === 0 || ms - picked[picked.length - 1] >= FRAME_STEP_H * 3600 * 1000 - 5 * 60 * 1000) {
      picked.push(ms);
    }
    if (ms - nowMs > FRAME_HORIZON_H * 3600 * 1000) break;
    if (picked.length >= MAX_FRAMES) break;
  }
  if (picked.length === 0) throw new Error("SMHI: inga framtida tidssteg");

  const refHash = hash8(referenceTime);
  const frames: Frame[] = [];
  for (const ms of picked) {
    const validTime = new Date(ms).toISOString();
    try {
      const [cloudVals, rainVals] = await Promise.all([
        fetchValues(validTime, PARAM_CLOUD),
        fetchValues(validTime, PARAM_RAIN).catch(() => new Array(coords.length).fill(0)),
      ]);
      const id = `${compactTime(validTime)}-${refHash}`;
      const file = path.join(FRAMES_DIR, `${id}.png`);
      const { cloud, rain } = splat(coords, cloudVals.slice(0, coords.length), rainVals.slice(0, coords.length));
      const seed = parseInt(hash8(id).slice(0, 8), 16);
      const png = renderFramePNG(cloud, rain, seed);
      await fsp.writeFile(file, png);
      const { label, offsetHours } = labelFor(validTime, now);
      frames.push({ id, validTime, offsetHours, label, file });
      console.log(`cloud frame ${id} ${label} ${(png.length / 1024).toFixed(1)} kB`);
    } catch (e) {
      console.error(`cloud frame ${validTime} fail:`, (e as Error).message);
    }
  }
  if (frames.length === 0) throw new Error("SMHI: inga moln-frames kunde byggas");

  const manifest: Manifest = {
    updatedAt: now.toISOString(),
    referenceTime,
    bounds: [CLOUD_BOUNDS.minLon, CLOUD_BOUNDS.minLat, CLOUD_BOUNDS.maxLon, CLOUD_BOUNDS.maxLat],
    width: W,
    height: H,
    attribution: "Molnprognos: SMHI öppna data (SNOW1gv1), CC BY 4.0 — © SMHI",
    frames: frames.map((f) => ({ id: f.id, validTime: f.validTime, offsetHours: f.offsetHours, label: f.label, url: `/api/v1/weather/clouds/frame/${f.id}.png` })),
  };
  await fsp.writeFile(path.join(CLOUDS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  manifestCache = { at: Date.now(), manifest };
  return manifest;
}

// Läs manifest: från minne/disk-cache, bygg nytt om det är äldre än 30 min (eller saknas).
// Vid byggfel: fall tillbaka på senast sparade disk-manifest.
export async function getCloudManifest(): Promise<Manifest> {
  if (manifestCache && Date.now() - manifestCache.at < REFRESH_MS) return manifestCache.manifest;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      return await buildManifest();
    } catch (e) {
      console.error("cloud manifest build failed, försöker disk-cache:", (e as Error).message);
      try {
        const disk = JSON.parse(await fsp.readFile(path.join(CLOUDS_DIR, "manifest.json"), "utf8")) as Manifest;
        manifestCache = { at: Date.now() - REFRESH_MS + 60000, manifest: disk }; // tillåt ombyggnad om 60 s
        return disk;
      } catch {
        manifestCache = null;
        throw e;
      }
    } finally {
      manifestPromise = null;
    }
  })();
  return manifestPromise;
}

export async function getCloudFrame(id: string): Promise<Buffer | null> {
  const safe = /^[0-9TZ]+-[0-9a-f]{8}$/.test(id) ? id : null;
  if (!safe) return null;
  const p = path.join(FRAMES_DIR, `${safe}.png`);
  try {
    return await fsp.readFile(p);
  } catch {
    // inte på disk än — bygg om hela manifestet (kan ha rensats) och försök igen
    try {
      await getCloudManifest();
      return await fsp.readFile(p);
    } catch {
      return null;
    }
  }
}

// Töm cache (test/dev).
export function resetCloudCache(): void {
  manifestCache = null;
  geoCache = null;
  manifestPromise = null;
  void fs;
}
