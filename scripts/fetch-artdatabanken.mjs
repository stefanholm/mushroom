#!/usr/bin/env node
// One-shot fetch of species metadata + observation data for validating the
// hotspot model against real finds.
//
//   npm run artfakta                          # demo bbox, GBIF route (no key needed)
//   npm run artfakta -- --bbox 17.6,59.0,18.6,59.8 --limit 1000
//   ARTDATABANKEN_API_KEY=... npm run artfakta   # official Artfakta API (subscription key from api-portal.artdatabanken.se)
//
// Writes (git-ignored):
//   data/species/artfakta.json        species facts (Artfakta API if key, else GBIF backbone info)
//   data/validation/observations.geojson   Artportalen occurrences via GBIF mirror (dataset 38b4c89f-...)
//
// Note: skyddsklassade arter (e.g. jättemusseron) are coordinate-blurred in public data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const bbox = opt("bbox", "17.7,59.1,18.5,59.7").split(",").map(Number);
const limit = Number(opt("limit", 300));
const [minLon, minLat, maxLon, maxLat] = bbox;

const API_KEY = process.env.ARTDATABANKEN_API_KEY ?? "";
const API_TOKEN = process.env.ARTDATABANKEN_TOKEN ?? "";
const ARTFAKTA_BASE = "https://api.artdatabanken.se/information/v1/speciesdataservice/v1";
const GBIF = "https://api.gbif.org/v1";
const ARTportalen_DATASET = "38b4c89f-584c-41bb-bd8f-cd1def33e92f";

const SPECIES = [
  ["kantarell", "Cantharellus cibarius"],
  ["trattkantarell", "Craterellus tubaeformis"],
  ["karljohan", "Boletus edulis"],
  ["svart-trumpetsvamp", "Craterellus cornucopioides"],
  ["jattemusseron", "Tricholoma colossus"],
  ["stolt-fjallskivling", "Macrolepiota procera"],
  ["rodgul-trumpetsvamp", "Craterellus lutescens"],
  ["blek-taggsvamp", "Hydnum repandum"],
  ["varskivling", "Calocybe gambosa"],
  ["brunsopp", "Imleria badia"],
  ["sandsopp", "Suillus variegatus"],
  ["smorsopp", "Suillus luteus"],
  ["blomkalssvamp", "Sparassis crispa"],
  ["farticka", "Albatrellus ovinus"],
  ["rodgul-taggsvamp", "Hydnum rufescens"],
  ["frostvaxing", "Hygrophorus hypothejus"],
  ["aspsopp", "Leccinum leucopodium"],
  ["tegelsopp", "Leccinum versipelle"],
  ["blek-kantarell", "Cantharellus pallens"],
  ["kruskantarell", "Craterellus undulatus"],
  ["mandelriska", "Lactifluus volemus"],
  ["tallblodriska", "Lactarius deliciosus"],
  ["granblodriska", "Lactarius deterrimus"],
  ["grynsopp", "Suillus granulatus"],
  ["rodbrun-stensopp", "Boletus pinophilus"],
  ["tallskrubb", "Leccinum vulpinum"],
  ["bjorksopp", "Leccinum scabrum"],
  ["zonerad-granblodriska", "Lactarius fennoscandicus"],
  ["svavelticka", "Laetiporus sulphureus"],
  ["ostronmussling", "Pleurotus ostreatus"],
  ["judasora", "Auricularia auricula-judae"],
  ["finluden-stensopp", "Boletus reticulatus"],
  ["blodsopp", "Neoboletus praestigiator"],
  ["larksopp", "Suillus grevillei"],
  ["korallticka", "Grifola frondosa"],
  ["fjallig-blacksvamp", "Coprinus comatus"],
  ["jatteroksvamp", "Calvatia gigantea"],
  ["toppmurkla", "Morchella elata"],
  ["rund-toppmurkla", "Morchella esculenta"],
  ["sillkremla", "Russula xerampelina"],
  ["mandelkremla", "Russula vesca"],
  ["gronkremla", "Russula aeruginea"],
  ["rokslojskivling", "Hypholoma capnoides"],
  ["sotvaxing", "Hygrophorus camarophyllus"],
  ["vinterskivling", "Flammulina velutipes"],
  ["rimskivling", "Cortinarius caperatus"],
  ["sommartryffel", "Tuber aestivum"],
  ["blamusseron", "Lepista nuda"],
  ["snobolischampinjon", "Agaricus arvensis"],
  ["citronslemskivling", "Gomphidius glutinosus"],
  ["streckmusseron", "Tricholoma portentosum"],
  ["blodriska", "Lactarius deliciosus"],
  ["varmusseron", "Calocybe gambosa"],
  ["gulsopp", "Xerocomus subtomentosus"],
  ["blasopp", "Gyroporus cyanescens"],
  ["brodticka", "Albatrellus confluens"],
  ["bla-taggsvamp", "Hydnellum caeruleum"],
  ["blek-ostronmussling", "Pleurotus pulmonarius"],
  ["rod-svavelticka", "Laetiporus cincinnatus"],
  ["honungsskivling", "Armillaria mellea"],
  ["rodnande-blacksvamp", "Amanita rubescens"],
];

