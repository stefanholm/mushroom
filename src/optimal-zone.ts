// optimal-zone.ts — biologiskt exakt "optimal zon" (den gröna zonen) per vald art/arter.
//
// Två-fasig tids-viktad regnmodell ur rolling-42d.json (per station, sedan IDW till rutnät):
//   baseScore    = djupfukt över artens fönster (age-decay exp(-daysAgo/(win/2)))
//   triggerScore = gaussisk vikt kring artens fruktkropps-fördröjning (triggerPeakDays),
//                  låg vikt åt dag 0–1 (gaussen ger det naturligt)
//   torkbroms    = senaste 14 d < 2 mm -> 0.35, annars ramp till 1 vid 8 mm
//   översvämning = floodDamping (se nedan): full vikt tom 1.25x sweetSpotMm, sedan
//                  smoothstep ner till 0.15-0.20 vid >= 2.2x sweetSpotMm — vattenmättade
//                  kärnor hamnar under zon-tröskeln så zonen flyttar till väldränerade flanker
//   W_rain       = clamp((baseWeight*baseN + (1-baseWeight)*trigN) * broms * dämpning, 0, 1.3)
//
// S_opt per cell = W_rain^0.42 * H_static^0.30 * F_season^0.16 * F_climate^0.12
//   H_static  = staticHabitatScore MED hårda veton, aggregerat per makrocell med 3x3
//               sub-provtagning + topp-kvartil-medel (se cellHabitat nedan) så en skogsdunge
//               i ett måttligt makrocell inte kvävs av punkt-sampling (samma princip som
//               Tier-1-bakens max/p95). Hårda veton gäller PER SUB-PUNKT: vatten/hygge/tätort/
//               kalhygge ger aldrig grönt — regn över stad/sjö/hygge blir aldrig zon.
//   F_season  = latitudjusterad säsong (seasonalFactor, ref 59°N)
//   F_climate = maxLat-gräns (Limes Norrlandicus-lik) + GDD5-kuvert + nattfrost < -2 °C
//               enligt artens frostTolerance (sensitive -> 0, moderate -> 0.6, hardy -> 1)
//   static=1  (HABITAT-läge, året-runt biotop): F_season = 1 och F_climate = 1 (ingen
//               frost/GDD/maxLat), W_rain + H_static + hårda NMD-veton är oförändrade.
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
  static: boolean; // true = HABITAT-läge (F_season=F_climate=1)
  mode: "single" | "multi";
  displayRainWindowDays: number;
  optimalZone: {
    type: "Feature";
    properties: OptimalZoneProperties;
    geometry: { type: "Polygon"; coordinates: number[][][] };
  } | null;
  meta: Record<string, unknown>;
};
export type OptimalZoneOptions = { static?: boolean };

// ---------- överblöts-dämpning (ren, testbar) ----------
// x = ackumulerat mm / sweetSpotMm. x <= 1.25 -> 1 (ingen straffning i normalt blött läge).
// x >= 2.2 -> golvet 0.15 + 0.05*floodTolerance (fukttåliga arter ~0.20, torrmarksarter ~0.15).
// Däremellan smoothstep. Kraftigt dränkta celler (x >= 2.2) får alltså W_rain <= 1.3*0.20,
// vilket efter ^0.42 hamnar under det biologiska golvet när habitat/säsong är normalt.
export function floodDamping(totalMm: number, sweetMm: number, floodTolerance = 0.5): number {
  const x = totalMm / Math.max(1, sweetMm);
  if (x <= 1.25) return 1;
  const floor = 0.15 + 0.05 * Math.min(1, Math.max(0, floodTolerance));
  if (x >= 2.2) return floor;
  const t = (x - 1.25) / (2.2 - 1.25);
  const s = t * t * (3 - 2 * t); // smoothstep 0..1
  return 1 - s * (1 - floor);
}

