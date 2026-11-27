# Optimal zon (gröna zonen) — `src/optimal-zone.ts`

Biologiskt exakt optimalzon per vald art/arter, som **en enda sammanhängande GeoJSON Polygon**.

## Modell
- **Två-fasigt regn** per art ur `rolling-42d.json` (stationsnivå → IDW till 160×200-rutnät):
  `baseScore` (djupfukt, age-decay `exp(-daysAgo/(win/2))`) + `triggerScore` (gauss kring
  `triggerPeakDays`, `triggerSpreadDays`; dag 0–1 får låg vikt naturligt). Torkbroms på senaste
  14 d (<2 mm → ×0.35), mjuk översvämningsdämpning över `sweetSpotMm`.
  `W_rain = clamp((baseWeight·baseN + (1-baseWeight)·trigN)·broms·dämpning, 0, 1.3)`
- **`S_opt = W_rain^0.42 · H_static^0.30 · F_season^0.16 · F_climate^0.12`** per cell.
  Hårda veton i H_static via NMD-masken (endast skog 111–117/121–127 tillåts; vatten/hygge/
  tätort/kalhygge → 0). `F_season` latitudjusterad (ref 59°N). `F_climate` = `maxLat`-gräns +
  GDD5-kuvert + nattfrost < −2 °C enligt `frostTolerance` (sensitive→0, moderate→0.6, hardy→1).
- Artparametrar i `src/habitat.ts` (`triggerPeakDays/triggerSpreadDays/baseWeight/sweetSpotMm/
  maxLat/frostTolerance`, gruppdefaults per regnfönster 14/21/28/42 + overrides, t.ex.
  karljohan trigger 17 d). Alla 61 arter får kompletta parametrar automatiskt.
- **Single vs multi:** 1 art = exakt dess fönster/profil. Flera = mjuk union
  `S = 1−Π(1−Sᵢ)` + 3×3 max-breddning.

## Polygon-extraktion (alltid högst EN zon)
3×3 gauss → biologiskt golv `peak ≥ 0.46` (annars `optimalZone: null`, aldrig falsk zon) →
adaptiv tröskel `max(0.46, min(0.75, peak·0.72))` → morfologisk stängning (dilate→erode ×2) →
connected components (8-grannar, största efter integrerad poäng; satellit-öar slängs) →
Moore-kontur → 2× Chaikin → **en** `Polygon`-Feature (sluten ring).

## API
```
GET /api/v1/fungi/optimal-zone?species=id1,id2&date=YYYY-MM-DD&ents=...
→ 200 {
  mode: "single" | "multi",
  displayRainWindowDays: 14|21|28|42,        // single: artens fönster; multi: max
  optimalZone: Feature | null,               // null om peak < 0.46
  skipped: [...], asOf, cached?,
  meta: { peakScore, threshold?, zoneCells?, reason?, latest, speciesIds }
}
// Feature.properties: { speciesIds, windowDays, triggerPeakDays, accumulatedRainMm,
//   effectiveRainMm, peakScore, meanScore, seasonFactor, habitatFactor }
// Feature.geometry: { type: "Polygon", coordinates: [ [ [lon,lat], ... ] ] }  (stängd ring)
403 om alla arter låsta; 15 min cache per artkombination+datum. /api/hotspots oberört.
```

## Verifierat (sandbox, demo-rasters + riktig rolling-42d.json)
- vinterskivling single (nov): zon JA, 155 celler, peak 0.583, stängd ring, inom Sverige-bbox
- kantarell single (nov): `optimalZone: null` (säsong slut, peak 0) — ingen falsk zon
- multi (vinterskivling+brunsopp): mode=multi, exakt EN ring
- 403 alla låsta; skipped vid delvis låst; cache 3 ms; /api/hotspots oberört; tsc ren;
  `npm run validate` kör (62k punkter, AUC-tabell); alla 61 arter har kompletta parametrar.