// Manuell alias-karta för arter vars Artportalen-fynd ligger under ett annat namn.
// OBS: sommartryffel (Tuber aestivum) har i praktiken INGA georefererade fynd i Artportalen —
// tryffel-lokaler är sekretessbelagda (hasCoordinate ger 0 träffar). Lämna tom så rapporteras
// arten ärligt som "saknar observationslager"; fyll på med ett taxonomiskt korrekt alias om
// Artdatabanken börjar publicera koordinater (t.ex. "Tuber aestivum/uncinatum").
const ALIASES = {
  // "sommartryffel": ["Tuber aestivum/uncinatum"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gbifJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": "mushroom-finder/1.0 (research)" } });
    if (r.status === 429) {
      const wait = 20_000 * (i + 1);
      console.error(`GBIF 429 — väntar ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`GBIF HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("GBIF rate-limited (429) — försök igen senare eller använd ARTDATABANKEN_API_KEY");
}

async function artfaktaJson(pathname, tries = 2) {
  const headers = {};
  if (API_KEY) headers["Ocp-Apim-Subscription-Key"] = API_KEY;
  if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(ARTFAKTA_BASE + pathname, { headers });
    if (r.status === 401 || r.status === 403) {
      throw new Error("Artfakta API kräver prenumerationsnyckel — sätt ARTDATABANKEN_API_KEY (från api-portal.artdatabanken.se)");
    }
    if (!r.ok) throw new Error(`Artfakta HTTP ${r.status}`);
    return r.json();
  }
}

async function resolveTaxonIds() {
  const out = [];
  for (const [id, sci] of SPECIES) {
    if (API_KEY || API_TOKEN) {
      try {
        const s = await artfaktaJson(`/speciesdata/search?searchString=${encodeURIComponent(sci)}`);
        const hits = Array.isArray(s) ? s : (s.result ?? s.items ?? []);
        const exact = hits.find((h) => (h.scientificName ?? h.name ?? "").toLowerCase().startsWith(sci.toLowerCase())) ?? hits[0];
        const taxonId = exact?.taxonID ?? exact?.id ?? exact?.taxonId;
        out.push({ id, scientificName: sci, dyntaxaId: taxonId ?? null, gbifKey: null });
        console.log(`${id}: Dyntaxa ${taxonId ?? "?"} (${sci})`);
        await sleep(300);
        continue;
      } catch (e) {
        console.error(`${id}: Artfakta search misslyckades (${e.message}) — faller tillbaka på GBIF`);
      }
    }
    const m = await gbifJson(`${GBIF}/species/match?name=${encodeURIComponent(sci)}`);
    // SYNONYM (t.ex. Albatrellus confluens) har sina Artportalen-fynd under accepted-nyckeln —
    // använd acceptedUsageKey, men med kollisionsskydd: om accepted redan används av en annan
    // art i vår lista (t.ex. Laetiporus cincinnatus -> L. sulphureus = vår svavelticka), behåll
    // synonym-nyckeln som fallbackKey och låt resolveOccurrenceQuery prova vidare.
    const accepted = m.acceptedUsageKey ?? null;
    const used = new Set(out.map((t) => t.gbifKey));
    const key = m.status === "ACCEPTED" || !accepted || used.has(accepted) ? m.usageKey ?? null : accepted;
    out.push({
      id,
      scientificName: sci,
      dyntaxaId: null,
      gbifKey: key,
      gbifFallbackKey: m.usageKey ?? null,
      gbifStatus: m.status,
      canonical: m.canonicalName,
    });
    console.log(`${id}: GBIF key ${key} (${m.canonicalName}, ${m.status})`);
    await sleep(400);
  }
  return out;
}

// Antal Artportalen-fynd (med koordinater, i bbox) för en extra query-sträng.
async function occurrenceCount(extra) {
  const j = await gbifJson(
    `${GBIF}/occurrence/search?dataset_key=${ARTportalen_DATASET}` +
      `&decimalLatitude=${minLat},${maxLat}&decimalLongitude=${minLon},${maxLon}&hasCoordinate=true&limit=0&${extra}`,
  );
  return j.count ?? 0;
}

// Hitta bästa GBIF-query för en art: taxon_key (eget) -> fallbackKey -> accepted/synonymer ->
// scientific_name verbatim -> släkte-nivå + verbatim namn. Returnerar null om Artportalen
// helt saknar arten (då får arten helt enkelt inga observationer — loggas i coverage).
async function resolveOccurrenceQuery(t) {
  const keys = [...new Set([t.gbifKey, t.gbifFallbackKey].filter(Boolean))];
  for (const k of keys) {
    if ((await occurrenceCount(`taxon_key=${k}`)) > 0) return { taxonKey: k };
  }
  for (const alias of ALIASES[t.id] ?? []) {
    if ((await occurrenceCount(`scientific_name=${encodeURIComponent(alias)}`)) > 0) return { sciName: alias };
  }
  const baseKey = t.gbifKey ?? t.gbifFallbackKey;
  if (baseKey) {
    try {
      const syn = await gbifJson(`${GBIF}/species/${baseKey}/synonyms?limit=50`);
      for (const s of syn.results ?? []) {
        if (s.key && (await occurrenceCount(`taxon_key=${s.key}`)) > 0) return { taxonKey: s.key };
      }
    } catch {}
  }
  if ((await occurrenceCount(`scientific_name=${encodeURIComponent(t.scientificName)}`)) > 0) {
    return { sciName: t.scientificName };
  }
  const genus = t.scientificName.split(" ")[0];
  try {
    const gm = await gbifJson(`${GBIF}/species/match?name=${encodeURIComponent(genus)}`);
    if (
      gm.usageKey &&
      (await occurrenceCount(`taxon_key=${gm.usageKey}&scientific_name=${encodeURIComponent(t.scientificName)}`)) > 0
    ) {
      return { genusKey: gm.usageKey, sciName: t.scientificName };
    }
  } catch {}
  return null;
}

async function fetchArtfakta(taxa) {
  const ids = taxa.map((t) => t.dyntaxaId).filter(Boolean);
  if (ids.length === 0) return null;
  const q = ids.join(",");
  const [data, redlist, biotopes, texts] = await Promise.all([
    artfaktaJson(`/speciesdata?taxa=${q}`),
    artfaktaJson(`/speciesdata/redlist?taxa=${q}`).catch(() => null),
    artfaktaJson(`/speciesdata/biotopes?taxa=${q}`).catch(() => null),
    artfaktaJson(`/speciesdata/texts?taxa=${q}`).catch(() => null),
  ]);
  return { fetchedAt: new Date().toISOString(), taxa: ids, speciesdata: data, redlist, biotopes, texts };
}

async function fetchObservations(taxa) {
  const features = [];
  const coverage = {};
  for (const t of taxa) {
    if (!t.gbifKey && !t.gbifFallbackKey) continue;
    const q = await resolveOccurrenceQuery(t);
    if (!q) {
      console.log(`  ${t.id}: INGA Artportalen-fynd för ${t.scientificName} — arten saknar observationslager`);
      coverage[t.id] = 0;
      continue;
    }
    const taxParam = q.taxonKey
      ? `&taxon_key=${q.taxonKey}`
      : `&taxon_key=${q.genusKey}&scientific_name=${encodeURIComponent(q.sciName)}`;
    const base = `${GBIF}/occurrence/search?dataset_key=${ARTportalen_DATASET}${taxParam}` +
      `&decimalLatitude=${minLat},${maxLat}&decimalLongitude=${minLon},${maxLon}` +
      `&hasCoordinate=true&limit=300`;
    let offset = 0;
    let total = Infinity;
    let got = 0;
    while (offset < total && got < limit) {
      const j = await gbifJson(`${base}&offset=${offset}`);
      total = j.count ?? 0;
      for (const r of j.results ?? []) {
        if (got >= limit) break;
        if (r.decimalLatitude == null || r.decimalLongitude == null) continue;
        if (got >= limit) break;
        got++;
        features.push({
          type: "Feature",
          properties: {
            species: t.id,
            scientificName: r.scientificName ?? t.scientificName,
            eventDate: r.eventDate ?? null,
            basisOfRecord: r.basisOfRecord ?? null,
            uncertaintyM: r.coordinateUncertaintyInMeters ?? null,
            datasetName: r.datasetName ?? "Artportalen",
          },
          geometry: { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] },
        });
      }
      offset += (j.results ?? []).length;
      if ((j.results ?? []).length === 0) break;
      console.log(`  ${t.id}: ${Math.min(got, total)}/${Math.min(total, limit)} fynd`);
      await sleep(500);
    }
    coverage[t.id] = got;
  }
  return { type: "FeatureCollection", name: "artportalen-observations", bbox, features, coverage };
}

