# Model deep-dive brief for Gemini — every layer, factor, and the reasoning/pitfalls

Purpose: let Gemini audit the design and suggest precision improvements per species.
Code: `src/habitat.ts` (static habitat + species), `src/layers.ts` (rasters/mask),
`src/server.ts` (dynamic weather, tiles, endpoints). Equations summary: `docs/SCORING.md`.

## 0. Design principles (deliberate choices)

- **Fail-closed everywhere**: unknown forest mask → score 0 (never show hotspots where data
  is missing). NMD mask present → replaces OSM gate entirely. Mask >128 M px → refuse to
  build and `allows()` = false (avoids silent pass-through on huge clips).
- **Never quench hotspots for lookalike species**: deadly lookalikes share the same habitat
  as edibles (toppig giftspindling in the same moss as trattkantarell), so zeroing cells
  would blank the map. Instead: per-species `lookalikes` warning shown in UI + inspect card;
  expert-mode species hidden behind Expertläge; chat refuses edibility verdicts
  (deterministic checklist, server-side regex + risky-affirm guard on the model reply).
- **Optional layers are truly optional**: every raster in the manifest that is missing just
  drops its factor to neutral 1.0 (recorded in `store.missing`) — the app never breaks.
- **Never clobber real data**: demo/generator scripts skip existing files unless `--force`;
  `gdalwarp` needs `-overwrite` or `rm -f` first.
- **Deterministic where safety matters**: verdict questions bypass the model entirely.

## 1. Layers (all EPSG:3006, `data/layers/`, manifest-driven)

