# How mushroom hotspots are computed (full equations)

Everything below is implemented in `src/habitat.ts` (static habitat), `src/server.ts`
(dynamic weather + tile rendering). Demo data in `data/layers/` is synthetic; swap in the
real SLU/SGU/Lantmäteriet/Skogsstyrelsen files listed in the README (same filenames,
EPSG:3006) and the same equations apply.

## 1. Per-cell score (0–100)

```
score = clamp0to100( round( 100 × habitat × D ) )

habitat = G_hard × G_host × (S_env / 100) × M_bonus × roadFactor     (0–1.35)
D       = seasonalFactor × rainFactor × frost                        (0–1, dynamic)
```

`static=1` mode sets `D = 1` (habitat potential only).

### G_hard — global hard veto (0 or 1), returns score 0 immediately if any:

- outside the OSM forest mask (`data/osm/forest_*.json`, baked via Overpass/OSM API).
  **Strictly fail-closed:** if the mask is unknown (fetch failed / outside baked tiles),
  `inForest = false` → score 0 — the map never shows hotspots where the mask is missing
  (`forestKnown` in `/api/meta` tells you). If the optional **NMD mask** raster
  (`nmd_10m.tif`, Naturvårdsverket NMD 10 m) is present it **replaces** the OSM forest gate:
  `forestClasses` = 111–117 + 121–127 pass (NMD 118/128 = clear-cuts, excluded);
  classes 51/52/53/54 (building/other exploited/road+rail/peat cutting) are dilated 3 px ≈ 30 m and subtracted;
  water (61/62) is hard 0 **plus a 50 m buffer** (`waterBufferM`, dilated 5 px at 10 m);
  0 (outside coverage) and all other classes are hard 0 without eroding forest edges.
- inside an OSM exclusion polygon **or within 30 m of one** (yard/building buffer):
  buildings, urban/residential/industrial/…, parks, pitches, shops…
  (`data/osm/exclusion_*.json`, `polys`). Multipolygon `role="inner"` rings are subtracted from
  their outer ring, so village enclaves inside forests are not masked as forest.
- inside a **water** polygon or **within 50 m of one** (`natural=water`, `waterway`;
  stored separately as `water` in `exclusion_*.json`, or NMD 61/62 in the mask) —
  no mushrooms right at the shoreline/stream
- within **50 m** of a **paved** road/rail/aeroway line (motorway…service; forest
  `path`/`footway`/`track` are deliberately kept open — chanterelles like trails);
  50–80 m → ×0.5 (pollution falloff)
- inside `avverkningar_senaste_5ar.geojson` (recent clear-cuts — dead mycorrhiza)
- DEM (`hojdmodell_2m.tif`) nodata **or** elevation < 0.5 m (sea/lake surface)

After rendering, tile alpha is **clipped to hot cells only** — circles from neighbouring
hot cells are zeroed in any pixel whose cell has `G_hard = 0`, so blobs can never bleed
into the sea, suburbs or roads.

Debug a single point: `GET /api/debug/cell?lat=59.205&lon=17.905&species=kantarell` prints
elevation, mask flags, hostVol, every `f*` factor and the final score.

### G_host — obligate mycorrhizal host gate (0–1)

```
hostVol = Σ over species.hosts { tree: w }  w × volume_raster[tree]     (m³/ha)

if any species raster has a value at the cell:
    hostVol < minHostVolume            → score 0        (hard veto)
    G_host = 0.1 + 0.9 × clamp01( hostVol / (3 × minHostVolume) )
else (fallback, flagged as hostFallback in /api/meta):
    same formula with the total-volume raster `skog_volym_10m.tif`
```

### S_env — environmental suitability (0–100)

