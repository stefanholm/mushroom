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
  water (61/62) and all other classes are hard 0 without eroding forest edges.
- inside an OSM exclusion polygon **or within 30 m of one** (yard/building buffer):
  water, waterway, buildings, urban/residential/industrial/…, parks, pitches, shops…
  (`data/osm/exclusion_*.json`). Multipolygon `role="inner"` rings are subtracted from
  their outer ring, so village enclaves inside forests are not masked as forest.
- within 20 m of a **paved** road/rail/aeroway line (motorway…service; forest
  `path`/`footway`/`track` are deliberately kept open — chanterelles like trails);
  20–35 m → ×0.5
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
S_env = 100 × g(fMoisture)^0.35 × g(fMaturity)^0.25 × g(fCanopy)^0.20 × g(fSoil)^0.10 × g(fTerrain)^0.10
        where g(x) = max(0.05, x)
        (weighted GEOMETRIC mean — a single weak factor drags the whole cell down
         instead of being averaged away; true hard vetoes below return score 0 directly)

fMaturity = clamp01( (tradhojd − minTreeHeight) / 16 + 0.35 )     ; tradhojd < minTreeHeight → score 0
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
        × (1 + 0.15 × species.edge)           if within ~1 cell of the forest-mask edge
roadFactor = 0 if within 15 m of an exclusion line (roads/rail — hard zero),
             0.5 if within 30 m, else 1
(OSM relation members are assembled into closed rings before point-in-polygon, so
 building/water relations are masked correctly)
```

### D — dynamic fruiting multiplier (SMHI metobs, `latest-months`)

```
seasonalFactor = 0 outside [seasonStart−0.5, seasonEnd+0.5], linear ramps of 0.5 month,
                 month shifted by latitude: month' = month + (59 − lat) × 0.1
rainFactor     = min(1, rain14 / 60 mm)   ; rain14 = Σ daily precip, 14 days ending at the
                 selected date, nearest active station; no data → 0.5 (neutral)
frost          = 0 if species.frostSensitive and min(temp last 48 h) ≤ −3 °C, else 1
```

## 2. Species rule matrix (src/habitat.ts, `SPECIES`)

| Species | hosts (weight) | minHostVol | minTreeH | veto moisture | moisture ideal | canopy ideal | soil pref | sun | depression | edge | frost sens. | season |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kantarell | björk 1, ek 1, bok 1, gran 0.8, tall 0.6 | 15 | 10 | 5 (blöt) | 2–3 | 15–28 | acidic 1 | +1 | 0.3 | 1 | yes | Jul–Oct |
| Trattkantarell | gran 1, tall 0.5, björk 0.2 | 30 | 14 | 1 (torr) | 3–4 | 25–40 | acidic 1 | −1 | 1 | 0.2 | no | Sep–Nov |
| Karljohan | gran 1, ek 0.9, bok 0.9, björk 0.8, tall 0.5 | 20 | 12 | 5 | 2–3 | 18–30 | acidic 0.9 | +0.5 | 0.2 | 0.5 | no | Aug–Sep |
| Svart trumpetsvamp | ek 1, hassel 0.8, bok 0.4, björk 0.3 | 15 | 12 | 1, 2 | 4 | 22–35 | calcareous 1; **veto acidic** | −1 | 1 | 0.3 | no | Aug–Oct |

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
disk-cached under `data/tiles/<tileVersion>/`. Clients should set `maxzoom: 16` on the raster
source (MapLibre then GPU-overzooms instead of requesting z17+) and append `&v=<tileVersion>`
(from `/api/meta`) to bust caches.

## 4. Data lineage

| Layer id | File (data/layers/) | Source |
|---|---|---|
| tradhojd, volym, grundyta, gran, tall, bjork, ek, bok | `skog_*_10m.tif`, `grundyta_10m.tif` | SLU Skogskarta / Skogliga grunddata (via Skogsstyrelsen) |
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
- OSM disk-cache key format unified with `toFixed(6)` on both server and bake script
  (float artifacts like `18.400000000000002` vs `18.400000000000006` previously made the
  cache never match for multi-tile bboxes — the cause of `skog: 0 · exkl: 0`).
- Score distribution on the demo area (static, kantarell): ≥70 → ~18–34%, ≥95 (red) → ~1.6%.
- Ecology: top-score cells per species match their hosts/soil/moisture (trattkantarell →
  spruce + fukt 3–4; svart trumpetsvamp → ek/hassel on calcareous, fukt 4).