// ---------- per-art regnsignaler på stationsnivå ----------
// (exporterad för enhetstester — ren funktion av rolling-filen)
export function rainSignalsForSpecies(
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
    // torkbroms på senaste 14 d + skarp överblöts-dämpning (1.25x->2.2x sweetSpotMm)
    const brake = recent14 < 2 ? 0.35 : Math.min(1, recent14 / 8);
    const flood = floodDamping(total, sweet, sp.floodTolerance ?? 0.5);
    const wRain = Math.min(1.3, (baseW * baseN + (1 - baseW) * trigN) * brake * flood);
    const [e, n] = toSWEREF(st.lon, st.lat);
    pts.push({ e, n, v: wRain });
  }
  return pts;
}

// ---------- H_static per makrocell: 3x3 sub-provtagning + topp-kvartil ----------
// Makrocellerna (256x320 över Sverige, ~3x5 km celler) är mycket större än 10-25 m
// rasterpixlarna, så ett
// enda punktprov kan missa skogen (cellmitt på en sjö -> H=0 trots skog runtom) eller underskatta
// ett måttligt cell (på Mac gav detta habitatFactor ~0.10 i makroceller, 0.10^0.30 ~ 0.50, vilket
// drog ner säsongsarter precis under golvet 0.46). Vi provtar därför 3x3 sub-punkter i cellen.
// Hårda veton gäller PER SUB-PUNKT: utanför NMD-skog (vatten/hygge/tätort) eller i kalhygge
// räknas sub-punkten inte alls — en helt veto-täckt cell får H=0 (regn över stad/sjö/hygge blir
// aldrig grönt). Aggregering = medel av topp-kvartilen av tillåtna positiva värden.
// Snabbväg: cellmitten tillåten och H >= FAST_H -> använd mitsvärdet direkt (1 anrop).
const SUB_OFFS = [0.2, 0.5, 0.8];
const FAST_H = 0.55;

const lonAt = (px: number, fx: number) =>
  RAIN_BOUNDS.minLon + (px + fx) * (RAIN_BOUNDS.maxLon - RAIN_BOUNDS.minLon) / W;
const latAt = (py: number, fy: number) =>
  RAIN_BOUNDS.maxLat - (py + fy) * (RAIN_BOUNDS.maxLat - RAIN_BOUNDS.minLat) / H;

function cellHabitat(store: LayerStore, spKey: string, px: number, py: number): number {
  const mask = store.mask;
  const clearcuts = store.vectors.get("avverkningar");
  const evalAt = (fx: number, fy: number): number | null => {
    const lon = lonAt(px, fx);
    const lat = latAt(py, fy);
    const [e, n] = toSWEREF(lon, lat);
    if (mask && !(mask.has(e, n) && mask.allows(e, n))) return null; // hårt veto: ej NMD-skog
    if (clearcuts && clearcuts.contains(e, n)) return null; // hårt veto: kalhygge
    const h = staticHabitatScore(store, spKey, lon, lat, {
      forestOk: true, inClearcut: false, excluded: false, roadFactor: 1, forestEdge: false,
    });
    return h > 0 ? h : null; // hårda habitat-gates (värd/höjd/…) -> inget habitat här
  };
  const center = evalAt(0.5, 0.5);
  if (center !== null && center >= FAST_H) return center;
  const vals: number[] = [];
  for (const fx of SUB_OFFS) {
    for (const fy of SUB_OFFS) {
      const v = evalAt(fx, fy);
      if (v !== null) vals.push(v);
    }
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => b - a);
  const top = Math.max(1, Math.round(vals.length * 0.25)); // topp-kvartil
  let s = 0;
  for (let i = 0; i < top; i++) s += vals[i];
  return s / top;
}

