# Test-patchar & 2-tier-arkitektur (Patch A Södertälje + Patch B Skåne)

Syfte: validera den landstäckande 2-tier-arkitekturen innan full Sverige-bake.

## Patch-regioner

| Patch | Område | bbox (lon/lat) | Syfte |
| --- | --- | --- | --- |
| **A — `patchA` "sodertalje"** | Södertälje / Ronna / Nykvarn (~59.207, 17.584) | 17.42, 59.08 → 17.72, 59.32 | täcker väster om tidigare cutoff 17.61°E — den vertikala kanten ska bort |
| **B — `patchB` "skane"** | avlägsen 20×20 km-ruta (Malmö/Lund) | 12.98, 55.38 → 13.32, 55.58 | testa landstäckande översiktspins + zoom-in-decollapse |

## Regler (hårdkodade i `scripts/make-test-patches.mjs`)

- Alla rasters i **EPSG:3006 (SWEREF99 TM)**, **256×256-tiled GeoTIFF**, samma rutnät som
  huvudfilen (origin snäpps mot huvudfilens grid). Datatyp följer huvudfilen
  (NMD på Mac = uint16; sandbox-demo = uint8).
- **Råa lager** — inga svamp-vetoer inbakade. NMD-patchen innehåller råa klasser
  (skog 111–117/121–127, vatten 61, tätort 81, kalhygge 51); vattenbuffert och
  kalhygges-veto appliceras vid runtime av `MaskLayer` som vanligt.
- Upplösning kläms till **10–25 m** (huvudfilens upplösning om inom spannet; max 4096 px/sida).
- Patcharna skrivs till `data/layers/patches/<fil>__patchA.tif` / `__patchB.tif`
  (git-ignored, regenereras) och registreras i `data/layers/manifest.json` under
  `"patches": [...]` per lager + mask. Befintliga filer skrivs inte över utan `--force`.

## Mosaic-laddning (`src/layers.ts`)

`RasterEntry.patches[]` och `mask.patches[]` i manifest. `LayerStore.load` laddar
patcharna som extra delar: huvudfilen frågas först, sedan patcharna i ordning
(`locate()`); `has/sample/sampleSync/sampleGrid/allows` delegerar. Patcharna får
inte överlappa varandra.

## 2-tier bake

- **Tier 1 — Overview (z4–z9):** `npm run bake-overview -- --species kantarell --cell 2000 --min 55`
  skriver `data/overview/<art>.json` (git-ignored): grovt rutnät (default 2 km) över hela
  täckningen, varje cell samplas 3×3 och aggregeras med **max och p95** (så skog inte
  missas av pixel-hopp), tröskel min=55, tak 100. Top-Spots JSON för landstäckande
  översikt. Overview-tiles (z4–z9) bakas som vanligt via
  `npm run bake-tiles -- --bbox 10,55,24,69 --zmin 4 --zmax 9`.
- **Tier 2 — Detail (z10–z15+):** `npm run bake-tiles -- --bbox ... --zmin 10 --zmax 15`
  — finmaskiga 10–25 m habitat-tiles, samma scoring som Tier 1 (static=1), väder live.

## På Mac med riktiga data

Ersätt syntetiska patch-värden mot riktiga urklipp (samma filnamn i `data/layers/patches/`):

```bash
gdalwarp -cutline patchA.geojson -crop_to_cutline -tr 10 10 -t_srs EPSG:3006 \
  -of GTiff -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256 \
  <kalla.tif> data/layers/patches/nmd_10m.tif__patchA.tif
npm run test-patches -- --register-only
```

## Verifiering (lokal server, port 3000)

```bash
curl -s "http://127.0.0.1:3000/api/hotspots?species=kantarell&bbox=17.55,59.18,17.63,59.23&static=1&minScore=40&limit=20&ents=all"   # Patch A Södertälje
curl -s "http://127.0.0.1:3000/api/hotspots?species=kantarell&bbox=12.9,55.3,13.4,55.7&static=1&minScore=40&limit=30&ents=all"       # Patch B Skåne
curl -s "http://127.0.0.1:3000/api/hotspots?species=kantarell&bbox=17.7,59.1,18.5,59.7&static=1&minScore=40&limit=10&ents=all"      # huvudraster Stockholm
```

(Obs: `/api/hotspots` har max 4° per sida — Sverige-översikt täcks av Tier-1 JSON +
z4–z9-tiles, eller flera 4°-bboxar. Utan `ents=all` är kantarell låst → 403.)

Verifierat i sandbox (demo-data + syntetiska patchar): hotspots ger träffar i både
Patch A (84 pins, topp ~99) och Patch B (84 pins, ~98) samt huvudområdet; kalhygge-
blobben i patch A ger `inForest=false` vid runtime (veto ej inbakat); overview-JSON
innehåller celler i båda patcharna + huvudområdet.
