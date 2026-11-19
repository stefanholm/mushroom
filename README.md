# Mushroom Chat

Minimal web app that chats with the [Mistral API](https://docs.mistral.ai) using the official
[`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai) TypeScript SDK.
The model is `mistral-small-latest`. The API key stays on the server (`MISTRAL_API_KEY` in
`.env`, never sent to the browser); the frontend only talks to the local `/api/chat` endpoint.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # then edit .env and set your MISTRAL_API_KEY (from https://console.mistral.ai)
npm run dev            # starts on http://localhost:3000 (auto-reloads on changes)
```

Open http://localhost:3000 and start chatting.

Other commands:

```bash
npm start        # run without auto-reload
npm run typecheck
```

## Features

- **Chatt** — talks to `mistral-small-latest` via the official SDK; the server prepends a
  Swedish system prompt so answers come back in Swedish. The API key never leaves the server.
- **Karta** — a MapLibre map of Sweden (OpenStreetMap basemap) with a species selector
  (kantarell, trattkantarell, karljohan, svart trumpetsvamp) and a heatmap overlay from
  `GET /api/hotspots?species=...&minLon=...&minLat=...&maxLon=...&maxLat=...`.

## Data layers (folder structure)

Raster/vector layers live in `data/layers/` (GeoTIFF/GeoJSON files themselves are
git-ignored; only `manifest.json` is tracked). Expected files, all in **EPSG:3006
(SWEREF 99 TM)** unless noted:

```
data/
└── layers/
    ├── manifest.json                     # layer registry (tracked)
    ├── skog_tradhojd_10m.tif             # SLU Skogskarta / Skogliga grunddata – trädhöjd (m), GeoTIFF
    ├── skog_volym_10m.tif                # SLU Skogskarta / Skogliga grunddata – volym (m³/sk/ha), GeoTIFF
    ├── markfuktighet_10m.tif             # SLU Markfuktighetskarta – klass 1..5 (1=torr … 5=blöt), GeoTIFF
    ├── jordart_10m.tif                   # SGU jordarter – klasskod, GeoTIFF (recode i manifest: 1=acidic, 2=calcareous)
    ├── hojdmodell_2m.tif                 # Lantmäteriet nationell höjdmodell – höjd (m), GeoTIFF (lutning/aspekt beräknas i kod)
    └── avverkningar_senaste_5ar.geojson  # Skogsstyrelsen "Utförda avverkningar" – polygoner (hårdspärr), GeoJSON
```

`manifest.json` maps each file to a layer id (`tradhojd`, `volym`, `markfuktighet`,
`jordart`, `hojd`, `avverkningar`) with `nodata`, `band` and optional `recode`. Missing
files are skipped with a log line, so the app works with any subset of layers.

Sources (verify current URLs before downloading — they change):

- SLU Skogskarta / Skogliga grunddata (trädhöjd, volym): Skogsstyrelsen/SLU öppna geodata,
  https://www.skogsstyrelsen.se and https://www.slu.se/skogskarta
- SLU Markfuktighetskarta: https://www.slu.se (SLU, markfuktighetskartan)
- SGU jordarter & berggrund: https://www.sgu.se (öppna data, WFS/GeoTIFF)
- Lantmäteriet nationell höjdmodell (2 m): https://www.lantmateriet.se öppna data (gratis konto)
- Skogsstyrelsen Utförda avverkningar & nyckelbiotoper: https://kartor.skogsstyrelsen.se (WFS → GeoJSON)
- Validering: Artportalen (SLU Artdatabanken), https://artportalen.se

To try the pipeline without downloading anything, run `npm run demo-data` — it generates
synthetic layers for a test area around Stockholm (17.7–18.5°E, 59.1–59.7°N) into
`data/layers/`, including two clear-cut polygons. Replace the files with real downloads
for the same area; restart the server to reload layers.

## Layers used to pinpoint hotspots

Static (where mycelium *can* live), sampled per map cell:

1. **OSM forest mask** — Overpass (ways **and multipolygon relations**: `landuse=forest`/`natural=wood`/`natural=scrub`), cached 24 h, 5 fallback hosts. Hard filter: non-forest ≈ 0.
   1b. **Forest-edge bonus** — cells within ~100 m of the forest boundary get a species-weighted bonus (kantarell loves edges/paths).
2. **Negative OSM layers** — Overpass (ways + relations, cached 24 h, fallback hosts). Hard zero inside `natural=water`, `waterway`, `building=*`, `landuse=industrial|commercial|residential|urban|cemetery|allotments|quarry|landfill|military|retail|grass|meadow|village_green`, `leisure=pitch|golf_course|recreation_ground`, `amenity=parking`, `natural=grass`, `shop=*`, `man_made=wastewater_plant|storage_tank`; ×0.2 within 30 m of any `highway`/`railway`/`aeroway`. (Safety: military/landfill/pollution excluded.)
3. **DEM water cutoff** — with the höjdmodell loaded, in-coverage cells with nodata or elevation < 0.5 m are sea/water → hard zero (works even if Overpass is unreachable).
2. **Trädhöjd** (`tradhojd`, SLU Skogskarta/Skogliga grunddata) — stand maturity threshold per species.
3. **Volym** (`volym`, SLU) — same, volume-based.
4. **Markfuktighet** (`markfuktighet`, SLU Markfuktighetskarta, class 1–5) — per-species moisture preference.
5. **Jordart** (`jordart`, SGU) — acidic vs calcareous soil per species.
6. **Höjdmodell** (`hojd`, Lantmäteriet NH) — derived in code: **aspect → sun exposure** (south-facing = sunny/warm) and **depression depth** (crevasses/svackor: lower than the surrounding 250 m ring).
7. **Avverkningar** (`avverkningar`, Skogsstyrelsen, vector) — hard zero inside recent clear-cuts.

Out-of-the-box ideas for later: Artportalen observations as a validation/training layer,
Sentinel-2 NDVI greenness, SMHI radar (PMP) for spatial rain variation instead of one
station, `highway=path`/`footway` proximity as a positive layer (kantarell along trails),
and soil pH from SGU berggrund in addition to jordart.

Dynamic (when it *fruits*), from SMHI metobs (`latest-months`):

8. **Rain, last 14 days** at the nearest active station, ending at the selected date (date slider).
9. **Seasonal window** per species, shifted by latitude.

Karta-tab extras: **hillshade** (`/api/hillshade?...` renders a 512×512 PNG from
`hojdmodell_2m.tif`, shown under the heatmap; toggle "Terräng"), a **sensitivitet slider**
(shifts the hotspot threshold ±10 around score 60), and a safety disclaimer
(Giftinformationscentralen / lookalikes).

Cells are scored on a fixed fine grid (span/60, floored at ~3 m so the 2 m höjdmodell is
the limiting layer, max 60×60 per request) and rendered as a **blurred MapLibre
heatmap layer** with a smooth multi-stop gradient, whose radius adapts to zoom — so the
heatmap no longer changes shape when you zoom; a hot zone stays hot. Each cell also gets
a `heat` value: 0 below score 60, ramping linearly to 1 at score 100 — the heatmap is
weighted above that threshold, so only
real hotspots glow (pinpoint mode). `static=1` shows layers 1–7 only.

## How the hotspot score works

Each map cell gets `score = static habitat score × dynamic fruiting multiplier` (0–100):

- **Dynamic multiplier** — computed per request from SMHI Open Data (metobs API,
  parameter 5 = daily precipitation, `latest-months` period): the summed rain over the
  14 days ending at the requested date at the nearest active station, scaled
  (`rain/60`, capped at 1), times a seasonal window per species shifted by latitude.
  Pass `date=YYYY-MM-DD` to `/api/hotspots` to time-travel (the Karta tab has a date
  slider, max ~110 days back — that's what SMHI `latest-months` covers). Results are
  cached server-side for 6 h. `static=1` skips weather/season and shows habitat only.
- **Static habitat score** — per-species base × an OSM forest mask (Overpass API:
  `landuse=forest` / `natural=wood` polygons, cached 24 h per 0.5° grid cell; cells
  outside forest are hard-filtered) × the raster layers from `data/layers/` when present:
  trädhöjd/volym thresholds, markfuktighetsklass, jordart (sur/kalkrik), lutning/aspekt
  från höjdmodellen, and a hard zero inside recent clear-cuts (avverkningar). The basemap
  can later switch to Lantmäteriet's topographic WMTS (needs a free API key).

## How it works

- `src/server.ts` — Express server. Serves the static UI and MapLibre from `public/` and
  `node_modules/`, exposes `POST /api/chat` (Mistral chat, Swedish system prompt) and
  `GET /api/hotspots` (GeoJSON heatmap grid).
- `public/index.html` + `app.js` + `map.js` — tabbed UI: chat and map.
