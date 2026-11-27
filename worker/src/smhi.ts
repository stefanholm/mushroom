// SMHI-Cron i Workern: baka moln- och regn-frames + manifests + weather/live.json till R2.
// Samma källor som Node-originen (SNOW1gv1 metfcst + Metobs param 5/1), men lättare grid.
// Obs: detta kan överstiga 10 ms CPU på gratisnivån — då behövs Workers Paid ($5/mån),
// R2-egress är fortfarande 0 kr. Se worker/README.md.
import { encodePng } from "./png.js";
import { getR2Json, putR2Json, putR2Png, r2Prefix } from "./r2.js";
import type { Env } from "./cf-types.js";

const METFCST = "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1";
const METOBS = "https://opendata-download-metobs.smhi.se/api/version/latest";
const BOUNDS = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const CW = 160, CH = 200; // moln-grid
const RW = 256, RH = 320; // regn-grid
const DOWNSAMPLE = 6;
const ALLOWED_DAYS = [14, 21, 28, 42] as const;
const FRAMES_PER_DAYS: Record<number, number> = { 14: 8, 21: 11, 28: 10, 42: 11 };
const STEP_DAYS: Record<number, number> = { 14: 2, 21: 2, 28: 3, 42: 4 };
const SIGMA_M = 48000, DECAY_M = 75000, MAX_INTERP_M = 160000;
const MAX_DAILY_MM = 150;
const MAX_DAYS = 42;

