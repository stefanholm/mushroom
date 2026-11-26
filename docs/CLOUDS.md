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