```
S_env = 100 × g(fMoisture)^0.26 × g(fAge)^0.18 × g(fCanopy)^0.12 × g(fSoil)^0.10 × g(fSIS)^0.08
            × g(fClimate)^0.08 × g(fDepth)^0.08 × g(fTerrain)^0.10
        where g(x) = max(0.05, x)
        (weighted GEOMETRIC mean — a single weak factor drags the whole cell down
         instead of being averaged away; true hard vetoes below return score 0 directly)

tradhojd < minTreeHeight → score 0                       (hard gate; maturity now via age, not height)
fAge      = triangular over species.ageIdeal [lo, hi] years (skog_alder_10m.tif, SLU "Beståndsmedelålder")
fSIS      = triangular over species.sisIdeal [lo, hi] H100 (skog_sis_10m.tif)
fClimate  = trapezoid over species.gddEnvelope [hMin,iMin,iMax,hMax] on the DEM-adjusted heat sum:
            gddEff = smhi_gdd5.tif − max(0, elevationM) × 0.9   (SMHI PTHBV 1991–2020 GDD>5 °C,
            lapse rate −0.9 GDD/100 m ≈ −0.65 °C/100 m; raster treated as sea-level reference).
            Outside [hMin, hMax] → HARD 0 (regional bioclimatic gate: Limes Norrlandicus ≈ 1250 GDD,
            subalpine belt 500–800 GDD). Missing raster → factor 1.
fDepth    = triangular over species.depthIdeal [lo, hi] metres to bedrock (sgu_soil_depth_10m.tif,
            SGU Jorddjupsmodell 10 m). Thin rock (<0.8 m) suppresses karljohan/svart trumpetsvamp;
            jättemusseron accepts both deep sand and thin hällmark (depthIdeal [0,100]).
            Missing raster → factor 1.
fTerrain  = clamp01( 0.5 + 0.3·sun·cos(aspect−180°) + 0.2·depression·clamp01(ringDepth/5) )  (7×7 DEM window)
fMoisture = clamp01( 1 − dist(markfuktighetsklass, moistureIdeal) / 1.5 )
            ; klass ∈ vetoMoisture → score 0                         (klass 1..5: torr..blöt)
fCanopy   = clamp01( 1 − dist(grundyta, canopyIdeal) / 6 )          (m²/ha)
fSoil     = species.soil[ jordart group ]  (jordart recode: 1→acidic, 2→calcareous, else neutral; default 0.7)
            ; group ∈ species.vetoSoil → score 0  (svart trumpetsvamp vetoes acidic)
fTerrain  = clamp01( 0.5 + 0.3·sun·cos(aspect−180°) + 0.2·depression·clamp01(ringDepth/5) )
            ; aspect & ring depth from a 7×7 window (250 m spacing) of hojdmodell_2m.tif
```

Cells where **no raster has any value** (outside data coverage) get habitat = 0.4 (dim, below
the glow threshold — visible only at low sensitivity).

### M_bonus — micro-habitat multiplier

```
M_bonus = 1.3                                  if inside nyckelbiotoper.geojson
        × 1.15                                 if inside sumpskogar.geojson
        × (1 + 0.15 × species.edge)           if within ~1 cell of the forest-mask edge
roadFactor = 0 if within 50 m of a paved road/rail/aeroway line (hard zero, pollution),
             0.5 if within 80 m, else 1
(OSM relation members are assembled into closed rings before point-in-polygon, so
 building/water relations are masked correctly)
```

### D — dynamic fruiting multiplier (SMHI metobs, `latest-months`)

Season windows are calibrated empirically from Artportalen observations (GBIF mirror of Artportalen,
Sweden, pulled 2026-11 — see `SEASON_FROM_OBS` in `src/habitat.ts`, e.g. kantarell observed p5–p95 =
Jun–Nov, frostvaxing Sep–Dec, varskivling May–Jun; jättemusseron lat 57.9–66.5 confirms its
northern/central range).

```
seasonalFactor = 0 outside [seasonStart−0.5, seasonEnd+0.5], linear ramps of 0.5 month,
                 month shifted by latitude: month' = month + (59 − lat) × 0.1
rainFactor     = min(1, rain14 / 60 mm)   ; rain14 = Σ daily precip, 14 days ending at the
                 selected date, nearest active station; no data → 0.5 (neutral)
frost          = 0 if species.frostSensitive and min(temp last 48 h) ≤ −3 °C, else 1
flush          = 1 + 0.25 × min(1, coolNights7d / 4)   ; coolNights7d = days with daily min
                 temp ≤ 10 °C in the 7 days ending at the selected date (no data → 1).
                 Cool-night flush trigger — matters for jättemusseron, trattkantarell, frostvaxing.
D = seasonalFactor × rainFactor × frost × flush
```

## 1b. Plasticity & observation prior

- **`plasticity`** (0–1, default 0.65) per art styr hur "flytande" arten är:
  låg plasticity (sommartryffel 0.15, jättemusseron 0.25, korallticka 0.3) → skarpare
  S_env-exponenter (`weight × (1.8 − 1.6·p)`), högre golv (`0.05 + 0.25·(1−p)`), hårdare
  GDD-kuvert; hög plasticity (trattkantarell 0.9, kantarell 0.85) → plattare kurvor,
  mjukare hårda trösklar (`minHostVolume × (1−0.6p)`, `minTreeHeight × (1−0.5p)`) och
  GDD-kuvertet breddas med `150·p`.
