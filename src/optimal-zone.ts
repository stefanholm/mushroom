// optimal-zone.ts — biologiskt exakt "optimal zon" (den gröna zonen) per vald art/arter.
//
// Två-fasig tids-viktad regnmodell ur rolling-42d.json (per station, sedan IDW till rutnät):
//   baseScore    = djupfukt över artens fönster (age-decay exp(-daysAgo/(win/2)))
//   triggerScore = gaussisk vikt kring artens fruktkropps-fördröjning (triggerPeakDays),
//                  låg vikt åt dag 0–1 (gaussen ger det naturligt)
//   torkbroms    = senaste 14 d < 2 mm -> 0.35, annars ramp till 1 vid 8 mm
//   översvämning = mjuk dämpning när ackumulerat > sweetSpotMm
//   W_rain       = clamp((baseWeight*baseN + (1-baseWeight)*trigN) * broms * dämpning, 0, 1.3)
//
// S_opt per cell = W_rain^0.42 * H_static^0.30 * F_season^0.16 * F_climate^0.12
//   H_static  = staticHabitatScore MED hårda veton (NMD-mask: bara skog tillåts, vatten/hygge/
//               tätort ger 0; kalhygge ger 0) — regn över stad/sjö/hygge blir aldrig grönt
//   F_season  = latitudjusterad säsong (seasonalFactor, ref 59°N)
//   F_climate = maxLat-gräns (Limes Norrlandicus-lik) + GDD5-kuvert + nattfrost < -2 °C
//               enligt artens frostTolerance (sensitive -> 0, moderate -> 0.6, hardy -> 1)
//
// EN sammanhängande polygon: 3x3 gauss -> biologiskt golv peak >= 0.46 (annars null)
// -> adaptiv tröskel -> morfologisk stängning (dilate->erode) -> connected components
// (8-grannar, behåll största efter integrerad poäng) -> Moore-kontur -> 2x Chaikin
// -> EN GeoJSON Polygon-Feature.
//
// Single-art: exakt artens fönster/profil. Multi: mjuk union S = 1 - Π(1-S_i) + 3x3 max-breddning.

import proj4 from "proj4";
import {
  SPECIES,
  seasonalFactor,
  staticHabitatScore,
  effectiveGdd5,
  type SpeciesProfile,
} from "./habitat.js";
import { LayerStore, toSWEREF } from "./layers.js";
import {
  RAIN_BOUNDS,
  RAIN_GRID_W,
  RAIN_GRID_H,
  getRollingRaw,
  accumulateWindow,
  interpPointsToGrid,
  minTempLast48hAt,
} from "./rain-history.js";

proj4.defs(
  "EPSG:3006",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);
const to4326 = ([e, n]: [number, number]) => proj4("EPSG:3006", "EPSG:4326", [e, n]) as [number, number];

const W = RAIN_GRID_W;
const H = RAIN_GRID_H;
const PEAK_FLOOR = 0.46;
const dayMs = 86400000;
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, k: number) => toDay(new Date(new Date(day + "T12:00:00Z").getTime() + k * dayMs));

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export type OptimalZoneProperties = {
  speciesIds: string[];
  windowDays: number;
  triggerPeakDays: number;
  accumulatedRainMm: number;
  effectiveRainMm: number;
  peakScore: number;
  meanScore: number;
  seasonFactor: number;
  habitatFactor: number;
};
export type OptimalZoneResult = {
  mode: "single" | "multi";
  displayRainWindowDays: number;
  optimalZone: {
    type: "Feature";
    properties: OptimalZoneProperties;
    geometry: { type: "Polygon"; coordinates: number[][][] };
  } | null;
  meta: Record<string, unknown>;
};

