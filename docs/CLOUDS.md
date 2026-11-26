# Live moln över Sverige (SMHI SNOW1gv1 → bakade PNG-frames → MapLibre GPU)

Molnprognosen renderas **inte** i SwiftUI och rå JSON parsas **inte** på telefonen — servern
bakar små alpha-PNG-frames (160×200 över Sverige) som MapLibre målar direkt på GPU via
`MLNImageSource` + `MLNRasterStyleLayer` med double-buffer cross-fade.

## Backend (`src/clouds.ts`, kopplad i `src/server.ts`)

- Källa: SMHI öppna data **SNOW1gv1** (ersatte pmp3g 2026-03-31), CC BY 4.0 — kommersiellt OK,
  attribuering `© SMHI` (i `attribution` + AppInfoSheet).
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/...`
- Parametrar: `cloud_area_fraction` (oktas 0–8 → alpha) och
  `precipitation_amount_mean_deterministic` (avg_tprate, kg/m²/h → slate-blue tint på regnmoln).
- Multipoint hela Sverige med `downsample=4` (~10 km grid); geometrin cachas 24 h,
  värden per frame hämtas `with-geo=false` (gzip, ~200 kB/param/frame).
- Urval: 12 frames, nu → +22h i 2h-steg (från punktprognosens timeSeries).
- Render: splat till 160×200 över `[10.5, 55.0, 24.5, 69.5]`, gauss-blur (r=3, σ=1.6) +
  lågupplöst brus (wispy kanter), RGBA-PNG ~24 kB/frame → **hela 24h-loopen ≈ 300 kB**.
- Cache: minne + disk (`data/clouds/`, git-ignored), ombyggnad max var **30:e minut**;
  vid SMHI-fel serveras senaste goda disk-cache. Frame-id = `<validTime>-<hash(referenceTime)>`
  → **immutable**.

### Endpoints

```
GET /api/v1/weather/clouds/manifest
→ { updatedAt, referenceTime, bounds: [10.5,55.0,24.5,69.5], width: 160, height: 200,
    attribution, frames: [{ id, validTime, offsetHours, label: "tors 15:00", url }] }
  Cache-Control: public, max-age=300

