# UX & responsivitet — vad backend gör för att kännas snabb i iOS

## 1. Gzip-komprimering (`compression`, threshold 1 kB)
- Alla JSON-svar (hotspots/overview/bootstrap/optimal-zone) komprimeras automatiskt.
- PNG-tiles/frames (`image/png`) är inte `compressible` och hoppas över — ingen CPU bortkastad på bilder.
- Mätt i sandbox: makro-`/api/hotspots` (2 arter, maxP=180) **10 276 B → 1 283 B (−88 %)** på mobilnät.

## 2. `/api/v1/bootstrap` (alias `/api/bootstrap`) — EN round-trip vid app-start
```
GET /api/v1/bootstrap?ents=...&trial=1
→ { api: "v1", serverTime, asOf,
    meta,            // samma payload som /api/meta?fast=1 (ingen SMHI-väntan: rain14=null)
    shop,            // samma som /api/shop?ents=...
    unlocked,        // samma som /api/unlocked?ents=...
    leaderboard: { days: 5, leaderboard: [...] },
    clouds,          // /api/v1/weather/clouds/manifest (30 min server-cache, disk-fallback)
    rainHistory: { "14":…, "21":…, "28":…, "42":… } }  // alla fyra spann, redo att morfas
```
- Alla delar är cachade server-side → efter första anropet svarar bootstrap på **< 50 ms** (sandbox: 43,6 kB, 4 ms andra gången).
- Kartdata hämtas fortfarande per vy: `/api/hotspots`, tiles, `/api/v1/fungi/overview`, `/api/v1/fungi/optimal-zone`.
- Cache-Control: `public, max-age=60` (samma som övriga GET-API).

## 3. Optimalzon: stale-while-revalidate + boot-prewarm
- `zoneCache` (nyckel = arter+datum+static) med **SWR**: cache-hit serveras direkt (`cached: true`, plus nytt fält `cacheAgeMs`); när TTL gått ut (`ZONE_TTL_MS`, default 15 min) triggas omberäkning i bakgrunden (`zoneInflight` spärr mot dubbelarbete). Användaren väntar alltså bara första gången någonsin.
- Vid boot förvärms zoner för `FREE_SPECIES + TOP_PICKS` (max `PREWARM_ZONE_MAX`, default 10 arter) i båda lägen (`static=0/1`) — första kartvyn med förvald art är **omedelbar** (sandbox: cache-hit på 1 ms efter prewarm).
- Env: `PREWARM_ZONES=0` stänger av prewarm, `ZONE_TTL_MS` sätter TTL (använd lågt värde i test).

## 4. HTTP-cache-headers (iOS URLCache utnyttjas, pan/zoom frågar inte igen)
| Endpoint | Cache-Control |
|---|---|
| tiles (habitat/multi/hillshade) | `public, max-age=31536000, immutable` |
| clouds/rain frames (PNG) | `public, max-age=31536000, immutable` |
| clouds manifest | `max-age=300` |
| rain-history manifest | `max-age=600` |
| `/api/meta`, `/api/hotspots`, `/api/peaks`, `/api/unlocked`, `/api/v1/fungi/*`, bootstrap | `public, max-age=60` |
| `/api/shop` | `public, max-age=300` |
| `/api/hillshade` (terräng) | `public, max-age=3600` |
| `/api/chat`, `/api/debug/cell` | `no-cache` |

URL:en innehåller alltid species/bbox/lat/lon/ents/date/static → URLCache separerar anrop korrekt.

## 5. Server-side caches (så första riktiga anropet också är snabbt)
- `computeCellsCached` LRU (64 poster, 10 min) för hotspots-celler; yields var 96:e cell.
- SMHI: väder per 0.1°-cell 6 h; rolling-42d.json 6 h + disk; moln 30 min + disk; minTemp48h per 0.5°-rad 6 h.
- overview-JSON bakad på disk (bake-overview.mjs) — makro-/api/hotspots vid span > 1.5° läser fil, ingen rasterberäkning.
- Boot: `warmRainGrids()` + `prewarmWeather()` (PREWARM_POINTS över Sverige) + `prewarmZones()`.

## 6. Nästa steg (ej byggt än)
- Cloudflare Worker framför: R2 för tiles/frames (immutable), D1 för signals/redeem — då blir även første cold-start snabb globalt.
- App Store Server API för kvitto (ersätter dev-`ents=`), så shop/unlocked blir auktoritära direkt vid start.