const taxa = await resolveTaxonIds();
fs.mkdirSync(path.join(root, "data", "species"), { recursive: true });
fs.mkdirSync(path.join(root, "data", "validation"), { recursive: true });

let artfakta = null;
if (API_KEY || API_TOKEN) {
  try {
    artfakta = await fetchArtfakta(taxa);
    console.log("Artfakta speciesdata hämtad");
  } catch (e) {
    console.error("Artfakta-fetch misslyckades:", e.message);
  }
}
const gbifInfo = {};
for (const t of taxa) if (t.gbifKey) gbifInfo[t.id] = t;
fs.writeFileSync(
  path.join(root, "data", "species", "artfakta.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString(), taxa, artfakta, gbif: gbifInfo }, null, 2),
);

const obs = await fetchObservations(taxa);
fs.writeFileSync(path.join(root, "data", "validation", "observations.geojson"), JSON.stringify(obs));
console.log(`KLART: ${obs.features.length} observationer i data/validation/observations.geojson, metadata i data/species/artfakta.json`);
const cov = obs.coverage ?? {};
const missing = SPECIES.map(([id]) => id).filter((id) => !cov[id]);
console.log(`Täckning: ${Object.keys(cov).filter((k) => cov[k] > 0).length}/${SPECIES.length} arter har fynd` + (missing.length ? ` — saknar: ${missing.join(", ")}` : " — 61/61 OK"));
console.log("Nästa steg: kör AUC mot modellens score (se docs/SCORING.md §5) — skicka fyndens koordinater till /api/debug/cell.");
