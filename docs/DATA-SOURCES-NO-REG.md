# Hel-Sverige-data UTAN Lantmäteriet-registrering (verifierat 2026-11-26 från sandbox)

Lantmäteriets konto/STAC ger 401/403 utan registrering — här är källor som svarar direkt:

| Data | Källa | Registrering? | Verifierat | Hur |
| --- | --- | --- | --- | --- |
| **DEM 30 m (ersätter NH 2 m tills vidare)** | **AWS Open Data: Copernicus DEM GLO-30** `https://copernicus-dem-30m.s3.amazonaws.com/` | **ingen** | ✅ 200, tiles finns | 1°×1°-tiles: `Copernicus_DSM_COG_10_N59_00_E018_00_DEM/Copernicus_DSM_COG_10_N59_00_E018_00_DEM.tif` (COG, range-GET funkar). Sverige ≈ N55–N69 × E010–E025 (~240 tiles, några GB). `gdalwarp` mosaik → EPSG:3006, `-tr 50 50` |
| DEM 25 m bättre kvalitet (EU-DEM v1.1) | Copernicus Data Space | gratis email-konto (enkelt) | — | https://dataspace.copernicus.eu |
| **Skogsmask 10 m (NMD-substitut)** | OSM PBF via Geofabrik | **ingen** | ✅ 206 Partial Content, ~1 GB | `https://download.geofabrik.de/europe/sweden-latest.osm.pbf` → `npm run osm-cache`/osmium → forest/exclusion (redan vår fallback). Alternativ: Copernicus HRL Forest 10 m (Data Space) |
| OSM (baskarta, stigar, vägar) | Geofabrik (samma PBF) | ingen | ✅ | som ovan; `npm run osm-bake` |
| Trädhöjd/volym/trädslag (SLU Skogskarta) | `kartor.slu.se` / Skogsstyrelsen geoserver (WMS/WCS) | ingen | ⚠️ ej nåbar från sandbox (egress), funkar från Mac | WCS GetCoverage → GeoTIFF → warpa |
| Avverkningar, nyckelbiotoper, sumpskogar | Skogsstyrelsen WFS/GeoJSON | ingen | ⚠️ samma | `kartor.skogsstyrelsen.se` |
| Jordart/jorddjup/berggrund | SGU | ingen (direkt-zip på sgu.se; WFS ibland 502) | ⚠️ maps.sgu.se 502 från sandbox | sgu.se → geodata → nedladdning |
| Klimat GDD5 / väder | SMHI opendata | ingen | ✅ 200 (1.7 MB param-lista) | redan kopplat |
| Satellit (valfritt) | Sentinel-2 L2A (AWS `sentinel-s2-l2a` eller Data Space) | ingen på AWS (requester-pays) | — | låg prioritet |

**Rekommenderad ordning utan Lantmäteriet:**
1. GLO-30 från AWS S3 (DEM) → `gdalwarp -t_srs EPSG:3006 -tr 50 50 -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256`.
2. Geofabrik-PBF → OSM forest/exclusion masks (vår kod har redan Overpass/disk-cache; osmium-bake lokalt).
3. SLU Skogskarta + Skogsstyrelsen + SGU från Mac (öppna WMS/WCS/zip, ingen registrering).
4. NMD 10 m från Lantmäteriet **när** kontot är klart (bättre än OSM-mask för skog) — men appen funkar utan den (maskUsed=false → OSM-fallback).

## Vad som ska fixas nu — prioriterat (2026-11-26)

1. **Hel-Sverige-rasters på SSD:n** (blockerar allt): källor ovan; `gdalwarp -tr 50 50` för scoring-rasters (10 m hel-Sverige = ~12.4 G px/layer → `layersTooBig`), DEM 50 m; patch-systemet (`npm run test-patches`) täcker regioner utan hel täckning. EPSG:3006 + tiled 256 överallt.
2. **AUC-validering mot riktiga data**: `npm run artfakta` (60/61 arter nu), `npm run validate`, skicka till Gemini med `docs/AUDIT.md` + `MODEL-DEEP-DIVE.md`. Ingen launch utan detta.
3. **Bake + hosting**: `npm run bake-overview -- --all-species`, `npm run bake-tiles -- --all-species --bbox 10.9,55.3,24.2,69.1 --zmin 5 --zmax 10` → R2 immutable; cron `workday_autobake.sh`.
4. **iOS prod-kritiskt**: server-side kvittovalidering (App Store Server API) ersätter dev-`ents=`-trust; HTTPS-only ( bort `NSAllowsArbitraryLoads`); `DEBUG_API` av i prod; restore purchases; ta bort review-reward; privacy-delete finns. Gold pins + capped-banner + `rainWindowDays` per art + `/api/v1/fungi/overview` + rain-history/clouds-lager enligt docs/CLOUDS.md.
5. **PR #1**: merge-beslut när iOS är synkat (draft idag).
6. Senare/ej kritiskt: dodved-lagret, ortofoto/satellitlager, hillshade z11+, D1/Worker-ombyggnad av signals.