- **TWI + lutning**: `twi_10m.tif` (ln(a/tan β), D8/SAGA från 2 m-DEM) blir egen S_env-faktor
  (vikt 0.08, `twiIdeal` per art, default [5,11]); `slope_10m.tif` (grader, Horn/gdaldem)
  viktas in i fTerrain (0.7/0.3, `slopeIdeal` per art, default [0,30]). Saknas lagren →
  faktorn = 1. Demo: `npm run demo-data`; riktiga: se README (gdaldem slope + SAGA TWI).
- **Observationsprior**: `data/validation/observations.geojson` (från `npm run artfakta`)
  laddas i ett rutnät (0.05°) per art; score × (1 + 0.35·exp(−(d/250 m)²)) nära riktiga fynd.
  Ingår i tiles och `/api/debug/cell` (`obsPrior`).

## 2. Species rule matrix (src/habitat.ts, `SPECIES`)

Every species also carries `eatScore` (ätvärde 1–5, shown as ★ in the UI and `/api/meta`
`speciesList`), a Swedish `note` with identification/safety guidance, `ageIdeal`, and
`protected` (jättemusseron is **fridlyst** in Sweden — shown with a warning, do not pick) and
`expertMode` (61 species total; expert-mode species — murklor, champinjoner, vårmusseron,
kremlor, spindelskivlingar m.fl. — have deadly lookalikes and are only shown in the UI behind
the Expertläge toggle, always with their warning note; the chat never recommends them as safe).
Habitat references: Artdatabanken Artfakta, Svampguiden, Wikipedia.