// ---------- S_opt-rutnät per art ----------
async function speciesGrid(
  store: LayerStore,
  rolling: Awaited<ReturnType<typeof getRollingRaw>>,
  latest: string,
  spKey: string,
  asOf: Date,
  staticOnly = false,
): Promise<{
  grid: Float32Array;
  rainGrid: Float32Array;
  hGrid: Float32Array;
  seasonGrid: Float32Array;
  peak: number;
}> {
  const sp = SPECIES[spKey];
  const rainGrid = interpPointsToGrid(rainSignalsForSpecies(rolling, sp, latest)); // W_rain 0..1.3

  const grid = new Float32Array(W * H);
  const hGrid = new Float32Array(W * H);
  const seasonGrid = new Float32Array(W * H);
  const gddL = store.rasters.get("gdd5");
  // nattfrost per rad (0.5°-grid, cachad i rain-history); hoppas över helt i static-läge
  const frostByRow = new Map<number, number>();
  for (let py = 0; py < H; py++) {
    const lat = latAt(py, 0.5);
    const seasonF = staticOnly ? 1 : clamp01(seasonalFactor(sp, lat, asOf));
    let frostF = 1;
    if (!staticOnly) {
      const key = Math.round(lat * 2) / 2;
      if (!frostByRow.has(key)) {
        const t = await minTempLast48hAt(key, (RAIN_BOUNDS.minLon + RAIN_BOUNDS.maxLon) / 2, asOf);
        frostF = t !== null && t < -2
          ? sp.frostTolerance === "sensitive" ? 0 : sp.frostTolerance === "moderate" ? 0.6 : 1
          : 1;
        frostByRow.set(key, frostF);
      } else {
        frostF = frostByRow.get(key)!;
      }
    }
    for (let px = 0; px < W; px++) {
      const k = py * W + px;
      // H_static med hårda veton + topp-kvartil-aggregering (se cellHabitat)
      const H = cellHabitat(store, spKey, px, py);
      // klimat: maxLat + GDD5-kuvert; i static-läge är F_climate alltid 1
      let Fclim = staticOnly ? 1 : frostF;
      if (!staticOnly && sp.maxLat !== undefined && lat > sp.maxLat) Fclim = 0;
      if (!staticOnly && Fclim > 0 && gddL && sp.gddEnvelope) {
        const lon = lonAt(px, 0.5);
        const g = effectiveGdd5(store, lon, lat);
        if (g !== null && (g < sp.gddEnvelope[0] || g > sp.gddEnvelope[1])) Fclim *= 0.6;
      }
      const wr = rainGrid[k];
      grid[k] = Math.pow(Math.max(0, wr), 0.42) * Math.pow(H, 0.3) * Math.pow(seasonF, 0.16) * Math.pow(Fclim, 0.12);
      hGrid[k] = H;
      seasonGrid[k] = seasonF;
    }
  }
  let peak = 0;
  for (const v of grid) if (v > peak) peak = v;
  return { grid, rainGrid, hGrid, seasonGrid, peak };
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
// dirs är ordnade medurs (skärm-koordinater, y nedåt): W, NW, N, NE, E, SE, S, SW.
// Start = första komponenten i skannordning (dess västra granne är garanterat bakgrund).
// Backtrack-pixeln b är ALLTID en bakgrundspixel (senast skannade innan träffen).
// Stopp: när tillståndet (px,py,bx,by) upprepas (cykel-detektion, omfattar Jacobs
// kriterium) — garanterad terminering även för tunna 1–2 px strukturer. maxSteps är
// ett extra nödspärr.
function traceBoundary(labels: Int32Array, label: number): [number, number][] {
  let start = -1;
  for (let i = 0; i < W * H; i++) if (labels[i] === label) { start = i; break; }
  if (start === -1) return [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : labels[y * W + x]);
  const dirs: [number, number][] = [
    [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
  ];
  const dirOf = (dx: number, dy: number) => {
    for (let i = 0; i < 8; i++) if (dirs[i][0] === dx && dirs[i][1] === dy) return i;
    return 0;
  };
  const sx = start % W;
  const sy = Math.floor(start / W);
  let bx = sx - 1, by = sy; // backtrack-pixel (bakgrund)
  let px = sx, py = sy;
  const ring: [number, number][] = [];
  const seen = new Set<string>([`${px},${py},${bx},${by}`]);
  const maxSteps = W * H * 4 + 16;
  let steps = 0;
  do {
    ring.push([px, py]);
    const bd = dirOf(bx - px, by - py);
    let moved = false;
    let lastBgX = bx, lastBgY = by;
    for (let i = 1; i <= 8; i++) {
      const nd = (bd + i) % 8; // skanna medurs från backtrack + 1
      const nx = px + dirs[nd][0];
      const ny = py + dirs[nd][1];
      if (at(nx, ny) === label) {
        bx = lastBgX; by = lastBgY; // ny backtrack = senast skannade bakgrundspixel
        px = nx; py = ny;
        moved = true;
        break;
      }
      lastBgX = nx; lastBgY = ny;
    }
    if (!moved) break; // isolerad pixel
    steps++;
    const state = `${px},${py},${bx},${by}`;
    if (seen.has(state)) break; // sluten slinga
    seen.add(state);
  } while (steps < maxSteps);
  return ring;
}

// Chaikin corner cutting, 2 pass, på slutna ringen (pixlar -> koordinater senare).
// Nöd-decimering om ringen skulle bli extremt lång (nödspärren i traceBoundary triggad).
function chaikin(ring: [number, number][], passes = 2): [number, number][] {
  let pts = ring;
  if (pts.length > 8000) {
    const stride = Math.ceil(pts.length / 8000);
    pts = pts.filter((_, i) => i % stride === 0);
  }
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
  opts: OptimalZoneOptions = {},
): Promise<OptimalZoneResult> {
  const staticOnly = opts.static === true;
  const ids = speciesIds.filter((k) => SPECIES[k]);
  if (ids.length === 0) throw new Error("inga giltiga arter");
  const rolling = await getRollingRaw();
  const dayKeys = Object.keys(rolling.days).sort();
  const latest = dayKeys[dayKeys.length - 1];

  const grids: Float32Array[] = [];
  const rainGrids: Float32Array[] = [];
  const hGrids: Float32Array[] = [];
  const seasonGrids: Float32Array[] = [];
  let maxWin = 0;
  let maxPeak = 0;
  for (const id of ids) {
    const sp = SPECIES[id];
    maxWin = Math.max(maxWin, sp.rainWindowDays ?? 28);
    maxPeak = Math.max(maxPeak, sp.triggerPeakDays ?? 10);
    const { grid, rainGrid, hGrid, seasonGrid } = await speciesGrid(store, rolling, latest, id, asOf, staticOnly);
    grids.push(grid);
    rainGrids.push(rainGrid);
    hGrids.push(hGrid);
    seasonGrids.push(seasonGrid);
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
    static: staticOnly,
    mode: (ids.length === 1 ? "single" : "multi") as "single" | "multi",
    displayRainWindowDays,
    optimalZone: null as OptimalZoneResult["optimalZone"],
    meta: { peakScore: Number(peak.toFixed(3)), latest, speciesIds: ids, static: staticOnly } as Record<string, unknown>,
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

  // statistik över zonen (före kontur); vid multi medelvärde över alla arters grid
  let sumS = 0, sumRain = 0, sumTot = 0, sumH = 0, sumSeason = 0, cnt = 0;
  const nG = rainGrids.length;
  const totPts = accumulateWindow(rolling, addDays(latest, -(displayRainWindowDays - 1)), latest);
  const totGrid = interpPointsToGrid(totPts);
  for (let k = 0; k < W * H; k++) {
    if (labels[k] !== best) continue;
    sumS += smooth[k];
    sumTot += totGrid[k] ?? 0;
    for (let g = 0; g < nG; g++) {
      sumRain += rainGrids[g][k] ?? 0;
      sumH += hGrids[g][k];
      sumSeason += seasonGrids[g][k];
    }
    cnt++;
  }
  const meanS = cnt > 0 ? sumS / cnt : 0;
  const meanRain = cnt > 0 ? sumRain / (cnt * nG) : 0;
  const meanH = cnt > 0 ? sumH / (cnt * nG) : 0;
  const meanSeason = cnt > 0 ? sumSeason / (cnt * nG) : 0;

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
      seasonFactor: Number(meanSeason.toFixed(2)), // 1.00 i static-läge
      habitatFactor: Number(meanH.toFixed(2)), // verkligt H_static-medel över zonen
    },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
  base.meta.threshold = Number(thr.toFixed(3));
  base.meta.zoneCells = cnt;
  return base;
}
