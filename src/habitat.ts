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
  woodHost?: boolean;
  protected?: boolean;
  expertMode?: boolean;
  lookalikes?: string;
  plasticity?: number;
  twiIdeal?: [number, number];
  slopeIdeal?: [number, number];
  waterIdeal?: [number, number];
  structIdeal?: [number, number];
  pack?: string;
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
    note: "EXPERT: mjöldoft, täta vita skivor, köttig hatt i häxringar — varning: bolmörtsskivling (dödligt giftig) är förväxlingsart.",
    ageIdeal: [0, 60],
    sisIdeal: [14, 24],
    expertMode: true,
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
  svavelticka: {
    label: "Svavelticka (Laetiporus sulphureus)",
    seasonStart: 5,
    seasonEnd: 8,
    hosts: { ek: 1, bok: 0.5, bjork: 0.4, asp: 0.4 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [10, 30],
    soil: { acidic: 0.9, neutral: 0.9, calcareous: 1 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 4,
    note: "Svavelgula hyllor på lövträd — ALDRIG från idegran (giftig). Endast unga, mjuka exemplar.",
    ageIdeal: [40, 140],
    sisIdeal: [20, 34],
    woodHost: true,
  },
  ostronmussling: {
    label: "Ostronmussling (Pleurotus ostreatus)",
    seasonStart: 10,
    seasonEnd: 2,
    hosts: { bok: 1, bjork: 0.75, asp: 0.75, ek: 0.6 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [],
    moistureIdeal: [3, 5],
    canopyIdeal: [14, 34],
    soil: { acidic: 0.9, neutral: 0.9, calcareous: 1 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Gråblå hyllor på döda/skadade lövträd, vita nedlöpande skivor. Mild senhöst/vinter.",
    ageIdeal: [40, 140],
    sisIdeal: [20, 36],
    woodHost: true,
  },
  judasora: {
    label: "Judasöra (Auricularia auricula-judae)",
    seasonStart: 10,
    seasonEnd: 3,
    hosts: { bjork: 0.4, ek: 0.3 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [],
    moistureIdeal: [4, 5],
    canopyIdeal: [12, 32],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.8 },
    sun: 0,
    depression: 0.5,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 3,
    note: "Brun öronformad gelésvamp på fläder (ej andra träd) i milda sydsvenska vintrar. Koka alltid.",
    ageIdeal: [35, 140],
    sisIdeal: [24, 38],
    woodHost: true,
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
  "finluden-stensopp": {
    label: "Finluden stensopp (Boletus reticulatus)",
    seasonStart: 6,
    seasonEnd: 9,
    hosts: { ek: 1, bok: 0.9, hassel: 0.7, bjork: 0.4 },
    minHostVolume: 18,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 30],
    soil: { calcareous: 1, neutral: 0.95, acidic: 0.6 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 5,
    note: "Gråbrun sammetslen hatt, tydligt nät på foten, vita→gulgröna rör. Ek/bok i södra/mellersta Sverige. Förväxling: gallsopp (besk, ej giftig).",
    ageIdeal: [40, 140],
    sisIdeal: [14, 26],
  },
  blodsopp: {
    label: "Blodsopp (Neoboletus praestigiator)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bok: 1, ek: 0.9, gran: 0.6, bjork: 0.4 },
    minHostVolume: 16,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [14, 32],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.8 },
    sun: 0,
    depression: 0.3,
    edge: 0.6,
    frostSensitive: true,
    eatScore: 4,
    note: "Röd hatt och röda porer, blånar kraftigt vid snitt. Genomstek alltid (rå ger magknip). Kräver kontroll men ej dödligt förväxlande.",
    ageIdeal: [40, 140],
    sisIdeal: [14, 28],
  },
  larksopp: {
    label: "Lärksopp (Suillus grevillei)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { tall: 0.5, gran: 0.3, bjork: 0.2 },
    minHostVolume: 10,
    minTreeHeight: 8,
    vetoMoisture: [1, 5],
    moistureIdeal: [3, 4],
    canopyIdeal: [10, 30],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.5 },
    sun: 0.5,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 3,
    note: "Gul hatt med klibbiga prickar — växer strikt under lärk (planteringar). Skala av hatthuden och ta bort rörlagret.",
    ageIdeal: [20, 100],
    sisIdeal: [12, 26],
  },
  korallticka: {
    label: "Korallticka (Grifola frondosa)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { ek: 1, bok: 0.5 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [18, 34],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.7 },
    sun: -0.5,
    depression: 0.5,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 4,
    note: "Korallik buske vid foten av gamla ekar — sällsynt och naturvårdsintressant (NT). Ta bara enstaka exemplar, fotografera resten.",
    ageIdeal: [80, 160],
    sisIdeal: [22, 36],
    woodHost: true,
  },
  "fjallig-blacksvamp": {
    label: "Fjällig bläcksvamp (Coprinus comatus)",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { bjork: 0.3, ek: 0.3 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1],
    moistureIdeal: [3, 5],
    canopyIdeal: [0, 12],
    soil: { neutral: 1, calcareous: 1, acidic: 0.6 },
    sun: 1,
    depression: 0,
    edge: 1.2,
    frostSensitive: true,
    eatScore: 4,
    note: "Unga exemplar är vita, cylindriska och fjälliga — ät samma dag innan de löses upp till bläck. Undvik vägren (tungmetaller).",
    ageIdeal: [0, 80],
    sisIdeal: [10, 24],
  },
  "jatteroksvamp": {
    label: "Jätteröksvamp (Calvatia gigantea)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { bjork: 0.2, ek: 0.2 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1, 5],
    moistureIdeal: [3, 4],
    canopyIdeal: [0, 10],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.7 },
    sun: 1,
    depression: 0,
    edge: 1,
    frostSensitive: true,
    eatScore: 4,
    note: "Fotbollsstor och helvit inuti när ung — då ätlig. När insidan blir gul/oliv (sporpulver) är den ej längre matsvamp. Näringsrika ängar.",
    ageIdeal: [0, 60],
    sisIdeal: [8, 20],
  },
  toppmurkla: {
    label: "Toppmurkla (Morchella elata)",
    seasonStart: 4,
    seasonEnd: 5,
    hosts: { bjork: 0.5, asp: 0.5, ek: 0.4, gran: 0.3 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [0, 24],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.7 },
    sun: 1,
    depression: 0.3,
    edge: 1,
    frostSensitive: false,
    eatScore: 5,
    note: "EXPERT: måste vara helt ihålig från topp till fot — stenmurkla (Gyromitra) är dödligt giftig och hjärnlik. Koka/stek alltid, aldrig rå. Brandfält, barkflis, kalkskog.",
    ageIdeal: [0, 100],
    sisIdeal: [10, 24],
    expertMode: true,
  },
  "rund-toppmurkla": {
    label: "Rund toppmurkla (Morchella esculenta)",
    seasonStart: 4,
    seasonEnd: 5,
    hosts: { ek: 0.8, bok: 0.6, bjork: 0.4 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [0, 20],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.6 },
    sun: 1,
    depression: 0.2,
    edge: 1,
    frostSensitive: false,
    eatScore: 5,
    note: "EXPERT: samma murkel-checklista som toppmurkla — ihålig helt igenom, aldrig hjärnlik stenmurkla (dödligt giftig), alltid tillagad. Kalkrik lövskog (ask/alm/ek).",
    ageIdeal: [0, 100],
    sisIdeal: [10, 24],
    expertMode: true,
  },
  sillkremla: {
    label: "Sillkremla (Russula xerampelina)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { tall: 1, gran: 0.8, bjork: 0.5 },
    minHostVolume: 14,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [14, 32],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.6 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: tydlig skaldjursdoft, kött brånar vid skrap — kontrollera alltid att smaken är mild (besk/brännande = kasta). Tall/gran.",
    ageIdeal: [30, 130],
    sisIdeal: [12, 26],
    expertMode: true,
  },
  mandelkremla: {
    label: "Mandelkremla (Russula vesca)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 1, ek: 0.7, tall: 0.6, gran: 0.5 },
    minHostVolume: 12,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [12, 30],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.8 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: rosa hatt, kort hatthud blottar vita skivkanter, mild smak. Kontrollera alltid smakprovet — några kremlor är giftiga.",
    ageIdeal: [30, 130],
    sisIdeal: [12, 26],
    expertMode: true,
  },
  gronkremla: {
    label: "Grönkremla (Russula aeruginea)",
    seasonStart: 7,
    seasonEnd: 9,
    hosts: { bjork: 1, tall: 0.6, gran: 0.5 },
    minHostVolume: 12,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [14, 32],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.5 },
    sun: 0,
    depression: 0.5,
    edge: 0.6,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: grön hatt, sprött kött utan ring/strumpa — varning: lömsk flugsvamp (Amanita phalloides) är dödligt giftig. Björk.",
    ageIdeal: [30, 130],
    sisIdeal: [12, 26],
    expertMode: true,
  },
  "rokslojskivling": {
    label: "Rökslöjskivling (Hypholoma capnoides)",
    seasonStart: 9,
    seasonEnd: 11,
    hosts: { gran: 1, tall: 0.5 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1],
    moistureIdeal: [3, 5],
    canopyIdeal: [14, 34],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.6 },
    sun: -0.5,
    depression: 0.7,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: gråaktiga skivor och mild smak på granstubbar — varning: gifthätting (Galerina marginata) på samma stubbar är dödligt giftig.",
    ageIdeal: [40, 140],
    sisIdeal: [18, 32],
    woodHost: true,
    expertMode: true,
  },
  sotvaxing: {
    label: "Sotvaxing (Hygrophorus camarophyllus)",
    seasonStart: 9,
    seasonEnd: 10,
    hosts: { gran: 1 },
    minHostVolume: 24,
    minTreeHeight: 14,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [20, 38],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.6 },
    sun: -1,
    depression: 1,
    edge: 0.2,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: gråbruna, glesa, nedåtlöpande vaxartade skivor i äldre granskog. Mellersta/Norra Sverige.",
    ageIdeal: [50, 140],
    sisIdeal: [16, 30],
    expertMode: true,
  },
  vinterskivling: {
    label: "Vinterskivling (Flammulina velutipes)",
    seasonStart: 11,
    seasonEnd: 3,
    hosts: { bok: 0.8, bjork: 0.8, ek: 0.6, asp: 0.6 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [],
    moistureIdeal: [4, 5],
    canopyIdeal: [12, 32],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.8 },
    sun: 0,
    depression: 0.5,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: sammetssvart fot, vit hatt, vitt sporpulver på lövved under vintern — varning: gifthätting (dödligt giftig) förväxlas lätt.",
    ageIdeal: [30, 140],
    sisIdeal: [20, 36],
    woodHost: true,
    expertMode: true,
  },
  rimskivling: {
    label: "Rimskivling (Cortinarius caperatus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { gran: 0.8, tall: 0.8, bjork: 0.4 },
    minHostVolume: 18,
    minTreeHeight: 10,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [16, 34],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: 0,
    depression: 0.8,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: rynkad hatt med tydlig ring — men spindelskivlingar (Cortinarius) inkl. toppig giftspindling är dödligt giftiga. Endast efter säker expertkontroll.",
    ageIdeal: [40, 130],
    sisIdeal: [14, 28],
    expertMode: true,
  },
  sommartryffel: {
    label: "Sommartryffel (Tuber aestivum)",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { ek: 1, hassel: 1, bok: 0.5 },
    minHostVolume: 16,
    minTreeHeight: 10,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 30],
    soil: { calcareous: 1, neutral: 0.8, acidic: 0.3 },
    sun: 0.5,
    depression: 0.2,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 5,
    note: "EXPERT: extremt sällsynt, kalkrik ek/hassel på Gotland/Öland — kräver markägarens tillstånd, plocka aldrig i reservat. Skyddad art: koordinater är brusade i öppna data.",
    ageIdeal: [40, 140],
    sisIdeal: [14, 26],
    expertMode: true,
  },
  blamusseron: {
    label: "Blåmusseron (Lepista nuda)",
    seasonStart: 9,
    seasonEnd: 11,
    hosts: { bok: 0.8, ek: 0.6, bjork: 0.5 },
    minHostVolume: 12,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [3, 4],
    canopyIdeal: [14, 32],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.8 },
    sun: 0,
    depression: 0.5,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: lila hatt och fot med parfymerad doft i näringsrik lövskog — kräver tillagning; kontrollera mot andra blåaktiga skivlingar.",
    ageIdeal: [30, 130],
    sisIdeal: [14, 28],
    expertMode: true,
  },
  "snobolischampinjon": {
    label: "Snöbollschampinjon (Agaricus arvensis)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { bjork: 0.2, ek: 0.2 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [0, 12],
    soil: { neutral: 1, calcareous: 1, acidic: 0.6 },
    sun: 1,
    depression: 0,
    edge: 1.2,
    frostSensitive: true,
    eatScore: 4,
    note: "EXPERT: tydlig anisdoft, skivor rosa→chokladbruna — ALDRIG vita skivor (vit flugsvamp är dödligt giftig). Betesmark och gläntor.",
    ageIdeal: [0, 80],
    sisIdeal: [10, 22],
    expertMode: true,
  },
  "citronslemskivling": {
    label: "Citronslemskivling (Gomphidius glutinosus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { gran: 1, tall: 0.4 },
    minHostVolume: 24,
    minTreeHeight: 14,
    vetoMoisture: [1],
    moistureIdeal: [3, 4],
    canopyIdeal: [16, 34],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.5 },
    sun: -0.5,
    depression: 0.8,
    edge: 0.3,
    frostSensitive: false,
    eatScore: 3,
    note: "EXPERT: slemmig gråbrun hatt, nedåtlöpande skivor, lysande gul fotbas — växer alltid med gran. Mild, ta bort slemmig hatthud.",
    ageIdeal: [40, 130],
    sisIdeal: [16, 30],
    expertMode: true,
  },
  streckmusseron: {
    label: "Streckmusseron (Tricholoma portentosum)",
    seasonStart: 9,
    seasonEnd: 11,
    hosts: { tall: 1, bjork: 0.4 },
    minHostVolume: 18,
    minTreeHeight: 10,
    vetoMoisture: [1],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 30],
    soil: { acidic: 1, neutral: 0.8, calcareous: 0.4 },
    sun: 0.5,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: grå hatt med mörka strålar och svag gul ton, mjöldoft, rosa skivor — sandig tallskog i mellersta/Norra Sverige. Varning: andra musseroner.",
    ageIdeal: [40, 140],
    sisIdeal: [12, 26],
    expertMode: true,
  },
  blodriska: {
    label: "Blodriska (Lactarius deliciosus)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { tall: 1, gran: 0.6, bjork: 0.3 },
    minHostVolume: 20,
    minTreeHeight: 8,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 28],
    soil: { calcareous: 1, neutral: 0.6, acidic: 0.25 },
    sun: 1,
    depression: 0,
    edge: 0.4,
    frostSensitive: false,
    eatScore: 4,
    note: "Morotsorange mjölksaft vid snitt — alla orange-blödande riskor är ätliga. Samma art som tallblodriska (här även gran/björk).",
    ageIdeal: [30, 100],
    sisIdeal: [16, 28],
  },
  varmusseron: {
    label: "Vårmusseron (Calocybe gambosa)",
    seasonStart: 4,
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
    eatScore: 4,
    note: "EXPERT: samma art som vårskivling — mjöldoft + täta vita skivor; varning: bolmörtsskivling (dödligt giftig) är förväxlingsart. Kalkrika ängar/lövskog.",
    ageIdeal: [0, 60],
    sisIdeal: [14, 24],
    expertMode: true,
  },
  gulsopp: {
    label: "Gulsopp (Xerocomus subtomentosus)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { ek: 0.9, bok: 0.8, bjork: 0.6, hassel: 0.5 },
    minHostVolume: 12,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [12, 30],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.7 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.7,
    frostSensitive: true,
    eatScore: 4,
    note: "Gul hatthud, gula rör som blånar svagt vid tryck — ingen dödligt giftig dubbelgångare (gallsopp är bara besk). Lövskog.",
    ageIdeal: [30, 120],
    sisIdeal: [12, 26],
  },
  blasopp: {
    label: "Blåsopp (Gyroporus cyanescens)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { ek: 1, bok: 0.8, bjork: 0.6, tall: 0.4 },
    minHostVolume: 14,
    minTreeHeight: 9,
    vetoMoisture: [5],
    moistureIdeal: [2, 3],
    canopyIdeal: [12, 30],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.8 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.7,
    frostSensitive: true,
    eatScore: 4,
    note: "Vit hatt, blånar kraftigt vid snitt — ätlig (till skillnad från blodsopp har den vita porer, ej röda). Kalkrik lövskog.",
    ageIdeal: [30, 130],
    sisIdeal: [12, 26],
  },
  farsticka: {
    label: "Fårsticka (Albatrellus confluens)",
    seasonStart: 8,
    seasonEnd: 10,
    hosts: { gran: 0.8, tall: 0.6, bjork: 0.4 },
    minHostVolume: 20,
    minTreeHeight: 10,
    vetoMoisture: [4, 5],
    moistureIdeal: [2, 3],
    canopyIdeal: [18, 34],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.8 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Krämfärgad, köttig ticka i klungor — ingen giftig dubbelgångare. Förväxlas med får/fårticka (samma släkte, båda ätliga).",
    ageIdeal: [40, 130],
    sisIdeal: [14, 24],
  },
  "bla-taggsvamp": {
    label: "Blå taggsvamp (Hydnellum caeruleum)",
    seasonStart: 8,
    seasonEnd: 11,
    hosts: { tall: 1, gran: 0.5 },
    minHostVolume: 16,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [12, 30],
    soil: { acidic: 1, neutral: 0.7, calcareous: 0.3 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: false,
    eatScore: 4,
    note: "Blågrå, tydligt tandad undersida — mycket karaktäristisk, ingen dödligt giftig dubbelgångare. Tallhed.",
    ageIdeal: [30, 120],
    sisIdeal: [12, 26],
  },
  "blek-ostronmussling": {
    label: "Blek ostronmussling (Pleurotus pulmonarius)",
    seasonStart: 6,
    seasonEnd: 9,
    hosts: { bok: 1, bjork: 0.8, asp: 0.7, ek: 0.6 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [],
    moistureIdeal: [3, 5],
    canopyIdeal: [14, 34],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.8 },
    sun: 0,
    depression: 0.5,
    edge: 0.5,
    frostSensitive: true,
    eatScore: 4,
    note: "Blekare, tunnare hatt än ostronmussling, växer på död lövved på sommaren — ingen dödligt giftig dubbelgångare.",
    ageIdeal: [30, 130],
    sisIdeal: [18, 34],
    woodHost: true,
  },
  "rod-svavelticka": {
    label: "Röd svavelticka (Laetiporus cincinnatus)",
    seasonStart: 6,
    seasonEnd: 9,
    hosts: { ek: 1, bok: 0.4 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [12, 30],
    soil: { calcareous: 1, neutral: 0.9, acidic: 0.6 },
    sun: 0.5,
    depression: 0.3,
    edge: 0.8,
    frostSensitive: true,
    eatScore: 4,
    note: "Rosa-orange undersida, växer vid basen av levande ek — ALDRIG från barrträd/idegran (giftig). Endast unga exemplar.",
    ageIdeal: [60, 160],
    sisIdeal: [20, 34],
    woodHost: true,
  },
  honungsskivling: {
    label: "Honungsskivling (Armillaria mellea)",
    seasonStart: 9,
    seasonEnd: 11,
    hosts: { ek: 0.6, bjork: 0.6, bok: 0.5, gran: 0.5, tall: 0.5 },
    minHostVolume: 0,
    minTreeHeight: 0,
    vetoMoisture: [1],
    moistureIdeal: [3, 5],
    canopyIdeal: [14, 34],
    soil: { neutral: 1, calcareous: 0.9, acidic: 0.9 },
    sun: 0,
    depression: 0.5,
    edge: 0.7,
    frostSensitive: false,
    eatScore: 4,
    note: "EXPERT: honungsgul hatt med mörka fjäll, tydlig vit ring, på stubbar/rötter — koka väl och häll av kokvattnet; varning: gifthätting (Galerina marginata) på samma substrat är dödligt giftig.",
    ageIdeal: [30, 140],
    sisIdeal: [16, 32],
    woodHost: true,
    expertMode: true,
  },
  "rodnande-blacksvamp": {
    label: "Rödnande bläcksvamp (Amanita rubescens)",
    seasonStart: 7,
    seasonEnd: 10,
    hosts: { gran: 0.8, tall: 0.8, bjork: 0.6, ek: 0.5, bok: 0.4 },
    minHostVolume: 12,
    minTreeHeight: 8,
    vetoMoisture: [5],
    moistureIdeal: [2, 4],
    canopyIdeal: [14, 32],
    soil: { acidic: 1, neutral: 0.9, calcareous: 0.8 },
    sun: 0,
    depression: 0.4,
    edge: 0.6,
    frostSensitive: true,
    eatScore: 4,
    note: "EXPERT: rödbrun hatt, kött rodnar vid snitt, vit ring — varning: panterflugsvamp och lömsk flugsvamp är dödligt giftiga; alltid väl tillagad, aldrig rå.",
    ageIdeal: [30, 130],
    sisIdeal: [12, 26],
    expertMode: true,
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
  svavelticka: [1180, 1320, 1850, 2100],
  ostronmussling: [1100, 1280, 1880, 2100],
  judasora: [1400, 1520, 1950, 2200],
  "finluden-stensopp": [1050, 1250, 1900, 2100],
  blodsopp: [900, 1100, 1850, 2050],
  larksopp: [500, 700, 1800, 2000],
  korallticka: [1000, 1200, 1850, 2050],
  "fjallig-blacksvamp": [700, 900, 1900, 2100],
  "jatteroksvamp": [900, 1100, 1850, 2050],
  toppmurkla: [600, 800, 1900, 2100],
  "rund-toppmurkla": [1000, 1200, 1900, 2100],
  sillkremla: [500, 700, 1820, 2050],
  mandelkremla: [600, 800, 1850, 2050],
  gronkremla: [450, 650, 1800, 2050],
  "rokslojskivling": [600, 800, 1820, 2050],
  sotvaxing: [500, 700, 1500, 1800],
  vinterskivling: [700, 900, 1900, 2100],
  rimskivling: [550, 750, 1750, 1950],
  sommartryffel: [1300, 1500, 1950, 2150],
  blamusseron: [800, 1000, 1850, 2050],
  "snobolischampinjon": [800, 1000, 1900, 2100],
  "citronslemskivling": [500, 700, 1820, 2050],
  streckmusseron: [450, 650, 1500, 1800],
  blodriska: [820, 1020, 1800, 2050],
  varmusseron: [1000, 1200, 1900, 2150],
  gulsopp: [700, 900, 1850, 2050],
  blasopp: [900, 1100, 1850, 2050],
  farsticka: [640, 820, 1400, 1750],
  "bla-taggsvamp": [600, 800, 1820, 2050],
  "blek-ostronmussling": [900, 1100, 1850, 2050],
  "rod-svavelticka": [1150, 1350, 1900, 2100],
  honungsskivling: [700, 900, 1900, 2100],
  "rodnande-blacksvamp": [600, 800, 1850, 2050],
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
// Dödliga/farliga förväxlingsarter per art — visas som safetyCheck i UI/chatt.
// Kartan släcker ALDRIG score för förväxlingsarter (de delar biotop med matsvampen);
// varningen visas i stället på artkort och vid tryck på kartan.
const LOOKALIKES: Record<string, string> = {
  kantarell: "Narrkantarell (ofarlig — riktiga tunna skivor). Inga dödligt giftiga dubbelgångare när åsarna syns.",
  trattkantarell: "Toppig giftspindling (Cortinarius rubellus) — dödligt giftig, tunna skivor (ej åsar), samma mossa.",
  karljohan: "Gallsopp — besk men ej giftig (mörkt nät vs karljohans vita ådernät, rör vs porer).",
  "svart-trumpetsvamp": "Inga kända dödligt giftiga dubbelgångare i Sverige.",
  "blek-taggsvamp": "Inga dödligt giftiga taggsvampar i Sverige.",
  "rodgul-taggsvamp": "Inga dödligt giftiga taggsvampar i Sverige.",
  "blek-kantarell": "Narrkantarell (ofarlig). Inga dödligt giftiga dubbelgångare.",
  "stolt-fjallskivling": "Små fjällskivlingar (Lepiota) — potentiellt dödligt giftiga; kontrollera rörlig dubbelring + vattrad fot.",
  varskivling: "Bolmörtsskivling (Entoloma sinuatum) — dödligt giftig; giftrödling (Inocybe erubescens). Mjöldoft + täta vita skivor skiljer.",
  varmusseron: "Bolmörtsskivling (Entoloma sinuatum) — dödligt giftig; giftrödling (Inocybe erubescens). Samma art som vårskivling.",
  toppmurkla: "Stenmurkla (Gyromitra esculenta) — dödligt giftig (gyromitrin), hjärnlik; murklan måste vara helt ihålig.",
  "rund-toppmurkla": "Stenmurkla (Gyromitra esculenta) — dödligt giftig (gyromitrin), hjärnlik; murklan måste vara helt ihålig.",
  sillkremla: "Vissa kremlor är giftiga — smakprov: besk/brännande = kasta.",
  mandelkremla: "Vissa kremlor är giftiga — smakprov: besk/brännande = kasta.",
  gronkremla: "Lömsk flugsvamp (Amanita phalloides) — dödligt giftig; kontrollera att det saknas både ring och strumpa.",
  "rokslojskivling": "Gifthätting (Galerina marginata) — dödligt giftig på samma stubbar; gråaktiga skivor + mild smak skiljer.",
  vinterskivling: "Gifthätting (Galerina marginata) — dödligt giftig på samma ved; sammetssvart fot + vitt sporpulver skiljer.",
  honungsskivling: "Gifthätting (Galerina marginata) — dödligt giftig; tydlig vit ring + honungsgul fjällhatt skiljer. Koka och häll av vattnet.",
  rimskivling: "Toppig giftspindling (Cortinarius rubellus) & praktspindling (C. orellanus) — dödligt giftiga.",
  "snobolischampinjon": "Vit flugsvamp (Amanita virosa/phalloides) — dödligt giftig, alltid vita skivor + strumpa; karbolchampinjon (gulnar vid tryck).",
  "rodnande-blacksvamp": "Panterflugsvamp (Amanita pantherina) & lömsk flugsvamp — dödligt giftiga; kött rodnar vid snitt. Alltid tillagad.",
  svavelticka: "Får ALDRIG plockas från idegran/barrträd (giftig) — endast lövträd, unga mjuka exemplar.",
  blodriska: "Alla orange mjölksaft-blödande riskor är ätliga — ingen dödligt giftig dubbelgångare.",
  tallblodriska: "Alla orange mjölksaft-blödande riskor är ätliga — ingen dödligt giftig dubbelgångare.",
};
// Hur "flytande" arten är (0 = specialist med smalt kuvert, 1 = generalist).
// Styr hur skarpa responskurvorna är och hur mjuka de hårda trösklarna är:
// hög plasticity -> plattare kurvor, lägre krav på värdvolym/trädhöjd, bredare GDD-kuvert.
// Default 0.65. Ex: trattkantarell kan hittas "överallt" (0.9), sommartryffel/jättemusseron är strikta.
const PLASTICITY: Record<string, number> = {
  trattkantarell: 0.9,
  kantarell: 0.85,
  karljohan: 0.8,
  sandsopp: 0.8,
  smorsopp: 0.8,
  bjorksopp: 0.8,
  sommartryffel: 0.15,
  jattemusseron: 0.25,
  korallticka: 0.3,
  tallskrubb: 0.45,
  toppmurkla: 0.45,
  "rund-toppmurkla": 0.45,
  varskivling: 0.45,
  varmusseron: 0.45,
  rimskivling: 0.45,
  "rodnande-blacksvamp": 0.5,
};
// TWI-ideal per art (topografiskt fuktindex från DEM; default [5,11]).
// Fuktälskare: fuktiga svackor/hällmarkskanter. Torrt: sandiga åsar/hedar.
const TWI_IDEAL: Record<string, [number, number]> = {
  trattkantarell: [8, 15],
  "svart-trumpetsvamp": [8, 13],
  blomkalssvamp: [8, 14],
  frostvaxing: [8, 14],
  sotvaxing: [9, 15],
  granblodriska: [8, 14],
  "zonerad-granblodriska": [9, 15],
  citronslemskivling: [8, 14],
  judasora: [9, 16],
  ostronmussling: [7, 15],
  "blek-ostronmussling": [7, 15],
  honungsskivling: [7, 14],
  "rokslojskivling": [8, 15],
  vinterskivling: [7, 14],
  sandsopp: [3, 8],
  grynsopp: [4, 9],
  "rodbrun-stensopp": [3, 8],
  tallskrubb: [4, 9],
  "stolt-fjallskivling": [3, 8],
  "snobolischampinjon": [3, 8],
  "fjallig-blacksvamp": [3, 9],
  "jatteroksvamp": [3, 8],
  streckmusseron: [3, 8],
  jattemusseron: [3, 8],
  tallblodriska: [4, 9],
  blodriska: [4, 9],
};
// Lutningsideal i grader (default [0,30]). Plan mark för ängs-/gläntsarter.
const SLOPE_IDEAL: Record<string, [number, number]> = {
  blomkalssvamp: [0, 15],
  "fjallig-blacksvamp": [0, 10],
  "jatteroksvamp": [0, 8],
  "snobolischampinjon": [0, 8],
  "stolt-fjallskivling": [0, 12],
};
// Mikroklimat per art: vatten-/svacknärhet (0..1) och skogsstruktur/kantzon (0..1).
const SPECIES_MICROCLIMATE: Record<string, { waterIdeal: [number, number]; structIdeal: [number, number] }> = {
  trattkantarell: { waterIdeal: [0.45, 0.92], structIdeal: [0.45, 0.95] },
  "svart-trumpetsvamp": { waterIdeal: [0.45, 0.9], structIdeal: [0.4, 0.95] },
  "rodgul-trumpetsvamp": { waterIdeal: [0.4, 0.9], structIdeal: [0.4, 0.95] },
  blomkalssvamp: { waterIdeal: [0.5, 0.95], structIdeal: [0.5, 0.95] },
  granblodriska: { waterIdeal: [0.45, 0.9], structIdeal: [0.4, 0.95] },
  "zonerad-granblodriska": { waterIdeal: [0.5, 0.95], structIdeal: [0.45, 0.95] },
  frostvaxing: { waterIdeal: [0.45, 0.9], structIdeal: [0.45, 0.95] },
  sotvaxing: { waterIdeal: [0.5, 0.95], structIdeal: [0.5, 0.95] },
  citronslemskivling: { waterIdeal: [0.45, 0.9], structIdeal: [0.4, 0.95] },
  ostronmussling: { waterIdeal: [0.4, 0.9], structIdeal: [0.35, 0.9] },
  "blek-ostronmussling": { waterIdeal: [0.4, 0.9], structIdeal: [0.35, 0.9] },
  judasora: { waterIdeal: [0.5, 0.95], structIdeal: [0.4, 0.9] },
  honungsskivling: { waterIdeal: [0.4, 0.9], structIdeal: [0.35, 0.9] },
  "rokslojskivling": { waterIdeal: [0.45, 0.95], structIdeal: [0.4, 0.9] },
  vinterskivling: { waterIdeal: [0.4, 0.9], structIdeal: [0.35, 0.9] },
  korallticka: { waterIdeal: [0.4, 0.85], structIdeal: [0.55, 1] },
  "rod-svavelticka": { waterIdeal: [0.35, 0.8], structIdeal: [0.5, 1] },
  sandsopp: { waterIdeal: [0.1, 0.55], structIdeal: [0.3, 0.85] },
  grynsopp: { waterIdeal: [0.15, 0.6], structIdeal: [0.3, 0.85] },
  smorsopp: { waterIdeal: [0.15, 0.6], structIdeal: [0.3, 0.85] },
  larksopp: { waterIdeal: [0.15, 0.6], structIdeal: [0.3, 0.85] },
  "rodbrun-stensopp": { waterIdeal: [0.1, 0.5], structIdeal: [0.3, 0.85] },
  tallskrubb: { waterIdeal: [0.1, 0.55], structIdeal: [0.35, 0.9] },
  jattemusseron: { waterIdeal: [0.1, 0.5], structIdeal: [0.4, 0.95] },
  "stolt-fjallskivling": { waterIdeal: [0.1, 0.5], structIdeal: [0.25, 0.8] },
  "fjallig-blacksvamp": { waterIdeal: [0.1, 0.5], structIdeal: [0.15, 0.7] },
  "jatteroksvamp": { waterIdeal: [0.1, 0.5], structIdeal: [0.15, 0.7] },
  "snobolischampinjon": { waterIdeal: [0.1, 0.5], structIdeal: [0.15, 0.7] },
  streckmusseron: { waterIdeal: [0.1, 0.5], structIdeal: [0.3, 0.85] },
  sommartryffel: { waterIdeal: [0.2, 0.6], structIdeal: [0.4, 0.9] },
};
// Teman för icke-expert-arter. Gratispaketet är medvetet litet (~8 arter, bara kantarell
// som populär art) — resten ligger i packen nedan.
const SPECIES_PACK: Record<string, string> = {
  trattkantarell: "kantarell",
  "rodgul-trumpetsvamp": "kantarell",
  "rodgul-taggsvamp": "kantarell",
  "blek-kantarell": "kantarell",
  kruskantarell: "kantarell",
  karljohan: "soppar",
  smorsopp: "soppar",
  bjorksopp: "soppar",
  blomkalssvamp: "ved-tickor",
  judasora: "ved-tickor",
  "rodbrun-stensopp": "soppar",
  "finluden-stensopp": "soppar",
  blodsopp: "soppar",
  gulsopp: "soppar",
  blasopp: "soppar",
  aspsopp: "soppar",
  tegelsopp: "soppar",
  tallskrubb: "soppar",
  grynsopp: "soppar",
  larksopp: "soppar",
  mandelriska: "soppar",
  tallblodriska: "soppar",
  granblodriska: "soppar",
  blodriska: "soppar",
  "zonerad-granblodriska": "soppar",
  farticka: "ved-tickor",
  farsticka: "ved-tickor",
  korallticka: "ved-tickor",
  svavelticka: "ved-tickor",
  "rod-svavelticka": "ved-tickor",
  "blek-ostronmussling": "ved-tickor",
  honungsskivling: "ved-tickor",
  "fjallig-blacksvamp": "oppna",
  "jatteroksvamp": "oppna",
  "stolt-fjallskivling": "oppna",
  "snobolischampinjon": "oppna",
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
  const lk = LOOKALIKES[k];
  if (lk) s.lookalikes = lk;
  const pl = PLASTICITY[k];
  if (pl !== undefined) s.plasticity = pl;
  const tw = TWI_IDEAL[k];
  if (tw) s.twiIdeal = tw;
  const sl = SLOPE_IDEAL[k];
  if (sl) s.slopeIdeal = sl;
  const mc = SPECIES_MICROCLIMATE[k];
  if (mc) {
    s.waterIdeal = mc.waterIdeal;
    s.structIdeal = mc.structIdeal;
  }
  // Betalpack: expertarter -> "expert", övriga enligt tema, saknar pack = gratis.
  s.pack = s.expertMode ? "expert" : SPECIES_PACK[k];
}

export type PackInfo = {
  id: string;
  label: string;
  priceSek: number;
  kind: "species" | "all" | "pro";
  species: string[];
};

const PACK_DEFS: [string, string, number, "species" | "all" | "pro"][] = [
  ["kantarell", "Kantarellpaket", 29, "species"],
  ["soppar", "Soppar & riskor", 39, "species"],
  ["ved-tickor", "Tickor & ved-svampar", 39, "species"],
  ["oppna", "Öppna marker & gläntor", 29, "species"],
  ["expert", "Expertpaket (kontrollista krävs)", 49, "species"],
  ["all", "Alla arter", 99, "all"],
  ["pro", "Pro (allt + fläckvarning + offline)", 299, "pro"],
];

export const PACKS: Record<string, PackInfo> = Object.fromEntries(
  PACK_DEFS.map(([id, label, priceSek, kind]) => [
    id,
    {
      id,
      label,
      priceSek,
      kind,
      species: kind === "species" ? Object.entries(SPECIES).filter(([, s]) => s.pack === id).map(([k]) => k) : Object.keys(SPECIES),
    },
  ]),
);

// true om arten är upplåst med givna entitlements (tomma = gratisversionen).
export function isSpeciesUnlocked(id: string, ents: Set<string>): boolean {
  const s = SPECIES[id];
  if (!s) return false;
  if (!s.pack) return true;
  return ents.has("pro") || ents.has("all") || ents.has(s.pack);
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Mjuk band-affinitet för 0..1-lager (vatten/svacka, skogsstruktur): neutral 1.0 om
// värdet saknas; annars gaussiskt straff utanför artens idealfönster, skärpan styrs av plasticity.
function bandAffinity(value: number | null, ideal: [number, number], plast: number): number {
  if (value === null || !Number.isFinite(value)) return 1;
  const p = clamp01(plast);
  const spread = 0.08 + 0.14 * p;
  const floor = 0.25 + 0.35 * p;
  const [minV, maxV] = ideal;
  if (value >= minV && value <= maxV) return 1;
  const dist = value < minV ? minV - value : value - maxV;
  const raw = Math.exp(-((dist / Math.max(0.03, spread)) ** 2));
  return floor + (1 - floor) * raw;
}

export function seasonalFactor(species: SpeciesProfile, lat: number, now: Date): number {
  const shift = Math.min(1, Math.max(-1, (59 - lat) * 0.1));
  const month = now.getUTCMonth() + 1 + now.getUTCDate() / 30 + shift;
  const { seasonStart, seasonEnd } = species;
  if (seasonEnd < seasonStart) {
    // winter wrap (e.g. Oct–Mar): valid if month >= start−0.5 (autumn) or month <= end+0.5 (winter)
    if (month >= seasonStart - 0.5) return month < seasonStart ? (month - (seasonStart - 0.5)) / 0.5 : 1;
    if (month <= seasonEnd + 0.5) return month > seasonEnd ? 1 - (month - seasonEnd) / 0.5 : 1;
    return 0;
  }
  if (month < seasonStart - 0.5 || month > seasonEnd + 0.5) return 0;
  if (month < seasonStart) return (month - (seasonStart - 0.5)) / 0.5;
  if (month > seasonEnd) return 1 - (month - seasonEnd) / 0.5;
  return 1;
}

// Effective growing degree days (>5 °C) at a point: SMHI GDD5 raster if present,
// else a latitude fallback; always downscaled by DEM elevation (lapse −0.9 GDD per m).
export function effectiveGdd5(store: LayerStore, lon: number, lat: number): number | null {
  const [e, n] = toSWEREF(lon, lat);
  const dem = store.rasters.get("hojd");
  const elev = dem && dem.has(e, n) ? dem.sampleSync(e, n) : null;
  const elevM = elev !== null && elev >= 0 ? elev : 0;
  const gddL = store.rasters.get("gdd5");
  if (gddL && gddL.has(e, n)) {
    const g = gddL.sampleSync(e, n);
    if (g !== null) return g - elevM * 0.9;
  }
  return 2200 - (lat - 55) * 130 - elevM * 0.9;
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
  const plast = species.plasticity ?? 0.65;
  if (dbg) Object.assign(dbg, { inClearcut: ctx.inClearcut, excluded: ctx.excluded, forestOk: ctx.forestOk, roadFactor: ctx.roadFactor, forestEdge: ctx.forestEdge, plasticity: plast });
  // Plasticity mjukar upp de hårda trösklarna: generalister fruktar vid lägre värdvolym/trädhöjd.
  const minHostEff = species.minHostVolume * (1 - 0.6 * plast);
  const minTreeEff = species.minTreeHeight * (1 - 0.5 * plast);
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
  if (species.woodHost) {
    anyHost = true;
    covered = true;
  }
  for (const [tree, w] of !species.woodHost ? Object.entries(species.hosts) : []) {
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
  if (species.woodHost) {
    hostGate = 1;
  } else if (anyHost) {
    if (hostVol < minHostEff) return 0;
    hostGate = 0.1 + 0.9 * clamp01(hostVol / (3 * Math.max(1e-6, minHostEff)));
  } else {
    const vol = store.rasters.get("volym");
    if (vol) {
      const v = vol.sampleSync(easting, northing);
      if (v !== null) {
        covered = true;
        if (v < minHostEff) return 0;
        hostGate = 0.1 + 0.9 * clamp01(v / (3 * Math.max(1e-6, minHostEff)));
      }
    }
  }

  const ageL = store.rasters.get("alder");
  let ageV: number | null = null;
  let fAge = 1;
  if (ageL) {
    const v = ageL.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      ageV = v;
      const [lo, hi] = species.ageIdeal ?? [0, 250];
      fAge = v < lo ? Math.max(0.2, lo > 0 ? v / lo : 1) : v > hi ? Math.max(0.5, 1 - (v - hi) / 80) : 1;
    }
  }

  const height = store.rasters.get("tradhojd");
  let fMaturity = 1;
  if (height) {
    const v = height.sampleSync(easting, northing);
    if (v !== null) {
      covered = true;
      // Gamla men lågvuxna bestånd (hällmark/tallhed, där t.ex. jättemusseron trivs):
      // hög ålder kompenserar för låg trädhöjd så låg plasticity inte straffar dem.
      const relax = ageV !== null && ageV >= 80 ? 0.5 : 1;
      if (v < minTreeEff * relax) return 0;
      fMaturity = clamp01((v - minTreeEff) / 16 + 0.35);
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

  let fClimate = 1;
  const gddEff = effectiveGdd5(store, lon, lat);
  if (gddEff !== null && species.gddEnvelope) {
    // Plasticity breddar GDD-kuvertet (generalister tolererar mer värme/kyla).
    const gm = plast * 150;
    const [hMin, iMin, iMax, hMax] = species.gddEnvelope;
    const hMinE = hMin - gm;
    const hMaxE = hMax + gm;
    fClimate =
      gddEff <= hMinE || gddEff >= hMaxE
        ? 0
        : gddEff >= iMin && gddEff <= iMax
          ? 1
          : gddEff < iMin
            ? clamp01((gddEff - hMinE) / Math.max(1e-6, iMin - hMinE))
            : clamp01((hMaxE - gddEff) / Math.max(1e-6, hMaxE - iMax));
    if (fClimate <= 0) return 0;
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

  const twiL = store.rasters.get("twi");
  let fTWI = 1;
  if (twiL) {
    const raw = twiL.sampleSync(easting, northing);
    if (raw !== null) {
      covered = true;
      // hårt tak: extrem TWI på nästan plan mark (myrkanter) får inte spika faktorn
      const v = Math.min(raw, 18);
      const [lo, hi] = species.twiIdeal ?? [5, 11];
      const dist = v < lo ? lo - v : v > hi ? v - hi : 0;
      fTWI = clamp01(1 - dist / 4);
    }
  }

  const waterL = store.rasters.get("water_rel");
  const fWaterHollow = bandAffinity(waterL ? waterL.sampleSync(easting, northing) : null, species.waterIdeal ?? [0.25, 0.85], plast);
  if (waterL) covered = true;
  const structL = store.rasters.get("stand_struct");
  const fStandStruct = bandAffinity(structL ? structL.sampleSync(easting, northing) : null, species.structIdeal ?? [0.35, 0.95], plast);
  if (structL) covered = true;

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

  // Lutning (grader) från DEM: kombineras med terrängfaktorn ovan.
  const slopeL = store.rasters.get("slope");
  let fSlope = 1;
  if (slopeL) {
    const sv = slopeL.sampleSync(easting, northing);
    if (sv !== null) {
      covered = true;
      const [lo, hi] = species.slopeIdeal ?? [0, 30];
      const dist = sv < lo ? lo - sv : sv > hi ? sv - hi : 0;
      fSlope = clamp01(1 - dist / 15);
      fTerrain = clamp01(0.7 * fTerrain + 0.3 * fSlope);
    }
  }

  // Plasticity styr kurvornas skärpa: hög plasticity -> låga exponenter (platt, förlåtande),
  // låg plasticity -> höga exponenter + högre golv (nästan binärt: exakt dessa faktorer krävs).
  const sharp = 1.8 - 1.6 * plast;
  const floor = 0.05 + 0.25 * (1 - plast);
  const soft = (x: number) => Math.max(floor, x);
  const sEnv =
    100 *
    Math.pow(soft(fMoisture), 0.2 * sharp) *
    Math.pow(soft(fAge), 0.15 * sharp) *
    Math.pow(soft(fCanopy), 0.1 * sharp) *
    Math.pow(soft(fSoil), 0.09 * sharp) *
    Math.pow(soft(fSIS), 0.07 * sharp) *
    Math.pow(soft(fClimate), 0.07 * sharp) *
    Math.pow(soft(fDepth), 0.07 * sharp) *
    Math.pow(soft(fTerrain), 0.08 * sharp) *
    Math.pow(soft(fTWI), 0.07 * sharp) *
    Math.pow(soft(fWaterHollow), 0.05 * sharp) *
    Math.pow(soft(fStandStruct), 0.05 * sharp);
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
      fSlope,
      fTWI,
      fWaterHollow,
      fStandStruct,
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