| Species | eat | hosts (weight) | minHostVol | minTreeH | veto moisture | moisture ideal | canopy ideal | soil pref | sun | depression | edge | age ideal | frost sens. | season |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kantarell | 5 | björk 1, ek 1, bok 1, gran 0.8, tall 0.6 | 15 | 10 | 5 (blöt) | 2–3 | 15–28 | acidic 1 | +1 | 0.3 | 1 | 40–130 | yes | Jul–Oct |
| Trattkantarell | 4 | gran 1, tall 0.5, björk 0.2 | 30 | 14 | 1 (torr) | 3–4 | 25–40 | acidic 1 | −1 | 1 | 0.2 | 30–120 | no | Sep–Nov |
| Karljohan | 5 | gran 1, ek 0.9, bok 0.9, björk 0.8, tall 0.5 | 20 | 12 | 5 | 2–3 | 18–30 | acidic 0.9 | +0.5 | 0.2 | 0.5 | 30–120 | no | Aug–Sep |
| Svart trumpetsvamp | 5 | ek 1, hassel 0.8, bok 0.4, björk 0.3 | 15 | 12 | 1, 2 | 4 | 22–35 | calcareous 1; **veto acidic** | −1 | 1 | 0.3 | 40–130 | no | Aug–Oct |
| Jättemusseron (goliatmusseron) | 5 ⚠fridlyst | tall 1, gran 0.2 | 40 | 18 | 4, 5 | 1–2 | 10–25 | acidic 1 | +1 | 0.2 | 0.2 | 60–160 | no | Aug–mid Oct |
| Stolt fjällskivling | 4 | björk 0.7, ek 0.6, bok 0.4, hassel 0.4 | 5 | 0 | 4, 5 | 2–3 | 0–18 | neutral 1 | +1 | 0 | 1.5 | 0–80 | yes | Jul–Oct |
| Rödgul trumpetsvamp | 4 | gran 1, tall 0.4, björk 0.2 | 25 | 12 | 1 | 3–4 | 20–40 | acidic 1 | −1 | 1 | 0.2 | 30–120 | no | Aug–Nov |
| Blek taggsvamp | 3 | gran 0.8, bok 0.7, ek 0.7, björk 0.6, tall 0.5 | 15 | 8 | 5 | 2–4 | 15–35 | neutral 1 | 0 | 0.5 | 0.5 | 20–120 | no | Aug–mid Oct |
| Vårskivling | 3 | björk 0.7, ek 0.6, hassel 0.5, bok 0.4 | 5 | 0 | 4, 5 | 2–3 | 0–20 | calcareous 1 | +1 | 0 | 1.2 | 0–60 | yes | mid Apr–Jun |
| Brunsopp | 4 | tall 1, gran 0.7, björk 0.3 | 20 | 10 | 5 | 2–3 | 15–30 | acidic 1 | +0.5 | 0.3 | 0.5 | 30–120 | no | Aug–Nov |
| Sandsopp | 4 | tall 1 | 20 | 8 | 4, 5 | 1–2 | 8–22 | acidic 1 | +1 | 0 | 0.3 | 20–90 / SIS 8–15 | no | Jul–mid Oct |
| Smörsopp | 3 | tall 1, gran 0.3 | 20 | 8 | 5 | 1–3 | 10–25 | acidic 1 | +1 | 0.2 | 0.5 | 15–70 / SIS 10–18 | no | Jul–Oct |
| Blomkålssvamp | 4 | tall 1 | 30 | 15 | 4, 5 | 2–3 | 10–25 | acidic 1 | +1 | 0 | 0.2 | 70–160 / SIS 8–16 | no | Aug–Oct |
| Fårticka | 4 | gran 1, tall 0.5, björk 0.4 | 25 | 12 | 4, 5 | 2–3 | 20–35 | neutral 1 | 0 | 0.5 | 0.5 | 40–130 / SIS 14–22 | no | Aug–Oct |
| Rödgul taggsvamp | 4 | gran 1, tall 0.6, björk 0.5 | 15 | 8 | 1 | 3–4 | 15–35 | acidic 1 | −0.5 | 1 | 0.3 | 20–120 / SIS 12–22 | no | Aug–Nov |
| Frostvaxing | 4 | tall 1, gran 0.4 | 25 | 12 | 3, 4, 5 | 1–2 | 8–20 | acidic 1 | +1 | 0 | 0.3 | 30–100 / SIS 8–16 | no | Oct–Dec |
| Aspsopp | 4 | asp 1, björk 0.6, ek 0.4 | 15 | 8 | 4, 5 | 2–3 | 10–25 | neutral 1 | +0.5 | 0.2 | 0.8 | 20–100 / SIS 14–24 | no | Jul–Oct |
| Tegelsopp | 4 | björk 1, ek 0.5 | 15 | 8 | 4, 5 | 2–3 | 10–25 | neutral 1 | +0.5 | 0.2 | 0.5 | 20–100 / SIS 14–24 | no | Jul–Oct |
| Blek kantarell | 5 | ek 1, hassel 0.9, bok 0.85 | 18 | 10 | 5 | 3–4 | 15–30 | calcareous 1 | +0.5 | 0.3 | 0.8 | 45–130 / SIS 22–35 | yes | Jun–Sep (syd, lat≤59.7) |
| Kruskantarell | 4 | ek 1, hassel 0.9, bok 0.6 | 18 | 12 | 1 | 4 | 16–32 | calcareous 1 | −0.5 | 0.8 | 0.5 | 50–140 / SIS 22–34 | no | Aug–Oct |
| Mandelriska | 5 | ek 0.9, gran 0.8, bok 0.6, hassel 0.5 | 20 | 10 | 5 | 2–4 | 14–28 | calcareous 1 | +0.5 | 0.3 | 0.7 | 45–130 / SIS 20–32 | no | Jul–Oct |
| Tallblodriska | 5 | tall 1 | 20 | 8 | 4, 5 | 2–3 | 12–28 | calcareous 1 | +1 | 0 | 0.4 | 30–100 / SIS 16–28 | no | Aug–Nov |
| Granblodriska | 4 | gran 1 | 18 | 10 | 1 | 3–4 | 14–34 | calcareous 1 | −0.5 | 0.8 | 0.3 | 20–100 / SIS 18–32 | no | Aug–Oct |
| Grynsopp | 4 | tall 1, gran 0.3 | 16 | 8 | 5 | 2–3 | 10–26 | calcareous 1 | +1 | 0.2 | 0.6 | 20–80 / SIS 16–28 | no | Jun–Oct |
| Rödbrun stensopp | 5 | tall 1, gran 0.25 | 22 | 12 | 4, 5 | 2–3 | 12–28 | acidic 0.9 | +0.5 | 0.2 | 0.5 | 45–130 / SIS 14–25 | no | Jul–Oct (norr t.o.m. ~64.4) |
| Tallskrubb | 4 | tall 1 | 20 | 10 | 4, 5 | 2–3 | 10–26 | acidic 0.9 | +1 | 0 | 0.3 | 35–110 / SIS 13–24 | no | Jul–Oct (norr) |
| Björksopp | 4 | bjork 1, asp 0.3 | 14 | 8 | 5 | 2–4 | 8–28 | acidic 1 | +0.5 | 0.3 | 0.8 | 20–100 / SIS 12–30 | no | Jul–Oct (hela landet) |
| Zonerad granblodriska | 4 | gran 1 | 24 | 14 | 1 | 3–4 | 16–34 | acidic 1 | −0.5 | 1 | 0.2 | 45–130 / SIS 16–28 | no | Jul–Oct (58–64) |