| Layer | File | Source / how computed | Used for |
| --- | --- | --- | --- |
| tradhojd, volym, grundyta, gran/tall/bjork/ek/bok/hassel/asp, sis, alder | `skog_*_10m.tif`, `grundyta_10m.tif` | SLU Skogskarta 10 m (demo: synthetic 100 m via `npm run demo-data`) | host volume gate, canopy, SIS, age |
| markfuktighet | `markfuktighet_10m.tif` | SLU Markfuktighetskarta (classes 1–5) | `fMoisture` + vetoMoisture |
| jordart | `jordart_10m.tif` | SGU jordart (recode 1=acidic, 2=calcareous) | `fSoil` + vetoSoil |
| soildepth | `sgu_soil_depth_10m.tif` | SGU jorddjupsmodell 10 m, **nodata 255** (real SGU value) | `fDepth` |
| hojd | `hojdmodell_2m.tif` | Lantmäteriet 2 m DEM (clipped) | elevation gate, aspect/depression (`fTerrain`), hillshade (Terrängskugga) |
| twi | `twi_10m.tif` | `npm run twi` (`scripts/compute-twi.mjs`): Horn slope + D8 flow accumulation at native res, pooled to 10 m; slope floored at 0.5° so tan β never 0; TWI hard-capped at 18 in scoring to avoid flat-marsh spikes | `fTWI` (weight 0.06) |
| slope | `slope_10m.tif` | same script (Horn, degrees); real alt: `gdaldem slope` | mixed into `fTerrain` (0.7/0.3) with `slopeIdeal` |
| water_rel | `water_rel_10m.tif` | `npm run microclimate` from twi+slope (0..1 hollow/wetness index) | `fWaterHollow` (0.05) |
| stand_struct | `stand_struct_10m.tif` | same script from tradhojd+slope+twi (0..1) | `fStandStruct` (0.05) |
| water_dist | `water_dist_10m.tif` | `npm run water-dist`: chamfer distance (m) to NMD water classes 61/62 (fallback: DEM nodata), pooled to ~10 m | `fWaterDist` (0.04), soft complement to the hard 50 m water buffer |
| dodved | `dodved_10m.tif` | Skogsstyrelsen/SLU dead-wood inventory (demo: random) | `fDeadwood` (0.05), only for `woodHost` species |
| gdd5 | `smhi_gdd5.tif` | SMHI PTHBV 1991–2020 Σ max(0,T−5), DEM lapse −0.9 GDD/m at scoring; fallback `2200−(lat−55)·130−elev·0.9` | `fClimate` trapezoid hard gate per species GDD envelope (widened by plasticity·150) |
| mask | `nmd_10m.tif` | NMD2023 **v2.x** (class codes differ from v0!): forest 111–117+121–127 pass; 118/128 clear-cuts excluded; 51–54 dilated 3 px (30 m); water 61/62 dilated 5 px (50 m hard buffer); 0 = outside coverage → 0 | replaces OSM forest gate |
| vectors | `avverkningar_senaste_5ar.geojson`, `nyckelbiotoper.geojson`, `sumpskogar.geojson` | Skogsstyrelsen | clearcut veto, ×1.3 nyckelbiotop, ×1.15 sumpskog |
| OSM (fallback) | `data/osm/{forest,exclusion}_*.json` | offline bake from Geofabrik PBF (`npm run osm-bake`); live Overpass only as last resort (blocked from user's Mac) | forest polys, exclusions (30 m), water (50 m), paved roads (50 m zero / 80 m ×0.5) |
| observations | `data/validation/observations.geojson` | Artportalen via GBIF mirror (`npm run artfakta`) | `obsPrior` boost (see §3) |

## 2. Static habitat score (`staticHabitatScore`)

```
habitat = G_hard × G_host × (S_env/100) × M_bonus × roadFactor
G_hard = 0 on: clearcut, excluded (water 50 m / buildings 30 m), !forestOk, DEM nodata/<0.5 m,
           mask veto, hostVol < minHostVolume·(1−0.6·plasticity), tradhojd < minTreeHeight·(1−0.5·plasticity)
           (age ≥ 80 halves the height requirement — old stunted pine heath), vetoMoisture, vetoSoil,
           fClimate ≤ 0. Uncovered cells → 0.4.
G_host = 0.1 + 0.9·clamp01(hostVol / (3·minHostEff))   (woodHost species skip the host gate)
S_env  = 100 · Π soft(fᵢ)^(wᵢ·sharp)
         weights: moisture .17, age .13, canopy .08, soil .09, SIS .07, climate .07, depth .07,
                  terrain .07, TWI .06, waterHollow .05, standStruct .05, waterDist .04, deadwood .05
         sharp = 1.8 − 1.6·plasticity ;  soft floor = 0.05 + 0.25·(1−plasticity)
M_bonus = nyckelbiotop ×1.3 × sumpskog ×1.15 × edge
roadFactor = 0 (<50 m paved) / 0.5 (<80 m) / 1
```

**Plasticity** (0–1, default 0.65): trattkantarell 0.9, kantarell 0.85 … sommartryffel 0.15,
jättemusseron 0.25, korallticka 0.3. High = flat curves, soft gates, wide GDD envelope;
low = near-binary. This is the "how forgiving is this species" knob.

## 3. Dynamic score (`D`) + observation prior

```
D = season(lat-shifted, winter-wrap aware) × (1−exp(−rain14/32)) × (0.75 + 0.25·(1−exp(−rain90/120)))
    × frost (frostSensitive && min48h ≤ −3 °C → 0) × flush (1 + 0.25·min(1, coolNights7d/4))
score = min(100, 100 · habitat · D · (1 + 0.15·obsPrior))     ← saturating rain curves + capped prior
obsPrior = max exp(−(d/400 m)²) over Artportalen occurrences, cutoff 1200 m (grid-indexed 0.05°);
           obsPrior = 0 forced for protected species (jättemusseron)
```

**APPLIED 2026-11 (deep-dive fixes, commit after 743a880):** (1) softFloor inverted to
`0.02 + 0.28·p`; (2) S_env weights rebalanced — moisture .15, age .15, canopy .09, soil .10,
SIS .07, climate .07, depth .07, terrain .07, TWI .04, waterHollow .03, standStruct .05,
waterDist .03, deadwood .05 (hydrology total .25, no double-count); (3) specialist veto:
plasticity ≤ 0.30 && (fSoil < 0.20 || fDepth < 0.20) → score 0; (4) rain14/rain90 now
saturating `1−exp(−r/32)` / `0.75+0.25·(1−exp(−r/120))`; (5) obsPrior capped at +15 %, σ 400 m,
cutoff 1200 m, and forced 0 for protected species.

Weather: SMHI metobs latest-months, 6 h caches; `date` param is ISO YYYY-MM-DD, max 120 d back.

## 4. Species catalog (61)

Each entry: hosts, minHostVolume/minTreeHeight, vetoMoisture, moisture/canopy/soil ideals,
sun/depression/edge, frostSensitive, eatScore ★, `note` (ID tips), `lookalikes` (deadly
lookalike warning), `protected` (jättemusseron FRIDLYST/VU), `expertMode` (18 species with
deadly lookalikes — murklor, champinjoner, vårmusseron, kremlor, Cortinarius…), `pack`
(monetization: 6 free species, rest in packs; see PACKS-MONETIZATION.md), `plasticity`,
`twiIdeal`/`slopeIdeal`/`waterIdeal`/`structIdeal`/`waterDistIdeal`, `gddEnvelope`,
`depthIdeal`, winter-wrap seasons. Seasons calibrated from Artportalen observations
(p5–p95 months, `SEASON_FROM_OBS`).

## 5. Validation & known pitfalls

- `npm run validate`: AUC per species + GDD band, observations vs random background
  **inside the forest mask** (raw-bbox background is meaningless — cities/water are hard 0).
  Protected species (blurred coordinates in open data) flagged separately, not KALIBRERA.
- Last real run (Stockholm bbox, demo SLU layers): mean AUC 0.558 — expected low until real
  SLU rasters replace demo data; relative ranking already sensible.
- Rendering: globally snapped cell ladder (0.0001° doubling), ≥150 m gutter, ×2 upscale,
  premultiplied separable blur, sharp post-blur clip where cell score ≤ 0, cluster boost
  (~50 m neighbors). Disk cache `data/tile-cache/r15/...`.
- Sandbox limits: Overpass/SLU/SGU/NV/Geofabrik unreachable; `curl` blocked (use node fetch).

## 6. Questions for Gemini's deep-dive

1. ~~S_env weights~~ → APPLIED: rebalanced to hydrology total .25 (see §3 above); question
   remains whether TWI/water_rel should dominate markfuktighet classes on real data.
2. ~~plasticity shape~~ → APPLIED: floor inverted (`0.02+0.28·p`) + specialist veto on
   soil/depth for p ≤ 0.30; keep an eye on whether more factors deserve vetoes.
3. ~~obsPrior +35 %~~ → APPLIED: +15 % max, σ 400 m, cutoff 1200 m, protected → 0.
4. ~~rain90 shape~~ → APPLIED: saturating `0.75+0.25·(1−exp(−rain90/120))`, rain14
   `1−exp(−rain14/32)`; lag/lead effects still open.
5. Missing layers worth adding: brandfält (fire sites — murklor), stigavstånd (path edge),
   Sentinel-2 NDVI, SGU berggrund kalk/pH, first/last frost rasters, soil compaction.
6. AUC targets: what per-species AUC is "good enough" to ship, and which species should we
   recalibrate first given the last report?
