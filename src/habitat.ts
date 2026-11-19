import { toSWEREF, type LayerStore, type RasterLayer } from "./layers.js";

export type SpeciesProfile = {
  label: string;
  seasonStart: number;
  seasonEnd: number;
  hosts: Record<string, number>;
  minHostVolume: number;
  minTreeHeight: number;
  vetoMoisture: number[];
  moistureIdeal: [number, number];
  canopyIdeal: [number, number];
  soil: Record<string, number>;
  sun: number;
  depression: number;
  edge: number;
  frostSensitive: boolean;
};

export const SPECIES: Record<string, SpeciesProfile> = {
  kantarell: {
    label: "Kantarell",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 1, ek: 1, bok: 1, gran: 0.8, tall: 0.6 },
    minHostVolume: 15,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [15, 28],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.6 },
    sun: 1,
    depression: 0.3,
    edge: 1,
    frostSensitive: true,
  },
  trattkantarell: {
    label: "Trattkantarell",
    seasonStart: 9,
    seasonEnd: 11,
    hosts: { gran: 1, tall: 0.5, bjork: 0.2 },
    minHostVolume: 30,
    minTreeHeight: 14,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [25, 40],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: -1,
    depression: 1,
    edge: 0.2,
    frostSensitive: false,
  },
  karljohan: {
    label: "Karljohan",
    seasonStart: 8,
    seasonEnd: 9,
    hosts: { gran: 1, ek: 0.9, bok: 0.9, bjork: 0.8, tall: 0.5 },
    minHostVolume: 20,
    minTreeHeight: 12,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [18, 30],
    soil: { acidic: 0.9, neutral: 0.85, calcareous: 0.8 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.5,
    frostSensitive: false,
  },
  "svart-trumpetsvamp": {
    label: "Svart trumpetsvamp",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { ek: 1, bok: 1, bjork: 0.3 },
    minHostVolume: 15,
    minTreeHeight: 12,
    vetoMoisture: [1, 2],
    moistureIdeal: [4, 4],
    canopyIdeal: [22, 35],
    soil: { calcareous: 1, neutral: 0.7, acidic: 0.2 },
    sun: -1,
    depression: 1,
    edge: 0.3,
    frostSensitive: false,
  },
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function seasonalFactor(species: SpeciesProfile, lat: number, now: Date): number {
  const shift = Math.min(1, Math.max(-1, (59 - lat) * 0.1));
  const month = now.getUTCMonth() + 1 + now.getUTCDate() / 30 + shift;
  const { seasonStart, seasonEnd } = species;
  if (month < seasonStart - 0.5 || month > seasonEnd + 0.5) return 0;
  if (month < seasonStart) return (month - (seasonStart - 0.5)) / 0.5;
  if (month > seasonEnd) return 1 - (month - seasonEnd) / 0.5;
  return 1;
}

export type HabitatContext = {
  forestOk: boolean;
  inClearcut: boolean;
  excluded: boolean;
  roadFactor: number;
  forestEdge: boolean;
};

function aspectFromGrid(grid: number[][], spacingM: number): number {
  const w = grid.length;
  const c = (w - 1) / 2;
  const dzdx =
    (grid[0][w - 1] + 2 * grid[c][w - 1] + grid[w - 1][w - 1] - grid[0][0] - 2 * grid[c][0] - grid[w - 1][0]) /
    (8 * spacingM);
  const dzdy =
    (grid[w - 1][0] + 2 * grid[w - 1][c] + grid[w - 1][w - 1] - grid[0][0] - 2 * grid[0][c] - grid[0][w - 1]) /
    (8 * spacingM);
  return (((Math.atan2(dzdy, -dzdx) * 180) / Math.PI) + 360) % 360;
}

export function hostFallback(store: LayerStore): boolean {
  return !store.rasters.has("gran") && !store.rasters.has("bjork");
}

export function staticHabitatScore(
  store: LayerStore,
  speciesKey: string,
  lon: number,
  lat: number,
  ctx: HabitatContext,
): number {
  const species = SPECIES[speciesKey];
  if (ctx.inClearcut || ctx.excluded) return 0;
  if (!ctx.forestOk) return 0;
  const [easting, northing] = toSWEREF(lon, lat);

  const dem = store.rasters.get("hojd");
  let covered = false;
  if (dem && dem.has(easting, northing)) {
    const elev = dem.sampleSync(easting, northing);
    if (elev === null || elev < 0.5) return 0;
    covered = true;
  }
  let hostVol = 0;
  let anyHost = false;
  for (const [tree, w] of Object.entries(species.hosts)) {
    const layer = store.rasters.get(tree);
    if (!layer) continue;
    const v = layer.sampleSync(easting, northing);
    if (v !== null) {
      anyHost = true;
      covered = true;
      hostVol += v * w;
    }
  }
  let hostGate = 1;
  if (anyHost) {
    if (hostVol < species.minHostVolume) return 0;
    hostGate = 0.2 + 0.8 * clamp01(hostVol / (2 * species.minHostVolume));
  } else {
    const vol = store.rasters.get("volym");
    if (vol) {
      const v = vol.sampleSync(easting, northing);
      if (v !== null) {
        covered = true;
        if (v < species.minHostVolume) return 0;
        hostGate = 0.2 + 0.8 * clamp01(v / (2 * species.minHostVolume));
      }
    }
  }

  const height = store.rasters.get("tradhojd");
  let fMaturity = 1;
  if (height) {
    const v = height.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      if (v < species.minTreeHeight) return 0;
      fMaturity = clamp01((v - species.minTreeHeight) / 10 + 0.5);
    }
  }

  const moisture = store.rasters.get("markfuktighet");
  let fMoisture = 1;
  if (moisture) {
    const v = moisture.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const cls = Math.round(v);
      if (species.vetoMoisture.includes(cls)) return 0;
      const [lo, hi] = species.moistureIdeal;
      const dist = cls < lo ? lo - cls : cls > hi ? cls - hi : 0;
      fMoisture = clamp01(1 - dist / 2);
    }
  }

  const canopy = store.rasters.get("grundyta");
  let fCanopy = 1;
  if (canopy) {
    const v = canopy.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const [lo, hi] = species.canopyIdeal;
      const dist = v < lo ? lo - v : v > hi ? v - hi : 0;
      fCanopy = clamp01(1 - dist / 10);
    }
  }

  const soil = store.rasters.get("jordart");
  let fSoil = 0.7;
  if (soil) {
    const v = soil.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const group = soil.recode?.[String(Math.round(v))] ?? "neutral";
      fSoil = species.soil[group] ?? 0.7;
    }
  }

  let fTerrain = 0.5;
  if (dem) {
    const grid = dem.sampleGridSync(easting, northing, 250);
    if (grid) {
      const aspect = aspectFromGrid(grid, 250);
      const sunExposure = Math.cos(((aspect - 180) * Math.PI) / 180);
      let terrain = 0.5 + 0.3 * species.sun * sunExposure;
      const w = grid.length;
      const c = (w - 1) / 2;
      let ringSum = 0;
      let ringN = 0;
      for (let j = 0; j < w; j++) {
        for (let i = 0; i < w; i++) {
          if (i === c && j === c) continue;
          ringSum += grid[j][i];
          ringN++;
        }
      }
      const depth = ringSum / ringN - grid[c][c];
      terrain += 0.2 * species.depression * clamp01(depth / 5);
      fTerrain = clamp01(terrain);
    }
  }

  const sEnv =
    100 * (0.35 * fMoisture + 0.25 * fMaturity + 0.2 * fCanopy + 0.1 * fSoil + 0.1 * fTerrain);

  let mBonus = 1;
  const keyBiotope = store.vectors.get("nyckelbiotoper");
  if (keyBiotope && keyBiotope.contains(easting, northing)) mBonus *= 1.3;
  if (ctx.forestEdge) mBonus *= 1 + 0.15 * species.edge;

  if (!covered) return 0.4;
  return hostGate * (sEnv / 100) * mBonus * ctx.roadFactor;
}
