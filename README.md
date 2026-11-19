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

## How the hotspot score works

Each map cell gets `score = static habitat score × dynamic fruiting multiplier` (0–100):

- **Dynamic multiplier** — computed per request from SMHI Open Data (metobs API,
  parameter 5 = daily precipitation, `latest-months` period): the summed rain over the
  last 14 days at the nearest active station, scaled (`rain/60`, capped at 1), times a
  seasonal window per species shifted by latitude. Results are cached server-side for 6 h.
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