// ---------- per-art regnsignaler på stationsnivå ----------
function rainSignalsForSpecies(
  rolling: { days: Record<string, Record<string, number>>; stations: Record<string, { lat: number; lon: number }> },
  sp: SpeciesProfile,
  latest: string,
): { e: number; n: number; v: number }[] {
  const win = sp.rainWindowDays ?? 28;
  const dayKeys = Object.keys(rolling.days).sort();
  const actualDays = Math.min(win, dayKeys.length);
  const start = addDays(latest, -(actualDays - 1));
  const peak = sp.triggerPeakDays ?? 10;
  const spread = sp.triggerSpreadDays ?? 3.5;
  const baseW = sp.baseWeight ?? 0.55;
  const sweet = sp.sweetSpotMm ?? 100;
  const pts: { e: number; n: number; v: number }[] = [];
  for (const [id, st] of Object.entries(rolling.stations)) {
    let baseRaw = 0;
    let trigRaw = 0;
    let recent14 = 0;
    let total = 0;
    let present = 0;
    for (const d of dayKeys) {
      if (d < start || d > latest) continue;
      const mm = rolling.days[d]?.[id];
      if (mm === undefined) continue;
      present++;
      const daysAgo = Math.round((new Date(latest + "T12:00:00Z").getTime() - new Date(d + "T12:00:00Z").getTime()) / dayMs);
      total += mm;
      baseRaw += mm * Math.exp(-daysAgo / (actualDays / 2));
      const g = Math.exp(-((daysAgo - peak) ** 2) / (2 * spread * spread));
      trigRaw += mm * g;
      if (daysAgo <= 13) recent14 += mm;
    }
    if (present / actualDays < 0.6) continue;
    const baseN = Math.min(1.3, baseRaw / sweet);
    const trigN = Math.min(1.3, trigRaw / (sweet * 0.4));
    // torkbroms på senaste 14 d + mjuk översvämningsdämpning över sweet spot
    const brake = recent14 < 2 ? 0.35 : Math.min(1, recent14 / 8);
    const flood = total <= sweet ? 1 : Math.max(0.55, 1 - (total / sweet - 1) * 0.35);
    const wRain = Math.min(1.3, (baseW * baseN + (1 - baseW) * trigN) * brake * flood);
    const [e, n] = toSWEREF(st.lon, st.lat);
    pts.push({ e, n, v: wRain });
  }
  return pts;
}

// ---------- S_opt-rutnät per art ----------
async function speciesGrid(
  store: LayerStore,
  rolling: Awaited<ReturnType<typeof getRollingRaw>>,
  latest: string,
  spKey: string,
  asOf: Date,
): Promise<{ grid: Float32Array; rainGrid: Float32Array; peak: number }> {
  const sp = SPECIES[spKey];
  const win = sp.rainWindowDays ?? 28;
  const dayKeys = Object.keys(rolling.days).sort();
  const actualDays = Math.min(win, dayKeys.length);
  const start = addDays(latest, -(actualDays - 1));
  const totPts = accumulateWindow(rolling, start, latest);
  const totGrid = interpPointsToGrid(totPts); // ackumulerat mm (för properties)
  const rainGrid = interpPointsToGrid(rainSignalsForSpecies(rolling, sp, latest)); // W_rain 0..1.3

  const [minE, maxN] = toSWEREF(RAIN_BOUNDS.minLon, RAIN_BOUNDS.maxLat);
  const [maxE, minN] = toSWEREF(RAIN_BOUNDS.maxLon, RAIN_BOUNDS.minLat);
  const sx = (maxE - minE) / W;
  const sy = (maxN - minN) / H;
  const grid = new Float32Array(W * H);
  const mask = store.mask;
  const clearcuts = store.vectors.get("avverkningar");
  const gddL = store.rasters.get("gdd5");
  // nattfrost per rad (0.5°-grid, cachad i rain-history)
  const frostByRow = new Map<number, number>();
  for (let py = 0; py < H; py++) {
    const lat = RAIN_BOUNDS.maxLat - (py + 0.5) * (RAIN_BOUNDS.maxLat - RAIN_BOUNDS.minLat) / H;
    const key = Math.round(lat * 2) / 2;
    if (!frostByRow.has(key)) {
      const t = await minTempLast48hAt(key, (RAIN_BOUNDS.minLon + RAIN_BOUNDS.maxLon) / 2, asOf);
      let f = 1;
      if (t !== null && t < -2) {
        f = sp.frostTolerance === "sensitive" ? 0 : sp.frostTolerance === "moderate" ? 0.6 : 1;
      }
      frostByRow.set(key, f);
    }
    const frostF = frostByRow.get(key)!;
    const seasonF = clamp01(seasonalFactor(sp, lat, asOf));
    for (let px = 0; px < W; px++) {
      const k = py * W + px;
      const lon = RAIN_BOUNDS.minLon + (px + 0.5) * (RAIN_BOUNDS.minLon - RAIN_BOUNDS.minLon + (RAIN_BOUNDS.maxLon - RAIN_BOUNDS.minLon)) / W;
      const [e, n] = toSWEREF(lon, lat);
      // hårda veton: utanför NMD-skog (vatten/hygge/tätort) eller i kalhygge -> H = 0
      const inForest = mask ? mask.has(e, n) && mask.allows(e, n) : true;
      const inClearcut = clearcuts ? clearcuts.contains(e, n) : false;
      let H = 0;
      if (inForest && !inClearcut) {
        H = staticHabitatScore(store, spKey, lon, lat, {
          forestOk: true, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false,
        });
      }
      // klimat: maxLat + GDD5-kuvert
      let Fclim = frostF;
      if (sp.maxLat !== undefined && lat > sp.maxLat) Fclim = 0;
      if (Fclim > 0 && gddL && sp.gddEnvelope) {
        const g = effectiveGdd5(store, lon, lat);
        if (g !== null && (g < sp.gddEnvelope[0] || g > sp.gddEnvelope[1])) Fclim *= 0.6;
      }
      const wr = rainGrid[k];
      grid[k] = Math.pow(Math.max(0, wr), 0.42) * Math.pow(H, 0.3) * Math.pow(seasonF, 0.16) * Math.pow(Fclim, 0.12);
    }
  }
  let peak = 0;
  for (const v of grid) if (v > peak) peak = v;
  return { grid, rainGrid, peak };
}

