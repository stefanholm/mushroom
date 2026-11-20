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
  vetoSoil?: string[];
  sun: number;
  depression: number;
  edge: number;
  frostSensitive: boolean;
  eatScore: number;
  note: string;
  ageIdeal?: [number, number];
  protected?: boolean;
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
    eatScore: 5,
    note: "Gul trattformad hatt, ådrade skivor — inga giftiga dubbelgångare i Sverige.",
    ageIdeal: [40, 130],
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
    eatScore: 4,
    note: "Gulbrun tratt, ihålig fot — inga giftiga dubbelgångare.",
    ageIdeal: [30, 120],
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
    eatScore: 5,
    note: "Rödbrun hatt, vita rör. Skilj från gallsopp (bitter, rosa rör vid snitt).",
    ageIdeal: [30, 120],
  },
  "svart-trumpetsvamp": {
    label: "Svart trumpetsvamp",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { ek: 1, hassel: 0.8, bok: 0.4, bjork: 0.3 },
    minHostVolume: 15,
    minTreeHeight: 12,
    vetoMoisture: [1, 2],
    moistureIdeal: [4, 4],
    canopyIdeal: [22, 35],
    soil: { calcareous: 1, neutral: 0.7, acidic: 0.2 },
    vetoSoil: ["acidic"],
    sun: -1,
    depression: 1,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 5,
    note: "Svart tratt, ihålig — mycket svår att förväxla. Kräver kalkrik lövskog.",
    ageIdeal: [40, 130],
  },
  jattemusseron: {
    label: "Jättemusseron (goliatmusseron)",
    seasonStart: 8,
    seasonEnd: 10.5,
    hosts: { tall: 1, gran: 0.2 },
    minHostVolume: 40,
    minTreeHeight: 18,
    vetoMoisture: [4, 5],
    moistureIdeal: [1, 2],
    canopyIdeal: [10, 25],
    soil: { acidic: 1, neutral: 0.7, calcareous: 0.3 },
    sun: 1,
    depression: 0.2,
    edge: 0.2,
    frostSensitive: false,
    eatScore: 5,
    note: "FRIDLYST i Sverige — beundra men plocka inte. Jättestor med ormskinnig fot och vit sporer; växer i gammal tallskog på sandig mark.",
    ageIdeal: [60, 160],
    protected: true,
  },
  "stolt-fjallskivling": {
    label: "Stolt fjällskivling",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 0.7, ek: 0.6, bok: 0.4, hassel: 0.4 },
    minHostVolume: 5,
    minTreeHeight: 0,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [0, 18],
    soil: { neutral: 1, acidic: 0.8, calcareous: 0.9 },
    sun: 1,
    depression: 0,
    edge: 1.5,
    frostSensitive: true,
    eatScore: 4,
    note: "Vit sporer, ormmönstrad fot, rörlig ring. Små fjällskivlingar (Lepiota) kan vara dödligt giftiga — kontrollera alltid storlek, ormskinn och ring.",
    ageIdeal: [0, 80],
  },
  "rodgul-trumpetsvamp": {
    label: "Rödgul trumpetsvamp",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { gran: 1, tall: 0.4, bjork: 0.2 },
    minHostVolume: 25,
    minTreeHeight: 12,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [20, 40],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.5 },
    sun: -1,
    depression: 1,
    edge: 0.2,
    frostSensitive: false,
    eatScore: 4,
    note: "Gul fot, ihålig, veckad undersida — inga giftiga dubbelgångare.",
    ageIdeal: [30, 120],
  },
  "blek-taggsvamp": {
    label: "Blek taggsvamp",
    seasonStart: 8,
    seasonEnd: 10.5,
    hosts: { gran: 0.8, bok: 0.7, ek: 0.7, bjork: 0.6, tall: 0.5 },
    minHostVolume: 15,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [15, 35],
    soil: { acidic: 0.9, neutral: 1, calcareous: 0.9 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 3,
    note: "Taggar (ej skivor) under hatten — inga giftiga taggsvampar i Sverige.",
    ageIdeal: [20, 120],
  },
  varskivling: {
    label: "Vårskivling",
    seasonStart: 4.5,
    seasonEnd: 6,
    hosts: { bjork: 0.7, ek: 0.6, hassel: 0.5, bok: 0.4 },
    minHostVolume: 5,
    minTreeHeight: 0,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [0, 20],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.6 },
    sun: 1,
    depression: 0,
    edge: 1.2,
    frostSensitive: true,
    eatScore: 3,
    note: "Mjöldoft, köttig hatt; växer ofta i häxringar på ängar och skogsbryn — vårens första matsvamp.",
    ageIdeal: [0, 60],
  },
  brunsopp: {
    label: "Brunsopp",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { tall: 1, gran: 0.7, bjork: 0.3 },
    minHostVolume: 20,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [15, 30],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 3,
    note: "Brun sammetshatt, gula rör som blånar vid snitt — tydligt kännetecken.",
    ageIdeal: [30, 120],
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
  dbg?: Record<string, unknown>,
): number {
  const species = SPECIES[speciesKey];
  if (dbg) Object.assign(dbg, { inClearcut: ctx.inClearcut, excluded: ctx.excluded, forestOk: ctx.forestOk, roadFactor: ctx.roadFactor, forestEdge: ctx.forestEdge });
  if (ctx.inClearcut || ctx.excluded) return 0;
  if (!ctx.forestOk) return 0;
  const [easting, northing] = toSWEREF(lon, lat);

  const dem = store.rasters.get("hojd");
  let covered = false;
  if (dem && dem.has(easting, northing)) {
    const elev = dem.sampleSync(easting, northing);
    if (dbg) dbg.elev = elev;
    if (elev === null || elev < 0.5) return 0;
    covered = true;
  }
  if (store.mask && store.mask.has(easting, northing) && !store.mask.allows(easting, northing)) {
    if (dbg) dbg.maskVeto = true;
    return 0;
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
    hostGate = 0.1 + 0.9 * clamp01(hostVol / (3 * species.minHostVolume));
  } else {
    const vol = store.rasters.get("volym");
    if (vol) {
      const v = vol.sampleSync(easting, northing);
      if (v !== null) {
        covered = true;
        if (v < species.minHostVolume) return 0;
        hostGate = 0.1 + 0.9 * clamp01(v / (3 * species.minHostVolume));
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
      fMaturity = clamp01((v - species.minTreeHeight) / 16 + 0.35);
    }
  }

  const ageL = store.rasters.get("alder");
  let fAge = 1;
  if (ageL) {
    const v = ageL.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const [lo, hi] = species.ageIdeal ?? [0, 250];
      fAge = v < lo ? Math.max(0.2, lo > 0 ? v / lo : 1) : v > hi ? Math.max(0.5, 1 - (v - hi) / 80) : 1;
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
      fMoisture = clamp01(1 - dist / 1.5);
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
      fCanopy = clamp01(1 - dist / 6);
    }
  }

  const soil = store.rasters.get("jordart");
  let fSoil = 0.7;
  if (soil) {
    const v = soil.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const group = soil.recode?.[String(Math.round(v))] ?? "neutral";
      if (species.vetoSoil?.includes(group)) return 0;
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

  const soft = (x: number) => Math.max(0.05, x);
  const sEnv =
    100 *
    Math.pow(soft(fMoisture), 0.32) *
    Math.pow(soft(fMaturity), 0.22) *
    Math.pow(soft(fCanopy), 0.18) *
    Math.pow(soft(fAge), 0.1) *
    Math.pow(soft(fSoil), 0.09) *
    Math.pow(soft(fTerrain), 0.09);
  if (dbg) {
    Object.assign(dbg, {
      hostVol,
      hostGate,
      fMoisture,
      fMaturity,
      fCanopy,
      fAge,
      fSoil,
      fTerrain,
      sEnv: Number(sEnv.toFixed(2)),
      covered,
    });
  }

  let mBonus = 1;
  const keyBiotope = store.vectors.get("nyckelbiotoper");
  if (keyBiotope && keyBiotope.contains(easting, northing)) mBonus *= 1.3;
  if (ctx.forestEdge) mBonus *= 1 + 0.15 * species.edge;
  if (dbg) dbg.mBonus = mBonus;

  if (!covered) return 0.4;
  return hostGate * (sEnv / 100) * mBonus * ctx.roadFactor;
}