async function fetchJson(url: string, timeoutMs = 40000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "Accept-Encoding": "gzip" } });
    if (!r.ok) throw new Error(`SMHI ${r.status} ${url.slice(0, 90)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
const compactTime = (iso: string) => iso.replace(/[-:TZ]/g, "").slice(0, 12);
const dayOf = (x: string | Date) => (typeof x === "string" ? x : x.toISOString()).slice(0, 10);
const addDays = (day: string, k: number) => dayOf(new Date(new Date(day + "T12:00:00Z").getTime() + k * 86400000));

// --- moln ---
async function bakeClouds(env: Env, prefix: string): Promise<number> {
  const pj = (await fetchJson(`${METFCST}/geotype/point/lon/18.0686/lat/59.3293/data.json?parameters=cloud_area_fraction&timeseries=30`)) as {
    referenceTime?: string; timeSeries?: { time: string }[];
  };
  const times = (pj.timeSeries ?? []).map((t) => t.time).filter(Boolean);
  const referenceTime = pj.referenceTime ?? times[0];
  if (times.length < 4) throw new Error("SMHI: för få molntider");
  // geometri en gång
  const gj = (await fetchJson(`${METFCST}/geotype/multipoint/time/${compactTime(times[Math.min(6, times.length - 1)])}/parameter/cloud_area_fraction/data.json?downsample=${DOWNSAMPLE}`)) as {
    geometry?: { coordinates?: [number, number][] };
  };
  const coords = (gj.geometry?.coordinates ?? []) as [number, number][];
  if (coords.length < 100) throw new Error("SMHI: för få gridpunkter");
  const frames: { id: string; validTime: string; label: string; url: string }[] = [];
  const nFrames = 10;
  const step = Math.max(1, Math.floor((times.length - 1) / (nFrames - 1)));
  for (let fi = 0; fi < nFrames; fi++) {
    const vt = times[Math.min(times.length - 1, fi * step)];
    const vj = (await fetchJson(`${METFCST}/geotype/multipoint/time/${compactTime(vt)}/parameter/cloud_area_fraction/data.json?with-geo=false&downsample=${DOWNSAMPLE}`)) as {
      values?: number[];
    };
    const vals = vj.values ?? [];
    const grid = new Float32Array(CW * CH);
    for (let i = 0; i < Math.min(coords.length, vals.length); i++) {
      const [lon, lat] = coords[i];
      const px = Math.floor(((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * CW);
      const py = Math.floor(((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * CH);
      if (px >= 0 && py >= 0 && px < CW && py < CH) grid[py * CW + px] = Math.max(0, Math.min(8, vals[i])) / 8;
    }
    // 3x3 gauss + lätt brus
    const sm = new Float32Array(CW * CH);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      let s = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= CW || yy >= CH) continue;
        const ww = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
        s += grid[yy * CW + xx] * ww; w += ww;
      }
      sm[y * CW + x] = s / w;
    }
    const rgba = new Uint8Array(CW * CH * 4);
    for (let k = 0; k < CW * CH; k++) {
      const v = Math.max(0, Math.min(1, sm[k] + (Math.sin(k * 12.9898) * 43758.5453 % 1) * 0.06));
      rgba[k * 4] = 245; rgba[k * 4 + 1] = 248; rgba[k * 4 + 2] = 252;
      rgba[k * 4 + 3] = Math.round(Math.pow(v, 1.2) * 0.85 * 255);
    }
    const id = `${compactTime(vt)}-${(referenceTime.replace(/[-:TZ]/g, "") + vals.length).slice(-8)}`;
    await putR2Png(env, `${prefix}/frames/clouds/${id}.png`, await encodePng(CW, CH, rgba));
    frames.push({ id, validTime: vt, label: vt.slice(5, 16).replace("T", " "), url: `/api/v1/weather/clouds/frame/${id}.png` });
  }
  const manifest = {
    updatedAt: new Date().toISOString(),
    referenceTime,
    bounds: [BOUNDS.minLon, BOUNDS.minLat, BOUNDS.maxLon, BOUNDS.maxLat],
    width: CW, height: CH,
    attribution: "Molnprognos: SMHI öppna data (SNOW1gv1), CC BY 4.0 — © SMHI",
    frames,
  };
  await putR2Json(env, `${prefix}/frames/clouds/manifest.json`, manifest);
  return frames.length;
}

// --- regn (Metobs param 5) ---
type Station = { id: string; lat: number; lon: number };
async function pickRainStations(): Promise<Station[]> {
  const j = (await fetchJson(`${METOBS}/parameter/5.json`, 60000)) as {
    station?: { key: unknown; summary?: string; active?: boolean }[];
  };
  const cell = 0.7;
  const byCell = new Map<string, Station>();
  for (const s of j.station ?? []) {
    const m = /Latitud:\s*(-?[\d.]+)\s+Longitud:\s*(-?[\d.]+)/.exec(s.summary ?? "");
    if (!m || s.active === false) continue;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon || lat < BOUNDS.minLat || lat > BOUNDS.maxLat) continue;
    const k = `${Math.floor(lat / cell)}_${Math.floor(lon / cell)}`;
    if (!byCell.has(k)) byCell.set(k, { id: String(s.key), lat, lon });
  }
  return [...byCell.values()];
}
async function fetchStationDays(id: string): Promise<[string, number][]> {
  const j = (await fetchJson(`${METOBS}/parameter/5/station/${id}/period/latest-months/data.json`)) as {
    values?: { ref?: string; value?: number }[];
  };
  return (j.values ?? [])
    .filter((v) => v.ref && typeof v.value === "number" && v.value >= 0 && v.value <= MAX_DAILY_MM)
    .map((v) => [dayOf(v.ref!), v.value!]);
}

// IDW-splat till rutnät (snabb: bara närmaste MAX_INTERP_M)
function splat(pts: { lat: number; lon: number; v: number }[], W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  const wsum = new Float32Array(W * H);
  const sig2 = 2 * SIGMA_M * SIGMA_M, dec2 = 2 * DECAY_M * DECAY_M;
  for (const p of pts) {
    const px = ((p.lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * W;
    const py = ((BOUNDS.maxLat - p.lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * H;
    const rCell = MAX_INTERP_M / (((BOUNDS.maxLon - BOUNDS.minLon) * 111000 * Math.cos((p.lat * Math.PI) / 180)) / W);
    const rCellY = MAX_INTERP_M / (111000 * ((BOUNDS.maxLat - BOUNDS.minLat) / H));
    const r = Math.ceil(Math.max(rCell, rCellY));
    const minD2 = 0; // decay baseras på avstånd till närmaste punkt — approximera med egen cell
    for (let yy = Math.max(0, Math.floor(py - r)); yy <= Math.min(H - 1, Math.ceil(py + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(px - r)); xx <= Math.min(W - 1, Math.ceil(px + r)); xx++) {
        const dLon = (xx + 0.5 - px) * (((BOUNDS.maxLon - BOUNDS.minLon) * 111000 * Math.cos((p.lat * Math.PI) / 180)) / W);
        const dLat = (yy + 0.5 - py) * (111000 * ((BOUNDS.maxLat - BOUNDS.minLat) / H));
        const d2 = dLon * dLon + dLat * dLat;
        if (d2 > MAX_INTERP_M * MAX_INTERP_M) continue;
        const w = Math.exp(-d2 / sig2) * Math.exp(-d2 / dec2);
        out[yy * W + xx] += w * p.v;
        wsum[yy * W + xx] += w;
      }
    }
  }
  for (let k = 0; k < W * H; k++) if (wsum[k] > 1e-9) out[k] /= wsum[k];
  return out;
}

// akvarell-ramp per vecka (samma färger som servern)
function ramp(mmPerWeek: number): [number, number, number, number] {
  const stops: [number, number, number, number, number][] = [
    [0, 42, 132, 178, 0], [3, 42, 132, 178, 0], [10, 24, 96, 168, 107],
    [25, 18, 58, 138, 184], [50, 18, 58, 138, 224], [1e9, 18, 58, 138, 224],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [m0, r0, g0, b0, a0] = stops[i];
    const [m1, r1, g1, b1, a1] = stops[i + 1];
    if (mmPerWeek <= m1) {
      const t = m1 === m0 ? 0 : (mmPerWeek - m0) / (m1 - m0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, a0 + (a1 - a0) * t];
    }
  }
  return [18, 58, 138, 224];
}
function renderRain(field: Float32Array, spanDays: number, seed: number): Promise<Uint8Array> {
  const weeks = spanDays / 7;
  const rgba = new Uint8Array(RW * RH * 4);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const k = y * RW + x;
    const [r, g, b, a] = ramp(field[k] / weeks);
    const fx = Math.min(x / RW, (RW - 1 - x) / RW) / 0.15;
    const fy = Math.min(y / RH, (RH - 1 - y) / RH) / 0.15;
    const feather = Math.min(1, Math.max(0, fx)) * Math.min(1, Math.max(0, fy));
    const alpha = a * feather;
    const o = k * 4;
    if (alpha <= 2) { rgba[o + 3] = 0; continue; }
    const d = (Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453) % 1 * 0.5;
    rgba[o] = Math.max(0, Math.min(255, Math.round(r + d)));
    rgba[o + 1] = Math.max(0, Math.min(255, Math.round(g + d)));
    rgba[o + 2] = Math.max(0, Math.min(255, Math.round(b + d)));
    rgba[o + 3] = Math.max(0, Math.min(255, Math.round(alpha + d)));
  }
  return encodePng(RW, RH, rgba);
}

async function bakeRain(env: Env, prefix: string): Promise<{ spans: number; frames: number }> {
  const stations = await pickRainStations();
  if (stations.length < 20) throw new Error("SMHI: för få regnstationer");
  // hämta dygn parallellt (10 åt gången)
  const days: Record<string, Record<string, number>> = {};
  const stMap: Record<string, { lat: number; lon: number }> = {};
  let done = 0;
  const queue = [...stations];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const st = queue.pop()!;
      stMap[st.id] = { lat: st.lat, lon: st.lon };
      try {
        for (const [d, mm] of await fetchStationDays(st.id)) (days[d] ??= {})[st.id] = mm;
      } catch { /* station nere */ }
      done++;
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));
  const dayKeys = Object.keys(days).sort();
  const latest = dayKeys[dayKeys.length - 1];
  // pruna till max 42 dygn
  const cutoff = addDays(latest, -(MAX_DAYS - 1));
  for (const d of dayKeys) if (d < cutoff) delete days[d];
  const live: { lat: number; lon: number; rain14: number; rain28: number; rain42: number }[] = [];
  let totalFrames = 0;
  for (const daysSpan of ALLOWED_DAYS) {
    const frames: { id: string; endDate: string; daysAgoEnd: number; label: string; maxMm: number; url: string }[] = [];
    const nF = FRAMES_PER_DAYS[daysSpan];
    const step = STEP_DAYS[daysSpan];
    let maxMm = 0;
    for (let fi = 0; fi < nF; fi++) {
      const end = addDays(latest, -(nF - 1 - fi) * step);
      const start = addDays(end, -(daysSpan - 1));
      const pts: { lat: number; lon: number; v: number }[] = [];
      for (const [id, st] of Object.entries(stMap)) {
        let sum = 0, present = 0;
        for (let d = start; d <= end; d = addDays(d, 1)) {
          const v = days[d]?.[id];
          if (v !== undefined) { sum += v; present++; }
        }
        if (present / daysSpan >= 0.6) pts.push({ lat: st.lat, lon: st.lon, v: sum });
      }
      const grid = splat(pts, RW, RH);
      for (const v of grid) if (v > maxMm) maxMm = v;
      const id = `${end.replace(/-/g, "")}-${daysSpan}d-${(latest + pts.length).slice(-6)}`;
      await putR2Png(env, `${prefix}/frames/rain/${daysSpan}d/${id}.png`, await renderRain(grid, daysSpan, fi));
      frames.push({
        id, endDate: end, daysAgoEnd: Math.round((new Date(latest + "T12:00:00Z").getTime() - new Date(end + "T12:00:00Z").getTime()) / 86400000),
        label: `${start}–${end} (${daysSpan} d)`, maxMm: Number(maxMm.toFixed(1)),
        url: `/api/v1/weather/rain-history/frame/${id}.png`,
      });
      if (fi === nF - 1) {
        // sista framen = aktuellt spann — sampla live-rutnät (0.5°) för weather/live.json
        for (let lat = BOUNDS.minLat + 0.25; lat < BOUNDS.maxLat; lat += 0.5) {
          for (let lon = BOUNDS.minLon + 0.25; lon < BOUNDS.maxLon; lon += 0.5) {
            const px = Math.floor(((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * RW);
            const py = Math.floor(((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * RH);
            const cell = { lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)), rain14: 0, rain28: 0, rain42: 0 };
            if (daysSpan === 14) cell.rain14 = grid[py * RW + px];
            else if (daysSpan === 28) cell.rain28 = grid[py * RW + px];
            else if (daysSpan === 42) cell.rain42 = grid[py * RW + px];
            live.push(cell);
          }
        }
      }
    }
    await putR2Json(env, `${prefix}/frames/rain/manifest-${daysSpan}d.json`, {
      updatedAt: new Date().toISOString(), referenceTime: latest, requestedDays: daysSpan, spanDays: daysSpan,
      mode: "accumulated", stationCount: stations.length,
      bounds: [BOUNDS.minLon, BOUNDS.minLat, BOUNDS.maxLon, BOUNDS.maxLat], width: RW, height: RH,
      attribution: "Nederbörd: SMHI öppna data (Metobs), CC BY 4.0 — © SMHI",
      frames,
    }, "public, max-age=600");
    totalFrames += frames.length;
  }
  await putR2Json(env, `${prefix}/weather/live.json`, { updatedAt: new Date().toISOString(), latest, cells: live }, "public, max-age=300");
  return { spans: ALLOWED_DAYS.length, frames: totalFrames };
}

export async function bakeWeatherCron(env: Env): Promise<{ clouds: number; rainSpans: number; rainFrames: number }> {
  const prefix = r2Prefix(env);
  const clouds = await bakeClouds(env, prefix);
  const rain = await bakeRain(env, prefix);
  return { clouds, rainSpans: rain.spans, rainFrames: rain.frames };
}

export async function getLiveFactor(env: Env, lat: number, lon: number): Promise<number> {
  // enkel live-faktor från weather/live.json (regn över artens fönster hanteras klientnära;
  // servern/originen gör exaktare variant — detta är edge-fallback)
  const live = (await getR2Json(env, `${r2Prefix(env)}/weather/live.json`, 5 * 60_000)) as {
    cells?: { lat: number; lon: number; rain28?: number }[];
  } | null;
  if (!live?.cells?.length) return 1;
  let best = live.cells[0], bd = Infinity;
  for (const c of live.cells) {
    const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  const mm = best.rain28 ?? 0;
  const perWeek = mm / 4;
  if (perWeek < 3) return 0.3 + (perWeek / 3) * 0.15;
  if (perWeek <= 15) return 0.45 + ((perWeek - 3) / 12) * 0.55;
  if (perWeek <= 35) return 1.0 + ((perWeek - 15) / 20) * 0.18;
  return perWeek > 65 ? 0.92 : 1.18;
}