GET /api/v1/weather/clouds/frame/:id.png
→ PNG  Cache-Control: public, max-age=31536000, immutable   (404 vid okänt id / path traversal)
```

Verifierat live mot SMHI (2026-11-26): 12 frames, 25 kB/st, alpha från riktig molndata,
1 frame med regn-tint, manifest cachat, traversal blockad.

## iOS (`SvampradarMapView.swift` — kontrakt)

- Två `MLNImageSource` (`live-cloud-a`/`-b`) ankare till exakt quad:
  NW `69.5, 10.5` · NE `69.5, 24.5` · SE `55.0, 24.5` · SW `55.0, 10.5` (samma som `bounds`).
- Lagerordning: ovanför `osm`/baskarta/stigar, **under** `hotspots-*` (pins skarpa).
- Zoom-fade utan Swift-per-frame: `raster-opacity` via zoom-interpolerad NSExpression —
  fullt vid z4.5–z7.2, fade till 0.0 vid z9.2.
- Loop: pre-decode alla frames på background-kö (~2 MB RAM), cross-fade ~0.9 s mellan
  `frame[i]`/`frame[i+1]` (två GPU-uniforms), håll sista framen ~1.2 s, cross-fada tillbaka.
- Power guards: pausa vid `zoomLevel > 9.2`, under pinch/pan (`mapViewRegionIsChanging`),
  och i bakgrunden.
- Time-pill: visa bara vid `zoomLevel <= 8.5`, t.ex. `Moln • tors 15:00`, tap = pause/play.
- `MapAtmosphereOverlay`: håll kvar enbart för kant/höjd-dimma, ingen animerad molnduk där.

## Prod (senare)

Samma frames kan bakas av Cloudflare Worker till R2 (`/clouds/<id>.png`, immutable) och
manifest via Worker — då noll SMHI-trafik från telefonerna. Tills dess körs det från
Mac-servern bakom samma endpoints.

## Ackumulerad regnhistorik, valbart spann (`src/rain-history.ts`)

Ersätter det fasta 7-d-fönstret: **ackumulerad nederbörd som växer fram över tid**, med
valbart spann via `?days=14|21|28|42` (default 28; ogiltigt → 28). iOS väljer spann efter
vald art (längsta vid flerval).

- **Persistent rullande 6-veckorsfil** `data/rain-history/rolling-42d.json` (~83 kB för
  178 stationer × 42 dygn): `{ updatedAt, maxDays: 42, stations, days: { "YYYY-MM-DD": {id: mm} } }`.
  Var 6:e timme mergas SMHI Metobs param 5 `latest-months` in (samma stationsurval, felvärden
  >150 mm/dygn = saknad dag). **Hård prune till max 42 dygn** (`cutoff = senaste − 41 d`,
  `pruneRollingDays` är exporterad/pure för test) + borttagna stationer utan kvarvarande dygn.
  Atomiskt skrivande (`.tmp` → `rename`). Vid SMHI-fel serveras filen rakt från disk.
- **Manifest:** `GET /api/v1/weather/rain-history/manifest?days=28` (`max-age=600`) →
  `{ updatedAt, referenceTime, requestedDays, spanDays, mode: "accumulated", stationCount,
  bounds, width: 256, height: 320, attribution, frames: [{ id, startDate, endDate, daysAcc,
  daysAgoEnd, label: "29 okt–25 nov (28 d)", maxMm, url }] }`.
  Alla spann renderas från den 6h-cachade rolling-filen (ingen extra SMHI-hämtning per spann);
  PNG:er cachas per spann i `data/rain-history/{days}d/` och gamla frames från tidigare
  referenceTime rensas bort. Om filen har färre dagar än begärt används det som finns och
  `requestedDays`/`spanDays` rapporterar båda.
- **Frames per spann (ackumulerade):** 14 d → 8 st, 21 d → 11 st, 28 d → 10 st, 42 d → 11 st;
  frame k = total mm från `startDate` till frame-slut. `maxMm` växer alltså monotont genom
  loopen. Station utan minst 60 % av dygn i fönstret skippas för den framen.
- **Render:** samma 256×320, IDW σ=48 km × `exp(-(minDist/75km)²)`, 15 % kant-feather,
  ±0.5 LSB dither (ytterkant alltid exakt `alpha=0`, noll bandning). Färg normaliseras
  **per vecka** (`mm/vecka`) så alla spann får samma kontrast mot sepia-baskartan:
  0–3 mm/v transparent · 3–10 turkosblå (42,132,178, α→0.42) · 10–25 koboltblå
  (24,96,168, α→0.72) · 25–50+ djup indigo (18,58,138, α→0.88).
- `GET /api/v1/weather/rain-history/frame/:id.png` — `image/png`, `immutable`, id =
  `YYYYMMDD-acc<N>d-<hash8>`, traversal → 404.

Verifierat live mot Metobs 2026-11-26: 27/27 tester — rolling-42d.json 42 nycklar/83 kB/178 stn,
days=14/28/42 ger 8/10/11 frames med monotont växande maxMm (t.ex. 42d: 24→213 mm),
alla frames 200+immutable+256×320, ytterkant alpha=0, `days=99`→28, prune-test tar bort ett
60 dagar gammalt syntetiskt datum.

## Regn kopplat till Live-score (`sampleRainForLive`)

`src/rain-history.ts` håller fyra förinterpolerade Float32-rutnät (256×320, 14/21/28/42 d)
+ flush (3 d) + recent (5 d) i minnet, byggda från `rolling-42d.json` vid varje 6h-uppdatering
(`warmRainGrids()` vid serverstart). `sampleRainForLive(lat, lon, windowDays)` bilinjär-samplar
dem och returnerar `{ totalMm, flushMm, recentMm, mmPerWeek, factor, available, windowDays }`.

`factor` = kontinuerlig kurva på mm/vecka: `<3 → 0.30–0.45` (torkstraff), `3–15 → 0.45–1.00`,
`15–35 → 1.00–1.18` (flush-boost), `35–65 → 1.18`, `>65 → avtrappning mot 0.92`.

- `src/habitat.ts`: `SpeciesProfile.rainWindowDays` (14|21|28|42, default 28; murklor 14,
  tryffel/jättemusseron 42, karljohan 21 …) + `liveRainFactorFor(species, lat, lon)`
  (fallback factor 1.0 tills rolling-filen laddats).
- `src/server.ts`: **endast Live (`static=0`)** — `computeCells` tar per-cell
  `sampleRainForLive(...).factor` när rutnäten finns (annars punkt-SMHI-fallback);
  `overviewLiveFactor` samma. `static=1` (Habitat) är 100 % oberört.
  `/api/debug/cell` svarar med `rainWindowDays, rainAccumulatedMm, rainFlushMm,
  rainRecentMm, mmPerWeek, rainFactorLive, rainGrids` (null i Habitat-läge) +
  `computeCells`-meta har `rainWindowDays`/`rainGrids`.

Verifierat live: Stockholm 38.2 mm/28d → factor 0.75, Skåne 43.7 mm → 0.813 (spatialt varierande),
static=1 ger null i alla regnfält, murkla=14 d / tryffel=42 d, hotspots+overview live OK.