// ---------- morfologi ----------
function gauss3(src: Float32Array): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          s += src[yy * W + xx] * w;
          wsum += w;
        }
      }
      out[y * W + x] = s / wsum;
    }
  }
  return out;
}
function dilate(mask: Uint8Array, r: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < r; i++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) out[yy * W + xx] = 1;
          }
        }
      }
    }
    m = out;
  }
  return m;
}
function erode(mask: Uint8Array, r: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < r; i++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1 && all; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H || !m[yy * W + xx]) all = 0;
          }
        }
        out[y * W + x] = all ? 1 : 0;
      }
    }
    m = out;
  }
  return m;
}
function maxFilter3(src: Float32Array): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const v = src[yy * W + xx];
          if (v > m) m = v;
        }
      }
      out[y * W + x] = m;
    }
  }
  return out;
}

// Connected components (8-grannar); returnerar label-array och komponenternas integrerade poäng.
function components(mask: Uint8Array, score: Float32Array): { labels: Int32Array; best: number; sums: number[] } {
  const labels = new Int32Array(W * H).fill(-1);
  const sums: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || labels[i] !== -1) continue;
    const id = sums.length;
    let sum = 0;
    const stack = [i];
    labels[i] = id;
    while (stack.length > 0) {
      const k = stack.pop()!;
      sum += score[k];
      const x = k % W;
      const y = Math.floor(k / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const kk = yy * W + xx;
          if (mask[kk] && labels[kk] === -1) {
            labels[kk] = id;
            stack.push(kk);
          }
        }
      }
    }
    sums.push(sum);
  }
  let best = -1;
  for (let i = 0; i < sums.length; i++) if (best === -1 || sums[i] > sums[best]) best = i;
  return { labels, best, sums };
}

// Moore-neighbor boundary tracing av ytterringen för komponent `label`.
function traceBoundary(labels: Int32Array, label: number): [number, number][] {
  // hitta start: översta-vänstra pixel av komponenten
  let start = -1;
  for (let i = 0; i < W * H; i++) if (labels[i] === label) { start = i; break; }
  if (start === -1) return [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : labels[y * W + x]);
  const isComp = (x: number, y: number) => at(x, y) === label;
  const sx = start % W;
  const sy = Math.floor(start / W);
  const ring: [number, number][] = [];
  // 8-riktningar, börja "väster" (dx=-1,dy=0)
  const dirs = [
    [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
  ];
  let x = sx;
  let y = sy;
  let d = 0; // sök från riktning väster
  const maxSteps = W * H * 4;
  let steps = 0;
  const startState = `${x},${y},${d}`;
  do {
    ring.push([x, y]);
    // Moore: börja sökningen från riktningen efter den vi kom ifrån (backtrack + 2)
    let found = false;
    for (let i = 0; i < 8; i++) {
      const nd = (d + 6 + i) % 8; // backtracka två steg från nuvarande riktning
      const nx = x + dirs[nd][0];
      const ny = y + dirs[nd][1];
      if (isComp(nx, ny)) {
        x = nx;
        y = ny;
        d = nd;
        found = true;
        break;
      }
    }
    if (!found) break; // isolerad pixel
    steps++;
  } while (steps < maxSteps && `${x},${y},${d}` !== startState);
  return ring;
}

// Chaikin corner cutting, 2 pass, på slutna ringen (pixlar -> koordinater senare)
function chaikin(ring: [number, number][], passes = 2): [number, number][] {
  let pts = ring;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const out: [number, number][] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    pts = out;
  }
  return pts;
}

function pixelToLonLat(px: number, py: number): [number, number] {
  const [minE, maxN] = toSWEREF(RAIN_BOUNDS.minLon, RAIN_BOUNDS.maxLat);
  const [maxE, minN] = toSWEREF(RAIN_BOUNDS.maxLon, RAIN_BOUNDS.minLat);
  const e = minE + (px + 0.5) * ((maxE - minE) / W);
  const n = maxN - (py + 0.5) * ((maxN - minN) / H);
  return to4326([e, n]);
}

