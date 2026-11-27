# Optimal zon (gröna zonen) — `src/optimal-zone.ts`

Biologiskt exakt optimalzon per vald art/arter, som **en enda sammanhängande GeoJSON Polygon**.

## Modell
- **Två-fasigt regn** per art ur `rolling-42d.json` (stationsnivå → IDW till 256×320-rutnät):
  `baseScore` (djupfukt, age-decay `exp(-daysAgo/(win/2))`) + `triggerScore` (gauss kring
  `triggerPeakDays`, `triggerSpreadDays`; dag 0–1 får låg vikt naturligt). Torkbroms på senaste
  14 d (<2 mm → ×0.35). **Överblöts-dämpning `floodDamping` (skärpt):** full vikt tom
  `1.25 × sweetSpotMm`, sedan smoothstep ner till golvet `0.15 + 0.05·floodTolerance`
  vid `≥ 2.2 × sweetSpotMm` — art-differentierat via `floodTolerance` i `src/habitat.ts`
  (fukttåliga: trattkantarell/blek-taggsvamp 0.95, svart-trumpetsvamp 0.9, vinterskivling 0.85,
  karljohan 0.8; torrmarks-/tallarter: jattemusseron/tallblodriska/tallskrubb 0.2,
  fjallig-blacksvamp/stolt-fjallskivling 0.25; kantarell 0.35; default 0.5).
  Vattenmättade kärnor får därmed `W_rain ≤ 1.3·0.20 ≈ 0.26` (→ `^0.42 ≈ 0.56`) mot måttliga
  flanker `W_rain ≈ 0.65` (→ `^0.42 ≈ 0.84`), så zonen flyttar till de väldränerade flankerna
  istället för att sitta på absolut regnmax.
  `W_rain = clamp((baseWeight·baseN + (1-baseWeight)·trigN)·broms·flood, 0, 1.3)`
- **`S_opt = W_rain^0.42 · H_static^0.30 · F_season^0.16 · F_climate^0.12`** per cell.
  Hårda veton i H_static via NMD-masken (endast skog 111–117/121–127 tillåts; vatten/hygge/
  tätort/kalhygge → 0). `F_season` latitudjusterad (ref 59°N). `F_climate` = `maxLat`-gräns +
  GDD5-kuvert + nattfrost < −2 °C enligt `frostTolerance` (sensitive→0, moderate→0.6, hardy→1).
- **`static=1` (HABITAT-läge, året-runt biotop):** `F_season = 1` och `F_climate = 1`
  (ingen säsong/frost/GDD5/maxLat); `W_rain` + `H_static` + alla hårda NMD-veton är oförändrade.
  `static` ingår i 15-min cache-nyckeln och ekas i svaret.
- Artparametrar i `src/habitat.ts` (`triggerPeakDays/triggerSpreadDays/baseWeight/sweetSpotMm/
  maxLat/frostTolerance`, gruppdefaults per regnfönster 14/21/28/42 + overrides, t.ex.
  karljohan trigger 17 d). Alla 61 arter får kompletta parametrar automatiskt.
- **Single vs multi:** 1 art = exakt dess fönster/profil. Flera = mjuk union
  `S = 1−Π(1−Sᵢ)` + 3×3 max-breddning.
- **H_static-kalibrering per makrocell (3×3 sub-provtagning + topp-kvartil):** makrocellerna
  (256×320 över Sverige, ~3×5 km celler) är mycket större än 10–25 m rasterpixlarna, så ett enda punktprov
  kan missa skogen eller underskatta ett måttligt cell (på Mac gav mittprov habitatFactor ~0.10,
  `0.10^0.30 ≈ 0.50`, vilket drog ner säsongsarter precis under golvet 0.46: vinterskivling 0.45,
  blomkalssvamp 20 sep 0.425). Därför provtas nu 3×3 sub-punkter per cell och H sätts till
  **medel av topp-kvartilen** av de tillåtna positiva värdena (samma princip som Tier-1-bakens
  max/p95). Hårda veton gäller per sub-punkt — en cell helt täckt av vatten/hygge/tätort/kalhygge
  får fortfarande H=0. Snabbväg: cellmitten tillåten och H ≥ 0.55 → används direkt.
  Resultat: säsongsarter med bra regn klarar golvet (sandbox: peak 0.55–0.73, habitatFactor 0.75–0.89),
  medan off-season fortfarande ger peak 0 → `null` (kantarell i nov vid `static=0`).

