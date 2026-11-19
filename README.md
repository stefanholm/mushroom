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

## How the hotspot score works

Each map cell gets `score = static habitat score × dynamic fruiting multiplier` (0–100):

- **Dynamic multiplier** — computed per request from SMHI Open Data (metobs API,
  parameter 5 = daily precipitation, `latest-months` period): the summed rain over the
  last 14 days at the nearest active station, scaled (`rain/60`, capped at 1), times a
  seasonal window per species shifted by latitude. Results are cached server-side for 6 h.
- **Static habitat score** — currently a per-species base value (a placeholder). The plan
  is to replace it with real 10×10 m layers: SLU Skogskarta / Skogliga grunddata (host
  trees, stand age), SLU Markfuktighetskarta (soil moisture), SGU jordarter/berggrund
  (pH), Lantmäteriet höjdmodell (slope/aspect), Skogsstyrelsen avverkningar/nyckelbiotoper
  (clear-cut filter), in SWEREF 99 TM (EPSG:3006), validated against Artportalen
  observations. The basemap can later switch to Lantmäteriet's topographic WMTS (needs a
  free API key).

## How it works

- `src/server.ts` — Express server. Serves the static UI and MapLibre from `public/` and
  `node_modules/`, exposes `POST /api/chat` (Mistral chat, Swedish system prompt) and
  `GET /api/hotspots` (GeoJSON heatmap grid).
- `public/index.html` + `app.js` + `map.js` — tabbed UI: chat and map.