## Snabbstart nedladdning 2026-11-28 (ingen registrering, kör från Mac mot SSD:n)

Saknas för r16 hel-Sverige: DEM (ersätt NH), SLU grunddata + DTW, hel-Sverige avverkningar,
skyddade områden, kustmask. Lägg råfiler i `canonical_gis/00-sources/` + rad i `_manifest.json` (url, datum, licens, sha256).

DEM GLO-30 (30 m, ~225 tiles för Sverige, några GB) från AWS Open Data — detta block har inga kommentarer:

```bash
mkdir -p /Volumes/HD2021/SvampradarData/canonical_gis/06_dem_glo30 && cd /Volumes/HD2021/SvampradarData/canonical_gis/06_dem_glo30
for lat in $(seq 55 69); do for lon in $(seq 10 24); do printf "N%02d_00_E%03d_00\n" $lat $lon; done; done > tiles.txt
cat tiles.txt | xargs -P 8 -I{} sh -c 'n="{}"; curl -sf -o "Copernicus_DSM_COG_10_${n}_DEM.tif" "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${n}_DEM/Copernicus_DSM_COG_10_${n}_DEM.tif"'
ls *.tif | wc -l
```

Sedan mosaik + reprojicering (gdal finns på Macen? annars `brew install gdal`):

```bash
gdalwarp /Volumes/HD2021/SvampradarData/canonical_gis/06_dem_glo30/*.tif /Volumes/HD2021/SvampradarData/canonical_gis/06_dem_glo30/dem_sweden_3006_50m.tif -t_srs EPSG:3006 -tr 50 50 -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256 -co COMPRESS=DEFLATE
gdaldem slope dem_sweden_3006_50m.tif slope_50m.tif -of COG -co COMPRESS=DEFLATE
gdaldem aspect dem_sweden_3006_50m.tif aspect_50m.tif -of COG -co COMPRESS=DEFLATE
```

(TWI: enkel python/gdal-script över slope+uppsamlingsarea, eller SAGA om installerat.)

Övriga nedladdningar (från Mac, ingen registrering):
- SLU Skogliga grunddata (trädslag gran/tall/löv, trädhöjd, ålder, volym, grundyta, SIS): https://skogsdataportalen.slu.se/ (nedladdningssidan) eller WCS från https://kartor.slu.se/ — GeoTIFF per lager, hela Sverige.
- SLU Markfuktighetskarta (DTW): samma portal, raster ~50 m hel-Sverige.
- Skogsstyrelsen hel-Sverige (avverkningar senaste 5 åren, nyckelbiotoper, sumpskogar): WFS/GeoJSON från https://kartor.skogsstyrelsen.se/
- Naturvårdsverket skyddade områden (naturreservat, nationalparker, Natura 2000): öppna data-zip/gpkg från naturvardsverket.se (sök "Naturvårdsverket skyddade områden nedladdning").
- Kustmask: Natural Earth 10 m `ne_10m_coastline.zip` från https://www.naturalearthdata.com/downloads/10m-cultural-vectors/
- (valfritt) SGU berggrund/kalkindex: sgu.se geodata-nedladdning. (valfritt) färsk OSM PBF: https://download.geofabrik.de/europe/sweden-latest.osm.pbf
- (valfritt, enkel mail-registrering) EU-DEM v1.1 25 m: https://dataspace.copernicus.eu

Behövs INTE laddas ner (finns redan på SSD:n): NMD 10 m, SGU jorddjup, SGU jordart raw gpkg (rasteriseras lokalt), SMHI GDD5, OSM vatten-masker (04_vatten_osm), Mälardalen-paketet.

Efter nedladdning: `gdalwarp -tr 50 50 -t_srs EPSG:3006` på alla scoring-rasters (NMD-masken körs i 10 m), tiled 256, och rad i `canonical_gis/_manifest.json`.
