# FRONTEND-CONTRACT — exakt vad iOS ska skicka till backend (och vad som kommer tillbaka)

Gäller både Node-origin (dev, `http://<mac-ip>:3000`) och Cloudflare-Workern (prod,
`https://svampradar.natureradar-se.workers.dev`, senare custom domain). Båda svarar samma kontrakt.

## 0. Transport & failproof
- Alltid HTTPS i prod. Timeouts: 15 s "fast", 25 s "tung" (bootstrap/overview/optimal-zone).
- Vid 5xx: en retry efter 1 s, sedan använd senast cachade bootstrap/manifest — kartan ska alltid rendera från cachade tiles.
- Vid **429**: backoff (vänta, försök inte igen direkt) — backend rate-limitar per IP.
- Lita på `Cache-Control`: tiles/frames `immutable` (cacha hårt, cache-busta med `tileRev`), API-JSON `max-age=60`.
- Skicka alltid med: `?ents=<csv>` + `?trial=1` (dev) och `?device=<IDFV>` där D1 används.
  I prod kommer ents från kvitto (`/api/verify-receipt` → D1); `?ents=` accepteras bara i dev.

## 1. Endpoints

| Anrop | Viktiga params | Svar (nycklar iOS läser) |
|---|---|---|
| `GET /api/v1/bootstrap` | `species=a,b` (max 6), `ents`, `trial`, `date`, `static` | `{ api, tileRev, serverTime, asOf, meta (samma payload som /api/meta — krävs icke-optional av BootstrapResponse), shop, unlocked, leaderboard:{days, leaderboard:[{alias,s,n}]}, clouds, rainHistory:{"14".."42"}, rainSpans:[14,21,28,42], fungi:{<art>:{label,season,rainWindowDays,pack,protected,profile,overviewCells,zone,zonePending}}, skippedSpecies? }` |
| `GET /api/v1/manifest` eller `/manifest.json` | — | `{ api, tileRev, bounds, speciesCount, freeSpecies, rainSpans, endpoints }` |
| `GET /api/meta` | `species`, `lat`, `lon`, `ents`, `fast=1` | `{ species, label, speciesList[61] {id,label,season,pack,locked,rainWindowDays}, packs, freeSpecies, topSpots{capped,trial,topHiddenFraction,passId,passLabel,passPriceSek}, rain14, rainFactor, seasonFactor, gdd5, minTemp48h, frost, flush, asOf, tileRev }` (edge utan origin: väder-fält null) |
| `GET /api/v1/fungi/overview` | `species=a,b`, `static=1\|0`, `date`, `minScore`, `ents` | `OverviewResponse{ overviewRevision, mode, capped, trial, goldPeaks, profiles, tiers }` — **tiers-nycklar är exakt `"55km"`, `"18km"`, `"6km"`**, varje post `OverviewTierSpot{species,lat,lon,northing,easting,score,count,gold}` |
| `GET /api/hotspots` | `bbox=minLon,minLat,maxLon,maxLat`, `species=a,b`, `static`, `date`, `minScore` (tiles-läge 70), `maxP`, `ents`, `trial` | `{ hotspots:[{lon,lat,score,species,gold?}], skipped[], meta{source,capped,goldPeaks,trial,asOf} }` |
| `GET /api/v1/fungi/optimal-zone` | `species=a` (single ger exakt zon), `date`, `static`, `ents` | `{ static, mode, displayRainWindowDays, optimalZone: Feature\|null, meta{peakScore,zoneCells,reason?}, skipped, asOf, cached?, cacheAgeMs? }` — `optimalZone.geometry` är EN Polygon (sluten ring); `null` = ingen falsk zon |
| `GET /api/tiles/habitat/<art>/<z>/<x>/<y>.png` | `ents`, `static=1`, `minScore=70`, `sens`, `date` | PNG 256×256, immutable |
| `GET /api/tiles/multi/<z>/<x>/<y>.png` | `species=a,b`, `static=1` | PNG, immutable |
| `GET /api/tiles/hillshade/<z>/<x>/<y>.png` | — | PNG, immutable |
| `GET /api/v1/weather/clouds/manifest` | — | `CloudManifestResponse{ updatedAt, referenceTime, bounds, width, height, attribution, frames[{id,validTime,label,url}] }` |
| `GET /api/v1/weather/rain-history/manifest` | `days=14\|21\|28\|42` (default 28) | `{ updatedAt, referenceTime, requestedDays, spanDays, mode:"accumulated", stationCount, bounds, width, height, frames[{id,endDate,daysAgoEnd,label,maxMm,url}] }` |
| moln/regn-frames | från manifest `url` (path) | PNG, immutable — lägg till baseURL framför |
| `GET /api/shop` | `ents` | `{ packs[], singles[], topPicks[], svenskaKlassiker, svenskaKlassikerActive, topSpotsPass, freeSpecies, singlePriceSek, ... }` |
| `GET /api/unlocked` | `ents`, `device` | `{ entitlements[], unlocked[], svenskaKlassiker, svenskaKlassikerActive, topSpots }` |
| `POST /api/report-signal` | body `{device, species, lat, lon, score, kind}` | `{ok:true}`; 403 orimlig förflyttning, 429 dagsgräns |
| `GET /api/leaderboard` / `/score` | `days` (1–30), `device` | `{ days, leaderboard:[{alias,score,finds}] }` / `{ days, alias, score, finds }` |
| `DELETE /api/privacy/delete` | `device` | `{ok:true, deleted:true}` (idempotent) |
| `POST /api/verify-receipt` | prod: kvitto JWS | dev: `{device, ents[]}` |

## 2. Semantik
- `static=1` = HABITAT-läge (året-runt biotop: F_season=F_climate=1 i optimalzonen); `static=0`/saknas = Live (säsong×regn×frost×flush). Tiles skickas alltid med `static=1`.
- `ents` csv: `all`, `pro`, `topspots.2026` (punkt funkar, normaliseras), pack-id, `species:<id>`, `reward:<id>`. Årskort låser även upp `svenskaKlassiker` (inkl. kantarell).
- Gold-pins: `pin.gold==true` bara för betalande; capped-banner från `meta.capped/goldPeaks/passId/passLabel/passPriceSek`.
- Errors: `403 {error, locked[]}` → visa shop; `400 {error}`; `429 {error}` → backoff; `/api/debug/*` → **404 i prod, anropa bara under `#if DEBUG`**.
- `optimalZone` null är normalt utanför säsong/torra lägen — rita då ingen grön zon.

## 3. Säkerhet / IP (sammanfattning, detaljer i docs/IP-PROTECTION.md)
- Inga hemligheter i appen; inga `/api/debug/*` i Release; prod kör bara mot HTTPS-Workern.
- Backend håller vikter/formler privat: klienten får bara PNG-tiles, heltals-poäng, färdiga polygoner och förbakade zoner.

## 4. Failproof-beteende i appen
- Cache:a bootstrap/manifest hårt; vid nätfel använd senast cachade.
- Zonen: om `zonePending:true` eller `zone:null` i bootstrap → polla `/api/v1/fungi/optimal-zone` en gång efter ~5 s (SWR gör den snabb).
- Regn/molen: hämta manifest först, ladda bara synliga frames; loopa frames lokalt (ingen serverlast per frame).
- Offline senare: per-art atlas z5–z9 (~12 MB) från R2.
