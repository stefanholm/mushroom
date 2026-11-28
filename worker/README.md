# worker/ — Cloudflare Worker framför Svampradar (origin-fri: R2 + D1 + SMHI-cron)

**Live (2026-11-27):** `https://svampradar.natureradar-se.workers.dev` — R2 `natureradar-data`, D1 `svampradar-db`, Mälardalen `r15` synkat, iOS pekar hit.

**Varför:** iPhonen hämtar färdiga produkter (PNG-tiles, JSON-block, frames) från svensk edge med
`immutable` + 0 kr egress → snabbare än iMacen. **IP-skydd:** bara Workern är publik — Node-originen
med alla vikter/formler (`src/habitat.ts`, `optimal-zone.ts`) exponeras aldrig, och rasters lämnar
aldrig Macen (se `docs/IP-PROTECTION.md`, layout i `docs/R2-LAYOUT.md`).

## Vad Workern gör (src/index.ts)
- **R2 direkt (immutable):** tiles, ikoner, `manifest.json`, overview-JSON, 10×10 km hotspot-block,
  moln/regn-frames + manifest, förbakade `zones/*.json` (optimalzon — bakas av origin, rasters i molnet aldrig).
- **Byggt i Workern:** `/api/hotspots` (slår ihop synliga block, live-faktor från `weather/live.json`,
  rättvis artkvot + gold-cap), `/api/v1/fungi/overview`, `/api/v1/bootstrap` (per-art-bundle `fungi`),
  `/api/shop`, `/api/unlocked` (ents från D1 eller `?ents=` i dev).
- **D1:** `/api/report-signal`, `/api/leaderboard`, `/api/leaderboard/score`, `DELETE /api/privacy/delete`,
  `POST /api/verify-receipt` (dev-stub; prod = App Store Server API, se nedan). Schema: `schema.sql` (alltid `app_id`).
- **Cron** (`0 */6 * * *`): `bakeWeatherCron` — SMHI SNOW1gv1 moln + Metobs param 5 regn → PNG-frames
  + manifest + `weather/live.json` till R2. Kan behöva Workers Paid ($5/mån) om >10 ms CPU; R2-egress 0 kr ändå.
- **Fallback:** allt annat (chat, redeem, reward, admin, on-demand tiles z11+, live optimalzon) proxas
  till `ORIGIN_URL` om satt (dev). I prod: lämna `ORIGIN_URL` tom — då 404 (origin är privat).

## Lokalt test utan Cloudflare
```bash
npx tsx worker/test-local.mts /tmp/r2seed   # mock R2 (katalog) + mock D1 (node:sqlite) — 19 tester
```

## Deploy — Mälardalen först (utan iMac igång)
```bash
npm i -g wrangler && wrangler login
cd worker
wrangler r2 bucket create natureradar-data   # redan skapad (rclone-remote "r2")
wrangler d1 create svampradar-db && wrangler d1 execute svampradar-db --file=schema.sql   # redan skapad
# fyll wrangler.toml: database_id från dash; bucket = natureradar-data; D1 = svampradar-db

# 1. Baka på Macen (nuvarande data räcker för Mälardalen-test):
npm run bake-overview -- --all-species            # data/overview/*.json
npx tsx scripts/bake-hotspot-blocks.mts --species <fria+toppar> --out data/r2/hotspots --minScore 55 --bbox 17.3,58.9,18.5,59.7
npx tsx scripts/bake-zones.mts --species <sammak> --both --out data/r2/zones
npm run bake-tiles -- --species <...> --bbox 17.3,58.9,18.5,59.7 --zmin 5 --zmax 10   # data/tile-cache/r15/
# manifest/catalog/shop från origin:
curl -s http://127.0.0.1:3000/api/v1/manifest > data/r2/manifest.json
curl -s http://127.0.0.1:3000/api/v1/catalog  > data/r2/catalog.json
curl -s http://127.0.0.1:3000/api/shop         > data/r2/shop.json

# 2. Synka till R2 (layout: docs/R2-LAYOUT.md) — i avgränsade delar, hög parallellitet:
node scripts/sync-r2.mjs --rev r15            # eller --only tiles,hotspots,... ; --dry för torr körning
REV=r15
rclone sync data/tile-cache/$REV/  r2:natureradar-data/domains/fungi/$REV/tiles/
rclone sync public/icons            r2:natureradar-data/domains/fungi/$REV/icons/
rclone sync data/overview           r2:natureradar-data/domains/fungi/$REV/overview/
rclone sync data/r2/hotspots        r2:natureradar-data/domains/fungi/$REV/hotspots/
rclone sync data/r2/zones           r2:natureradar-data/domains/fungi/$REV/zones/
rclone copy data/r2/manifest.json data/r2/catalog.json data/r2/shop.json r2:natureradar-data/domains/fungi/$REV/

# 3. Deploya Workern + custom domain (gratis HTTPS)
wrangler deploy
# TLS-noting: NYA *.workers.dev-subdomäner kan ge TLS handshake-fel (-1200) i iOS första minuterna
# tills kantcertifikat sprids — verifiera alltid med curl på Macen innan du felsöker i Swift.
# Custom domain när det är dags: api.natureradar.se (orange cloud ON).
# Säkerhet: om en R2-nyckel råkar synas i terminal/logg — revokera+rotera direkt i dash
# (aldrig skriva secrets i kommandon som loggas).
# Dash: Workers → svampradar → Triggers → Custom Domain = api.svampradar.se (orange cloud ON)
# Workern proxar okända routes till ORIGIN_URL — sätt den tom i prod (privat origin)

# 4. iOS: serverBaseURL = Worker-URL (nu https://svampradar.natureradar-se.workers.dev);
#    ta bort hårdkodad IP + NSAllowsArbitraryLoads i Release (#if DEBUG behåller dev-Mac).
#    /api/debug/cell finns INTE i prod-Workern (404 — IP-skydd) → iOS måste #if DEBUG-gate:a anropet.
#    Edge-/api/meta svarar från catalog.json (produkt-fält; väder-fält null utan origin).
#    Testa: stäng av Macen helt — appen ska fungera helt via Cloudflare.
```

## Hela Sverige (efter Mälardalen-testet)
1. Komplettera saknade rikstäckande lager på SSD (`canonical_gis/`): SLU Skogliga grunddata,
   SLU Markfuktighet (DTW), 25–50 m DEM (+slope/aspect/twi), rasterisera `sgu_jordart_raw.gpkg`.
   Warpa scoring-rasters `gdalwarp -tr 50 50` (annars >12,4 G px/lager).
2. `npm run validate` (AUC) → skicka till Gemini med docs/AUDIT.md + MODEL-DEEP-DIVE.md.
3. Baka över natten: `npm run bake-overview -- --all-species`, `npm run bake-blocks -- --all`,
   `npm run bake-tiles -- --all-species --zmin 5 --zmax 10`, `bake-zones --all --both` → `data/r2/`,
   synka till `r16/`, byt sist `tileRev` i manifest.json + `TILE_REV` i wrangler.toml, `wrangler deploy`.

## Nästa (spåras i docs/TODO-LAUNCH.md §0b)
- `POST /api/verify-receipt` i prod: App Store Server API (JWS ES256, `.p8` som Worker-secret) →
  auktoritativa ents i D1 direkt vid start (shop/unlocked utan extra rundor); ANS v2-webhook för förnyelser.
- D1 för reward_ledger/referrals (från node:sqlite/referrals.json på origin).
- Moln/regn-frames kan senare servas direkt från R2 även de (de ligger redan där efter cron).
- PMTiles i stället för lösa PNG-tiles när z11+ ska med (61 filer totalt).