## Polygon-extraktion (alltid högst EN zon)
3×3 gauss → biologiskt golv `peak ≥ 0.46` (annars `optimalZone: null`, aldrig falsk zon) →
adaptiv tröskel `max(0.46, min(0.75, peak·0.72))` → morfologisk stängning (dilate→erode ×2) →
connected components (8-grannar, största efter integrerad poäng; satellit-öar slängs) →
Moore-kontur (backtrack = senaste bakgrundspixeln, stopp vid upprepat tillstånd — cykel-detektion,
terminerar även för 1–2 px tunna strukturer; syntetiskt testade kvadrat/cirkel/L/orm/domino) →
2× Chaikin → **en** `Polygon`-Feature (sluten ring, 1 ring, ~45–260 punkter).

## API
```
GET /api/v1/fungi/optimal-zone?species=id1,id2&date=YYYY-MM-DD&ents=...&static=1|0
→ 200 {
  static: false | true,                      // NY: ekar query-param static=1 (HABITAT-läge)
  mode: "single" | "multi",
  displayRainWindowDays: 14|21|28|42,        // single: artens fönster; multi: max
  optimalZone: Feature | null,               // null om peak < 0.46
  skipped: [...], asOf, cached?,
  meta: { peakScore, threshold?, zoneCells?, reason?, latest, speciesIds, static }
}
// Feature.properties: { speciesIds, windowDays, triggerPeakDays, accumulatedRainMm,
//   effectiveRainMm, peakScore, meanScore, seasonFactor,   // 1.00 i static-läge (zon-medel annars)
//   habitatFactor }                                       // verkligt H_static-zon-medel (3x3 topp-kvartil)
// Feature.geometry: { type: "Polygon", coordinates: [ [ [lon,lat], ... ] ] }  (1 stängd ring)
403 om alla arter låsta; 400 utan giltig art; 15 min cache per artkombination+datum+static.
/api/hotspots oberört.
```

## Verifierat (sandbox, demo-rasters + riktig rolling-42d.json, 2026-11-26/27)
- `static=0`: trattkantarell 2026-10-10 zon (peak 0.725); vinterskivling today zon (0.587,
  habitatFactor 0.76 efter 3×3 topp-kvartil-kalibrering); blomkalssvamp 2026-09-20 zon (0.546);
  blomkalssvamp today `null` (peak 0, nov); kantarell today `null` (peak 0) — ingen falsk zon
- floodDamping enhetstestad 10/10 (1.0 tom 1.25×, smoothstep, golv 0.15–0.20 vid ≥2.2×) +
  syntetiska stationssignaler 5/5: extremblöt station (15 mm/dygn) får W_rain 0.25
  (vinterskivling), 0.257 (trattkantarell), 0.208 (jattemusseron) vs måttligt blöt (4 mm/dygn)
  W_rain 0.65 — art-differentiering och flank-preferens verifierad; station med <60 % dygn
  närvaro skippas fortfarande
- `static=1`: samma arter ger zon även i nov (blomkalssvamp today peak 0.58), svaret har
  `static: true` och `properties.seasonFactor = 1`; kantarell today static=1 zon (0.803)
- EN stängd ring (1 `coordinates`-ring, första == sista punkt, 45–257 punkter) i alla fall;
  multi (vinterskivling+brunsopp) mode=multi exakt EN ring
- cache: `static` i nyckeln — samma art+datum med static=0/1 cachas separat (verifierat live)
- 403 alla låsta; 200+skipped vid delvis låst; 400 ogiltig art; /api/hotspots (detalj + makro
  overview) oberört; `npx tsc --noEmit` ren; Moore-tracern syntetiskt testad (kvadrat/cirkel/
  L/1-px-orm/2-px-domino — alltid terminerande, alla ring-pixlar i komponenten)