Season windows for the older species were recalibrated from the same Artportalen pull
(kantarell Jun–Nov, karljohan Jul–Oct, trattkantarell Aug–Dec, blomkålssvamp Aug–Nov,
rödgul taggsvamp Jul–Nov, frostvaxing Sep–Dec). Wood-decayers (svavelticka, ostronmussling,
judasöra) are deliberately NOT in the catalog: they need a deadwood layer, not forest floor.
Goliatmusseron = *Tricholoma colossus* (NOT matsutake), fridlyst + VU → `protected` badge.

(Column order: eat · hosts · minHostVol · minTreeH · veto moisture · moisture ideal · canopy ideal ·
soil pref · sun · depression · edge · age ideal / SIS ideal · frost sens. · season. Excluded on
purpose: murklor (Gyromitra), champinjoner/vit flugsvamp, små Lepiota, vårmusseron (bolmörtsskivling),
spindelskivlingar — deadly lookalike risk. Goliatmusseron = *Tricholoma colossus* (NOT matsutake),
fridlyst + rödlistad VU in Sweden → `protected` badge, never recommend picking.)

(Svart trumpetsvamp around Stockholm/Mälardalen is oak + hazel in rich mossy mixed forest —
beech `bok` is weighted low on purpose; drop a `skog_hassel_10m.tif` into `data/layers/` and
it is picked up automatically.)

## 3. Heat → colour/alpha (tile renderer, `src/server.ts`)

```
heat = clamp01( (score − (HEAT_BASE + sens)) / HEAT_RANGE )     HEAT_BASE=70, HEAT_RANGE=30, sens ∈ [−10, +10]
alpha = 0 if heat < 0.08, else round( heat² × 0.95 × 255 )
colour ramp (heat → RGB): 0.35 #d95f02 · 0.55 #ff8c00 · 0.72 #f23c14 · 0.85 #e31a1c · 0.95 #ff2a00 · 1.0 #ffffb2
```

So red appears only around score ≥ 95 (plus cluster boost, below).

### Cluster boost (~50 m rule)

At street-level zooms (cell ≤ 150 m), each cell counts **hot neighbours** (heat ≥ 0.5) within
`radius = clamp(round(50 m / cellSize), 1, 5)` cells:

```
1 hot neighbour → +0.06 heat, circle radius step 1
2               → +0.12, step 2
3+              → +0.20, step 3   (only connected/touching circles get bigger)
heat_final = min(1, heat + stepBonus)
```

### Rendering (continuous Windy-style field)

Cells sit on a global snapped ladder grid (0.0001° ≈ 6 m, doubled until ≤ 110 cells per tile
span, origin snapped to multiples of the cell size — zoom-stable). Each tile is scored with a
**≥150 m geographic padding gutter** (so tile edges never lose neighbours/clusters at high
zoom). The per-cell heat (with cluster boost) is bilinearly/nearest upscaled ×2, then smoothed
with a separable box blur (2 passes, radius 2 — Gaussian approximation) applied premultiplied
by the hard mask. Final step: **post-blur sharp mask clip** — pixel alpha is zeroed wherever
the cell failed `G_hard` — so the smooth thermal gradient stops razor-clean at shorelines,
streets and yards. Colour ramp (heat → RGB): 0.25 teal `#00b2be` → 0.42 emerald `#10b981` →
0.58 amber `#f5b301` → 0.74 orange `#ff7a00` → 0.88 crimson `#e31a1c` → 0.97 `#ff2a00` →
1.0 `#ffffb2`; alpha = `heat² × 0.95`. Result bilinearly sampled to a 256×256 PNG,
disk-cached under `data/tile-cache/<tileVersion>/`. Clients should set `maxzoom: 16` on the raster
source (MapLibre then GPU-overzooms instead of requesting z17+) and append `&v=<tileVersion>`
(from `/api/meta`) to bust caches.

