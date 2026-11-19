import { toSWEREF, type LayerStore, type RasterLayer } from "./layers.js";

export type SpeciesProfile = {
  label: string;
  base: number;
  seasonStart: number;
  seasonEnd: number;
  minTreeHeight: number;
  minVolume: number;
  moisture: Record<number, number>;
  soil: Record<string, number>;
  sun: number;
  depression: number;
  edge: number;
};

export type HabitatContext = {
  forestOk: boolean;
  inClearcut: boolean;
  excluded: boolean;
  roadFactor: number;
  forestEdge: boolean;
};

export const SPECIES: Record<string, SpeciesProfile> = {
  kantarell: {
    label: "Kantarell",
    base: 0.75,
    seasonStart: 7,
    seasonEnd: 10,
    minTreeHeight: 12,
    minVolume: 80,
    moisture: { 1: 0.2, 2: 1, 3: 0.8, 4: 0.4, 5: 0.1 },
    soil: { acidic: 1, calcareous: 0.6, neutral: 0.8 },
    sun: 1,
    depression: 0.3,
    edge: 1,
  },
  trattkantarell: {
    label: "Trattkantarell",
    base: 0.6,
    seasonStart: 9,
    seasonEnd: 11,
    minTreeHeight: 18,
    minVolume: 120,
    moisture: { 1: 0.1, 2: 0.5, 3: 1, 4: 1, 5: 0.6 },
    soil: { acidic: 1, calcareous: 0.4, neutral: 0.8 },
    sun: -1,
    depression: 1,
    edge: 0.2,
  },
  karljohan: {
    label: "Karljohan",
    base: 0.7,
    seasonStart: 8,
    seasonEnd: 9,
    minTreeHeight: 12,
    minVolume: 100,
    moisture: { 1: 0.3, 2: 1, 3: 0.9, 4: 0.5, 5: 0.2 },
    soil: { acidic: 0.9, calcareous: 0.8, neutral: 0.85 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.5,
  },
  "svart-trumpetsvamp": {
    label: "Svart trumpetsvamp",
    base: 0.5,
    seasonStart: 8,
    seasonEnd: 10,
    minTreeHeight: 10,
    minVolume: 60,
    moisture: { 1: 0.1, 2: 0.5, 3: 0.8, 4: 1, 5: 0.8 },
    soil: { acidic: 0.4, calcareous: 1, neutral: 0.7 },
    sun: -1,
    depression: 1,
    edge: 0.3,
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

async function aspectDegrees(dem: RasterLayer, easting: number, northing: number): Promise<number | null> {
  const spacing = 50;
  const grid = await dem.sampleGrid(easting, northing, spacing);
  if (!grid) return null;
  const w = grid.length;
  const c = (w - 1) / 2;
  const dzdx =
    (grid[0][w - 1] + 2 * grid[c][w - 1] + grid[w - 1][w - 1] - grid[0][0] - 2 * grid[c][0] - grid[w - 1][0]) /
    (8 * spacing);
  const dzdy =
    (grid[w - 1][0] + 2 * grid[w - 1][c] + grid[w - 1][w - 1] - grid[0][0] - 2 * grid[0][c] - grid[0][w - 1]) /
    (8 * spacing);
  return (((Math.atan2(dzdy, -dzdx) * 180) / Math.PI) + 360) % 360;
}

export async function staticHabitatScore(
  store: LayerStore,
  speciesKey: string,
  lon: number,
  lat: number,
  ctx: HabitatContext,
): Promise<number> {
  const species = SPECIES[speciesKey];
  if (ctx.inClearcut || ctx.excluded) return 0;
  if (!ctx.forestOk) return 0.05 * species.base;
  const [easting, northing] = toSWEREF(lon, lat);

  let habitat = species.base * ctx.roadFactor;
  if (ctx.forestEdge) habitat *= 1 + 0.15 * species.edge;

  const height = store.rasters.get("tradhojd");
  if (height) {
    const v = await height.sample(easting, northing);
    if (v !== null) habitat *= clamp01((v - 6) / Math.max(1, species.minTreeHeight - 6));
  }

  const volume = store.rasters.get("volym");
  if (volume) {
    const v = await volume.sample(easting, northing);
    if (v !== null) habitat *= clamp01(v / species.minVolume);
  }

  const moisture = store.rasters.get("markfuktighet");
  if (moisture) {
    const v = await moisture.sample(easting, northing);
    if (v !== null) habitat *= species.moisture[Math.round(v)] ?? 0.3;
  }

  const soil = store.rasters.get("jordart");
  if (soil) {
    const v = await soil.sample(easting, northing);
    if (v !== null) {
      const group = soil.recode?.[String(Math.round(v))] ?? "neutral";
      habitat *= species.soil[group] ?? 0.7;
    }
  }

  const dem = store.rasters.get("hojd");
  if (dem && dem.has(easting, northing)) {
    const elev = await dem.sample(easting, northing);
    if (elev === null || elev < 0.5) return 0;
  }
  if (dem) {
    const aspect = await aspectDegrees(dem, easting, northing);
    if (aspect !== null) {
      const sunExposure = Math.cos(((aspect - 180) * Math.PI) / 180);
      habitat *= 1 + 0.15 * species.sun * sunExposure;
      const grid = await dem.sampleGrid(easting, northing, 250);
      if (grid) {
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
        habitat *= 1 + 0.2 * species.depression * clamp01(depth / 5);
      }
    }
  }

  return habitat;
}
