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
    out.push({ id, scientificName: sci, dyntaxaId: null, gbifKey: m.usageKey ?? null, gbifStatus: m.status, canonical: m.canonicalName });
    console.log(`${id}: GBIF key ${m.usageKey} (${m.canonicalName}, ${m.status})`);
    await sleep(400);
  }
  return out;
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
  for (const t of taxa) {
    if (!t.gbifKey) continue;
    const base = `${GBIF}/occurrence/search?dataset_key=${ARTportalen_DATASET}&taxon_key=${t.gbifKey}` +
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
  }
  return { type: "FeatureCollection", name: "artportalen-observations", bbox, features };
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
console.log("Nästa steg: kör AUC mot modellens score (se docs/SCORING.md §5) — skicka fyndens koordinater till /api/debug/cell.");