// ---------- huvud ----------
export async function computeOptimalZone(
  store: LayerStore,
  speciesIds: string[],
  asOf: Date,
): Promise<OptimalZoneResult> {
  const ids = speciesIds.filter((k) => SPECIES[k]);
  if (ids.length === 0) throw new Error("inga giltiga arter");
  const rolling = await getRollingRaw();
  const dayKeys = Object.keys(rolling.days).sort();
  const latest = dayKeys[dayKeys.length - 1];

  const grids: Float32Array[] = [];
  const rainGrids: Float32Array[] = [];
  let maxWin = 0;
  let maxPeak = 0;
  for (const id of ids) {
    const sp = SPECIES[id];
    maxWin = Math.max(maxWin, sp.rainWindowDays ?? 28);
    maxPeak = Math.max(maxPeak, sp.triggerPeakDays ?? 10);
    const { grid, rainGrid } = await speciesGrid(store, rolling, latest, id, asOf);
    grids.push(grid);
    rainGrids.push(rainGrid);
  }

  // single: exakt artens grid; multi: mjuk union + breddning
  let S: Float32Array;
  if (grids.length === 1) {
    S = grids[0];
  } else {
    S = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
      let prod = 1;
      for (const g of grids) prod *= 1 - g[k];
      S[k] = 1 - prod;
    }
    S = maxFilter3(S); // lätt breddning där arterna överlappar
  }

  const smooth = gauss3(S);
  let peak = 0;
  for (const v of smooth) if (v > peak) peak = v;

  const displayRainWindowDays = ids.length === 1 ? (SPECIES[ids[0]].rainWindowDays ?? 28) : maxWin;
  const base = {
    mode: (ids.length === 1 ? "single" : "multi") as "single" | "multi",
    displayRainWindowDays,
    optimalZone: null as OptimalZoneResult["optimalZone"],
    meta: { peakScore: Number(peak.toFixed(3)), latest, speciesIds: ids } as Record<string, unknown>,
  };
  if (peak < PEAK_FLOOR) {
    base.meta.reason = "peak under biologiskt golv (ingen falsk grön zon)";
    return base;
  }

  // adaptiv tröskel + morfologisk stängning + en komponent
  const thr = Math.max(PEAK_FLOOR, Math.min(0.75, peak * 0.72));
  let mask: Uint8Array = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) mask[k] = smooth[k] >= thr ? 1 : 0;
  mask = erode(dilate(mask, 2), 2);
  const { labels, best } = components(mask, smooth);
  if (best === -1) {
    base.meta.reason = "ingen komponent över tröskeln";
    return base;
  }

  // statistik över zonen (före kontur)
  let sumS = 0, sumRain = 0, sumTot = 0, cnt = 0;
  const totPts = accumulateWindow(rolling, addDays(latest, -(displayRainWindowDays - 1)), latest);
  const totGrid = interpPointsToGrid(totPts);
  const rainMean = rainGrids.length === 1 ? rainGrids[0] : rainGrids[0]; // rapporterar första artens regn vid multi
  for (let k = 0; k < W * H; k++) {
    if (labels[k] !== best) continue;
    sumS += smooth[k];
    sumRain += rainMean[k] ?? 0;
    sumTot += totGrid[k] ?? 0;
    cnt++;
  }
  // säsong/habitat-medel över zonen (approximation: medel av artens grid-värden är svårt att
  // separera här — rapportera peak/mean av S och medel av W_rain)
  const meanS = cnt > 0 ? sumS / cnt : 0;

  const ringPx = traceBoundary(labels, best);
  if (ringPx.length < 3) {
    base.meta.reason = "för liten komponent";
    return base;
  }
  const smoothRing = chaikin(ringPx, 2);
  const coords = smoothRing.map(([px, py]) => {
    const [lon, lat] = pixelToLonLat(px, py);
    return [Number(lon.toFixed(5)), Number(lat.toFixed(5))];
  });
  // stäng ringen
  coords.push(coords[0].slice());

  base.optimalZone = {
    type: "Feature",
    properties: {
      speciesIds: ids,
      windowDays: displayRainWindowDays,
      triggerPeakDays: ids.length === 1 ? (SPECIES[ids[0]].triggerPeakDays ?? 10) : maxPeak,
      accumulatedRainMm: Number((cnt > 0 ? sumTot / cnt : 0).toFixed(1)),
      effectiveRainMm: Number((cnt > 0 ? sumRain / cnt : 0).toFixed(2)),
      peakScore: Number(peak.toFixed(3)),
      meanScore: Number(meanS.toFixed(3)),
      seasonFactor: Number(clamp01(seasonalFactor(SPECIES[ids[0]], 59, asOf)).toFixed(2)),
      habitatFactor: Number(Math.pow(meanS, 1 / 0.3).toFixed(2)), // approx
    },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
  base.meta.threshold = Number(thr.toFixed(3));
  base.meta.zoneCells = cnt;
  return base;
}
