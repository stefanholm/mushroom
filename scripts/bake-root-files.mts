// bake-root-files.mts — generera R2-root-filerna (manifest/catalog/shop) UTAN att Node-servern kör.
// Samma payloads som /api/v1/manifest, /api/v1/catalog och /api/shop (med tomma ents).
// Kör:  npx tsx scripts/bake-root-files.mts [--out data/r2] [--rev r15]
// Synka sedan:  node scripts/sync-r2.mjs --rev r15 --only root
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPECIES, PACKS, FREE_SPECIES, SVENSKA_KLASSIKER_SPECIES,
  SINGLE_PRICE_SEK, SOLO_ONLY_SPECIES, TOP_PICKS, isValidSingleClaim,
} from "../src/habitat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const outDir = path.resolve(arg("out", path.join(here, "..", "data", "r2")));

// TILE_VERSION från src/server.ts (samma källa som /api/v1/manifest)
const serverSrc = fs.readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");
const m = /TILE_VERSION\s*=\s*"([^"]+)"/.exec(serverSrc);
const tileRev = arg("rev", m?.[1] ?? "r15");
const SWEDEN = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const year = new Date().getFullYear();
const FREE_HIDE_FRACTION = 0.3;

const catalog = {
  api: "v1",
  generatedAt: new Date().toISOString(),
  tileRev,
  freeSpecies: FREE_SPECIES,
  klassiker: SVENSKA_KLASSIKER_SPECIES,
  packs: Object.values(PACKS).map((p) => ({ id: p.id, label: p.label, priceSek: p.priceSek, species: p.species, kind: p.kind, forSale: p.forSale !== false })),
  singlePriceSek: SINGLE_PRICE_SEK,
  species: Object.entries(SPECIES).map(([id, s]) => ({
    id, label: s.label, season: [s.seasonStart, s.seasonEnd], pack: s.pack ?? null,
    protected: !!s.protected, eatScore: s.eatScore, rainWindowDays: s.rainWindowDays ?? 28,
  })),
};

// samma fält som buildShopPayload(req) med tomma ents (Workern filtrerar ägda per ents)
const allSingles = Object.entries(SPECIES).filter(([id, s]) => s.pack && isValidSingleClaim(id));
const shop = {
  packs: Object.values(PACKS).filter((p) => p.forSale).map((p) => {
    const top = [...p.species].sort((a, b) => (SPECIES[b]?.eatScore ?? 0) - (SPECIES[a]?.eatScore ?? 0))[0];
    return { id: p.id, label: p.label, priceSek: p.priceSek, kind: p.kind, species: p.species, image: top ? `/icons/${top}.png` : null, topSpecies: top ?? null, owned: false };
  }),
  svenskaKlassiker: SVENSKA_KLASSIKER_SPECIES,
  svenskaKlassikerActive: false,
  topSpotsPass: { id: `topspots:${year}`, label: `Årskort ${year}`, priceSek: 249, kind: "year-pass", year, topHiddenFraction: FREE_HIDE_FRACTION },
  freeSpecies: FREE_SPECIES,
  singlePriceSek: SINGLE_PRICE_SEK,
  soloOnlySpecies: SOLO_ONLY_SPECIES,
  topPicks: TOP_PICKS.map((id) => {
    const s = SPECIES[id];
    return { id, label: s.label, eatScore: s.eatScore, image: `/icons/${id}.png`, free: FREE_SPECIES.includes(id), priceSek: s.pack ? SINGLE_PRICE_SEK : 0, pack: s.pack ?? null };
  }),
  singles: allSingles.map(([id, s]) => ({ id, label: s.label, eatScore: s.eatScore, image: `/icons/${id}.png`, priceSek: SINGLE_PRICE_SEK })),
  singlesTotal: allSingles.length,
};

const manifest = {
  api: "v1",
  tileRev,
  generatedAt: new Date().toISOString(),
  bounds: [SWEDEN.minLon, SWEDEN.minLat, SWEDEN.maxLon, SWEDEN.maxLat],
  speciesCount: Object.keys(SPECIES).length,
  freeSpecies: FREE_SPECIES,
  rainSpans: [14, 21, 28, 42],
  endpoints: {
    bootstrap: "/api/v1/bootstrap",
    overview: "/api/v1/fungi/overview",
    optimalZone: "/api/v1/fungi/optimal-zone",
    hotspots: "/api/hotspots",
    clouds: "/api/v1/weather/clouds/manifest",
    rainHistory: "/api/v1/weather/rain-history/manifest",
    tiles: "/api/tiles/{habitat|multi|hillshade}/...",
  },
};

await fsp.mkdir(outDir, { recursive: true });
await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await fsp.writeFile(path.join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2));
await fsp.writeFile(path.join(outDir, "shop.json"), JSON.stringify(shop, null, 2));
console.log(`root-filer klara i ${outDir} (rev=${tileRev}): manifest.json, catalog.json (${catalog.species.length} arter), shop.json (${shop.packs.length} pack, ${shop.singles.length} singles)`);
console.log(`synka: node scripts/sync-r2.mjs --rev ${tileRev} --only root`);