## 4. Data lineage

| Layer id | File (data/layers/) | Source |
|---|---|---|
| tradhojd, volym, grundyta, gran, tall, bjork, ek, bok, hassel, asp, **alder**, **sis** | `skog_*_10m.tif`, `grundyta_10m.tif` | SLU Skogskarta / Skogliga grunddata (via Skogsstyrelsen) |
| sumpskogar | `sumpskogar.geojson` | Skogsstyrelsen Sumpskogar (bonus ×1.15) |
| NMD land-cover mask | `nmd_10m.tif` (NMD2023 v2.x basskikt) | Naturvårdsverket (CC0), replaces OSM forest/exclusion gates when present |
| gdd5 (bioclimatic heat sum) | `smhi_gdd5.tif` | SMHI PTHBV 1991–2020 gridded normals, computed as Σ max(0, T−5 °C), EPSG:3006 |
| soildepth | `sgu_soil_depth_10m.tif` | SGU Jorddjupsmodell 10 m (resource.sgu.se/data/oppnadata/jorddjupsmodell/jorddjupsmodell.zip) |
| Artportalen observations | `data/validation/observations.geojson` (`npm run artfakta`) | SLU Artdatabanken via GBIF mirror / Artfakta API — used to calibrate seasons + AUC |
| markfuktighet | `markfuktighet_10m.tif` (klass 1–5) | SLU Markfuktighetskarta |
| jordart | `jordart_10m.tif` (recode 1→acidic, 2→calcareous) | SGU Jordarter |
| hojd | `hojdmodell_2m.tif` | Lantmäteriet Markhöjdmodell |
| avverkningar | `avverkningar_senaste_5ar.geojson` | Skogsstyrelsen Utförda avverkningar |
| nyckelbiotoper | `nyckelbiotoper.geojson` | Skogsstyrelsen Nyckelbiotoper |
| forest mask + exclusions | `data/osm/*.json` (disk-first; `npm run osm-cache -- minLon minLat maxLon maxLat`) | OpenStreetMap via Overpass (GET) / OSM API |
| rain 14 d, min temp 48 h | SMHI metobs API, param 5 / param 1, `latest-months` | SMHI Open Data |

All rasters/vectors must be EPSG:3006 (SWEREF 99 TM); `manifest.json` declares nodata/band/recode.

## 5. Verification done

- Layer reading round-trip checked against known demo features: lake nodata → 0, suburb
  zero-rect → 0, clear-cut polygons → 0, nyckelbiotop → ×1.3 bonus, forest cell → plausible
  values (see git history / PR #1).
- Fail-closed masking verified with a synthetic `data/osm/` cache: lake exclusion polygon →
  excluded → 0; multipolygon inner hole → not excluded; point on paved road → roadFactor 0 →
  0; point outside all baked tiles → `forestKnown=false`, score 0. Rendered tiles: lake
  window fully transparent even at sens=−10; hot-pixel coverage stable across z12–z16.
- 50 m water buffer verified: lake centre and +30 m → `nearWater=true, excluded=true, score=0`;
  +60 m → clear. Road falloff verified: 0 m → factor 0, ~56 m → 0.5, ~85 m → 1.
- `alder` raster loaded and `fAge` present in `/api/debug/cell`; new species return sane
  static scores on demo forest (vårskivling/stolt fjällskivling ≈ 48–49 at a test cell).
- OSM disk-cache key format unified with `toFixed(6)` on both server and bake script
  (float artifacts like `18.400000000000002` vs `18.400000000000006` previously made the
  cache never match for multi-tile bboxes — the cause of `skog: 0 · exkl: 0`).
- Score distribution on the demo area (static, kantarell): ≥70 → ~18–34%, ≥95 (red) → ~1.6%.
- Ecology: top-score cells per species match their hosts/soil/moisture (trattkantarell →
  spruce + fukt 3–4; svart trumpetsvamp → ek/hassel on calcareous, fukt 4).
- AUC validation: `npm run validate` (`scripts/validate-auc.mjs`) scores every Artportalen
  observation in `data/validation/observations.geojson` plus random background points via
  `/api/debug/cell?static=1`, computes AUC per species and per GDD band, and writes
  `data/validation/auc-report.json` (AUC < 0.7 flagged KALIBRERA). Requires the server
  layers in `data/layers/`; the script starts its own server instance on `VALIDATE_PORT`.
