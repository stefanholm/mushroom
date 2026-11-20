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
  sisIdeal?: [number, number];
  gddEnvelope?: [number, number, number, number];
  depthIdeal?: [number, number];
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
    note: "Gul trattformad hatt, ådrade skivor — narrkantarellen har riktiga skivor men är ofarlig.",
    ageIdeal: [40, 130],
    sisIdeal: [14, 24],
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
    note: "Gulbrun tratt, ihålig fot. Kontrollera varje exemplar — dödligt giftig toppig giftspindling kan växa i samma mossa.",
    ageIdeal: [30, 120],
    sisIdeal: [16, 26],
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
    note: "Rödbrun hatt, vita porer. Skilj från gallsopp (bitter, rosa porer vid snitt) — ej giftig.",
    ageIdeal: [30, 120],
    sisIdeal: [18, 28],
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
    sisIdeal: [20, 30],
  },
  jattemusseron: {
    label: "Jättemusseron/goliatmusseron (Tricholoma colossus)",
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
    note: "FRIDLYST och rödlistad (VU) i Sverige — beundra men plocka inte. Jättestor, ormskinnig fot, kaneldoft; gammal tallskog på sandig mager mark (ej matsutake).",
    ageIdeal: [60, 160],
    sisIdeal: [8, 15],
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
    sisIdeal: [10, 20],
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
    eatScore: 5,
    note: "Orange ihålig fot, veckad undersida, aprikosdoft — inga giftiga dubbelgångare.",
    ageIdeal: [30, 120],
    sisIdeal: [14, 24],
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
    eatScore: 4,
    note: "Taggar (ej skivor) under hatten — inga giftiga taggsvampar i Sverige.",
    ageIdeal: [20, 120],
    sisIdeal: [14, 24],
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
    sisIdeal: [14, 24],
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
    eatScore: 4,
    note: "Brun sammetshatt, gula porer som blånar svagt vid snitt — inga giftiga dubbelgångare.",
    ageIdeal: [30, 120],
    sisIdeal: [14, 22],
  },
  sandsopp: {
    label: "Sandsopp (Suillus variegatus)",
    seasonStart: 7,
    seasonEnd: 10.5,
    hosts: { tall: 1 },
    minHostVolume: 20,
    minTreeHeight: 8,
    vetoMoisture: [4, 5],
    moistureIdeal: [1, 2],
    canopyIdeal: [8, 22],
    soil: { acidic: 1, neutral: 0.7, calcareous: 0.3 },
    sun: 1,
    depression: 0,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "Olivgula porer på torr tallhed — omöjlig att ta fel.",
    ageIdeal: [20, 90],
    sisIdeal: [8, 15],
  },
  smorsopp: {
    label: "Smörsopp (Suillus luteus)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { tall: 1, gran: 0.3 },
    minHostVolume: 20,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [1, 3],
    canopyIdeal: [10, 25],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: 1,
    depression: 0.2,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 3,
    note: "Klibbig brun hattskinn (skala av före tillagning), ring på foten, gula porer. Koka och häll av vattnet.",
    ageIdeal: [15, 70],
    sisIdeal: [10, 18],
  },
  blomkalssvamp: {
    label: "Blomkålssvamp (Sparassis crispa)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { tall: 1 },
    minHostVolume: 30,
    minTreeHeight: 15,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [10, 25],
    soil: { acidic: 1, neutral: 0.7, calcareous: 0.3 },
    sun: 1,
    depression: 0,
    edge: 0.2,
    frostSensitive: false,
    eatScore: 4,
    note: "Blekgul 'blomkål' vid basen av gamla tallar — omöjlig att förväxla.",
    ageIdeal: [70, 160],
    sisIdeal: [8, 16],
  },
  farticka: {
    label: "Fårticka (Albatrellus ovinus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { gran: 1, tall: 0.5, bjork: 0.4 },
    minHostVolume: 25,
    minTreeHeight: 12,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [20, 35],
    soil: { acidic: 0.9, neutral: 1, calcareous: 0.9 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Små vita porer, blir citrongul vid stekning — ingen giftig dubbelgångare.",
    ageIdeal: [40, 130],
    sisIdeal: [14, 22],
  },
  "rodgul-taggsvamp": {
    label: "Rödgul taggsvamp (Hydnum rufescens)",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { gran: 1, tall: 0.6, bjork: 0.5 },
    minHostVolume: 15,
    minTreeHeight: 8,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [15, 35],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.7 },
    sun: -0.5,
    depression: 1,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "Orange mindre tvilling till blek taggsvamp — taggar under hatten, ej skivor.",
    ageIdeal: [20, 120],
    sisIdeal: [12, 22],
  },
  frostvaxing: {
    label: "Frostvaxing (Hygrophorus hypothejus)",
    seasonStart: 10,
    seasonEnd: 12,
    hosts: { tall: 1, gran: 0.4 },
    minHostVolume: 25,
    minTreeHeight: 12,
    vetoMoisture: [3, 4, 5],
    moistureIdeal: [1, 2],
    canopyIdeal: [8, 20],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: 1,
    depression: 0,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "Klibbig olivgrön hatt med gula vaxiga skivlor — håller säsongen igång in i december efter första frosten.",
    ageIdeal: [30, 100],
    sisIdeal: [8, 16],
  },
  aspsopp: {
    label: "Aspsopp (Leccinum leucopodium)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { asp: 1, bjork: 0.6, ek: 0.4 },
    minHostVolume: 15,
    minTreeHeight: 8,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [10, 25],
    soil: { acidic: 0.8, neutral: 1, calcareous: 0.9 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.8,
    frostSensitive: false,
    eatScore: 4,
    note: "Vit hatt, sträv (fjällig) fot. Koka minst 15–20 min.",
    ageIdeal: [20, 100],
    sisIdeal: [14, 24],
  },
  tegelsopp: {
    label: "Tegelsopp (Leccinum versipelle)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 1, ek: 0.5 },
    minHostVolume: 15,
    minTreeHeight: 8,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [10, 25],
    soil: { acidic: 0.9, neutral: 1, calcareous: 0.7 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Orange hatt, svarta fjäll på foten. Koka minst 15–20 min.",
    ageIdeal: [20, 100],
    sisIdeal: [14, 24],
  },
  "blek-kantarell": {
    label: "Blek kantarell (Cantharellus pallens)",
    seasonStart: 6,
    seasonEnd: 9,
    hosts: { ek: 1, hassel: 0.9, bok: 0.85, bjork: 0.3 },
    minHostVolume: 18,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [3, 4],
    canopyIdeal: [15, 30],
    soil: { calcareous: 1, acidic: 0.7, neutral: 0.8 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 5,
    note: "Blek hatt med äggula grenade åsar — aldrig tunna skivor. Syd–Mellansverige (Artportalen: lat ≤ ~59.7).",
    ageIdeal: [45, 130],
    sisIdeal: [22, 35],
  },
  kruskantarell: {
    label: "Kruskantarell (Craterellus undulatus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { ek: 1, hassel: 0.9, bok: 0.6 },
    minHostVolume: 18,
    minTreeHeight: 12,
    vetoMoisture: [1],
    moistureIdeal: [4, 4],
    canopyIdeal: [16, 32],
    soil: { calcareous: 1, acidic: 0.75, neutral: 0.85 },
    sun: -0.5,
    depression: 0.8,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Grågul krusig tratt i mullrik ek/hasselskog. Säsong aug–okt enligt Artportalen.",
    ageIdeal: [50, 140],
    sisIdeal: [22, 34],
  },
  mandelriska: {
    label: "Mandelriska (Lactifluus volemus)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { ek: 0.9, gran: 0.8, bok: 0.6, hassel: 0.5 },
    minHostVolume: 20,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [14, 28],
    soil: { acidic: 0.9, calcareous: 1, neutral: 0.9 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 5,
    note: "Styv vinkorksfot, riklig vit mjölksaft, tydlig skaldjursdoft — omöjlig att ta fel.",
    ageIdeal: [45, 130],
    sisIdeal: [20, 32],
  },
  tallblodriska: {
    label: "Tallblodriska (Lactarius deliciosus)",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { tall: 1 },
    minHostVolume: 20,
    minTreeHeight: 8,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 28],
    soil: { calcareous: 1, acidic: 0.25, neutral: 0.6 },
    sun: 1,
    depression: 0,
    edge: 0.4,
    frostSensitive: false,
    eatScore: 5,
    note: "Blöder morotsorange mjölksaft, gropig fot — alla orange-blödande riskor är ätliga. Kalkmark.",
    ageIdeal: [30, 100],
    sisIdeal: [16, 28],
  },
  granblodriska: {
    label: "Granblodriska (Lactarius deterrimus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { gran: 1 },
    minHostVolume: 18,
    minTreeHeight: 10,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [14, 34],
    soil: { acidic: 0.95, calcareous: 1, neutral: 0.9 },
    sun: -0.5,
    depression: 0.8,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "Morotsorange saft, grönärgiga fläckar på äldre hattar — alla blodriskor är ätliga. Mossig granskog.",
    ageIdeal: [20, 100],
    sisIdeal: [18, 32],
  },
  grynsopp: {
    label: "Grynsopp (Suillus granulatus)",
    seasonStart: 6,
    seasonEnd: 10,
    hosts: { tall: 1, gran: 0.3 },
    minHostVolume: 16,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [10, 26],
    soil: { calcareous: 1, acidic: 0.2, neutral: 0.6 },
    sun: 1,
    depression: 0.2,
    edge: 0.6,
    frostSensitive: false,
    eatScore: 4,
    note: "Gula rör med vätskedroppar, prickig fot utan ring, slemmig hatthud (flås av). Kalkrik tallskog.",
    ageIdeal: [20, 80],
    sisIdeal: [16, 28],
  },
  "rodbrun-stensopp": {
    label: "Rödbrun stensopp (Boletus pinophilus)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { tall: 1, gran: 0.25 },
    minHostVolume: 22,
    minTreeHeight: 12,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 28],
    soil: { acidic: 0.9, neutral: 0.9, calcareous: 0.5 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 5,
    note: "Rödbrun skrynklig hatt, vitt ådernät upptill på foten. Stark i Norr–Mellansverige (Artportalen lat till ~64.4).",
    ageIdeal: [45, 130],
    sisIdeal: [14, 25],
  },
  tallskrubb: {
    label: "Tallskrubb (Leccinum vulpinum)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { tall: 1 },
    minHostVolume: 20,
    minTreeHeight: 10,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [10, 26],
    soil: { acidic: 0.9, neutral: 0.85, calcareous: 0.4 },
    sun: 1,
    depression: 0,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "Rävröd hatt, mörka fjäll på foten under tall. Koka minst 15–20 min. Norrländsk tallhed.",
    ageIdeal: [35, 110],
    sisIdeal: [13, 24],
  },
  bjorksopp: {
    label: "Björksopp (Leccinum scabrum)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 1, asp: 0.3 },
    minHostVolume: 14,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [8, 28],
    soil: { acidic: 1, neutral: 1, calcareous: 0.85 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.8,
    frostSensitive: false,
    eatScore: 4,
    note: "Brun hatt, mörka fjäll på vit fot, vitt oförändrat kött. Hela landet ända upp i fjällbjörkskogen. Koka 15–20 min.",
    ageIdeal: [20, 100],
    sisIdeal: [12, 30],
  },
  "zonerad-granblodriska": {
    label: "Zonerad granblodriska (Lactarius fennoscandicus)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { gran: 1 },
    minHostVolume: 24,
    minTreeHeight: 14,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [16, 34],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.8 },
    sun: -0.5,
    depression: 1,
    edge: 0.2,
    frostSensitive: false,
    eatScore: 4,
    note: "Tydligt zonerad hatt, morotsorange saft som mörknar vinrött. Boreal mossig granskog (lat 58–64).",
    ageIdeal: [45, 130],
    sisIdeal: [16, 28],
  },
};

// Empirical calibration from Artportalen (via GBIF mirror, Sweden, ~2026-11):
// season windows = observed month p5–p95; GDD5 envelopes = bioclimatic niches
// (SMHI PTHBV 1991–2020 heat sum >5 °C, DEM lapse-adjusted at scoring time).
const SEASON_FROM_OBS: Record<string, [number, number]> = {
  kantarell: [6, 11],
  karljohan: [7, 10],
  trattkantarell: [8, 12],
  blomkalssvamp: [8, 11],
  "rodgul-taggsvamp": [7, 11],
  frostvaxing: [9, 12],
};
const GDD_ENVELOPE: Record<string, [number, number, number, number]> = {
  kantarell: [780, 1040, 1850, 2100],
  karljohan: [600, 820, 1850, 2100],
  trattkantarell: [740, 940, 1820, 2050],
  "svart-trumpetsvamp": [1080, 1240, 1820, 2050],
  jattemusseron: [620, 780, 1280, 1480],
  "stolt-fjallskivling": [900, 1100, 1900, 2150],
  "rodgul-trumpetsvamp": [820, 980, 1700, 1950],
  "blek-taggsvamp": [700, 900, 1850, 2050],
  varskivling: [1000, 1200, 1900, 2150],
  brunsopp: [860, 1040, 1850, 2100],
  sandsopp: [540, 700, 1720, 1950],
  smorsopp: [560, 740, 1820, 2050],
  blomkalssvamp: [780, 960, 1580, 1850],
  farticka: [640, 820, 1400, 1750],
  "rodgul-taggsvamp": [700, 900, 1820, 2050],
  frostvaxing: [680, 860, 1620, 1900],
  aspsopp: [580, 760, 1820, 2050],
  tegelsopp: [450, 600, 1750, 2050],
  "blek-kantarell": [1160, 1300, 1850, 2100],
  kruskantarell: [1180, 1320, 1850, 2050],
  mandelriska: [1160, 1300, 1800, 2050],
  tallblodriska: [820, 1020, 1800, 2050],
  granblodriska: [620, 800, 1820, 2050],
  grynsopp: [880, 1080, 1820, 2050],
  "rodbrun-stensopp": [580, 760, 1380, 1750],
  tallskrubb: [540, 700, 1280, 1550],
  bjorksopp: [420, 560, 1780, 2050],
  "zonerad-granblodriska": [580, 740, 1280, 1550],
};
const DEPTH_IDEAL: Record<string, [number, number]> = {
  karljohan: [0.8, 6],
  "svart-trumpetsvamp": [0.8, 6],
  "blek-kantarell": [0.8, 6],
  mandelriska: [0.8, 6],
  kruskantarell: [0.8, 6],
  farticka: [0.8, 6],
  granblodriska: [0.8, 6],
  jattemusseron: [0, 100],
};
for (const [k, s] of Object.entries(SPECIES)) {
  const sf = SEASON_FROM_OBS[k];
  if (sf) {
    s.seasonStart = sf[0];
    s.seasonEnd = sf[1];
  }
  const g = GDD_ENVELOPE[k];
  if (g) s.gddEnvelope = g;
  const d = DEPTH_IDEAL[k];
  if (d) s.depthIdeal = d;
}

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

  const sisL = store.rasters.get("sis");
  let fSIS = 1;
  if (sisL) {
    const v = sisL.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const [lo, hi] = species.sisIdeal ?? [0, 40];
      fSIS = v < lo ? Math.max(0.2, lo > 0 ? v / lo : 1) : v > hi ? Math.max(0.5, 1 - (v - hi) / 10) : 1;
    }
  }

  const gddL = store.rasters.get("gdd5");
  let fClimate = 1;
  let gddEff: number | null = null;
  if (gddL) {
    const g = gddL.sampleSync(easting, northing);
    if (g !== null) {
      covered = true;
      const elevV = dem ? dem.sampleSync(easting, northing) : null;
      gddEff = g - Math.max(0, elevV ?? 0) * 0.9;
      const env = species.gddEnvelope;
      if (env) {
        const [hMin, iMin, iMax, hMax] = env;
        fClimate =
          gddEff <= hMin || gddEff >= hMax
            ? 0
            : gddEff >= iMin && gddEff <= iMax
              ? 1
              : gddEff < iMin
                ? clamp01((gddEff - hMin) / Math.max(1e-6, iMin - hMin))
                : clamp01((hMax - gddEff) / Math.max(1e-6, hMax - iMax));
        if (fClimate <= 0) return 0;
      }
    }
  }

  const depthL = store.rasters.get("soildepth");
  let fDepth = 1;
  if (depthL) {
    const v = depthL.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      const [lo, hi] = species.depthIdeal ?? [0, 100];
      fDepth = v < lo ? Math.max(0.15, lo > 0 ? v / lo : 1) : v > hi ? Math.max(0.5, 1 - (v - hi) / 4) : 1;
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
    Math.pow(soft(fMoisture), 0.26) *
    Math.pow(soft(fAge), 0.18) *
    Math.pow(soft(fCanopy), 0.12) *
    Math.pow(soft(fSoil), 0.1) *
    Math.pow(soft(fSIS), 0.08) *
    Math.pow(soft(fClimate), 0.08) *
    Math.pow(soft(fDepth), 0.08) *
    Math.pow(soft(fTerrain), 0.1);
  if (dbg) {
    Object.assign(dbg, {
      hostVol,
      hostGate,
      fMoisture,
      fMaturity,
      fCanopy,
      fAge,
      fSIS,
      fClimate,
      fDepth,
      gddEff: gddEff === null ? undefined : Math.round(gddEff),
      fSoil,
      fTerrain,
      sEnv: Number(sEnv.toFixed(2)),
      covered,
    });
  }

  let mBonus = 1;
  const keyBiotope = store.vectors.get("nyckelbiotoper");
  if (keyBiotope && keyBiotope.contains(easting, northing)) mBonus *= 1.3;
  const sump = store.vectors.get("sumpskogar");
  if (sump && sump.contains(easting, northing)) mBonus *= 1.15;
  if (ctx.forestEdge) mBonus *= 1 + 0.15 * species.edge;
  if (dbg) dbg.mBonus = mBonus;

  if (!covered) return 0.4;
  return hostGate * (sEnv / 100) * mBonus * ctx.roadFactor;
}
