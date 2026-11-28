# Kartdata på extern SSD — vad, hur, struktur (för alla appar)

Princip: **SSD:n är single source of truth**, repot hålls litet (`data/` är git-ignored).
Server på Mac läser rasters via **symlink** `~/Projects/mushroom/data/layers` → SSD, så ingen
kopiering. Allt som appen/webben ska konsumera i prod synkas vidare till **Cloudflare R2**
(loose PNG tiles, `Cache-Control: immutable`, 0 kr egress — se docs/CLOUDFLARE-DEPLOY.md).

## 1. föreslagen mappstruktur på SSD:n

```
/Volumes/SvampradarSSD/
  00-sources/                 # rå nedladdningar, immutable — rör aldrig, bara lägg till
    _manifest.json            # per fil: url, datum, licens, sha256, z/x/y eller bbox
    lantmateriet/
      nh-2m/                  # nationell höjdmodell, LAS/GeoTIFF per kartblad (~tungt)
      ortofoto/               # OM du ska ha satellit — annars hoppa (se nedan)
    nmd/nmd_10m.tif           # Lantmäteriet NMD (10 m, hela Sverige)
    slu-skogskarta/           # trädhöjd, volym, trädslag, ålder, SIS ...
    slu-markfuktighet/
    sgu/                      # jordart, jorddjup, berggrund
    skogsstyrelsen/           # avverkningar, nyckelbiotoper, sumpskogar (WFS→GeoJSON)
    smhi/gdd5.tif
    osm/sweden-latest.osm.pbf # Geofabrik (~1–2 GB)
  10-derived/                 # genererat från 00-sources — får regenereras
    rasters-3006/             # tiled 256x256 GeoTIFF, EPSG:3006, uint16/float32
      10m/  50m/              # gdalwarp -tr 10 10 / -tr 50 50 -t_srs EPSG:3006
    basemap/
      osm-standard-z5z14.pmtiles
      opentopo-z5z14.pmtiles
      trails-z5z16.pmtiles    # waymarkedtrails/OSM hiking
      ortofoto-z12z18.pmtiles # bara om du kör satellit
    hillshade/z5-z13/...png  # från NH (visuellt lager; slope/TWI är det som är svampdata)
    habitat/z5-z10/<art>/...png   # vår egen bake (npm run bake-tiles)
    overview/<art>.json       # Tier-1 top-spots (npm run bake-overview)
  20-app-exports/
    ios/                      # vad appen pekar på (R2-url i prod, lokal server i dev)
    web/                      # samma tiles som webben
    offline-packs/            # per-art atlas z5–z9 ≈ 12 MB/art (valfritt i telefonen)
  30-repo-link/               # symlink-mål: ~/Projects/mushroom/data/layers -> 10-derived/rasters-3006
```

Namnkonvention överallt: `<källa>__<produkt>__<upplösning>__<epsg>__<datum>.<ext>` — och patchar
följer redan `data/layers/patches/<fil>__patchA.tif` (se docs/TEST-PATCHES.md), så lägg nya
patches på SSD och kör `npm run test-patches -- --register-only`.

## 2. Vad som ska laddas ner (källa, licens, ungefärlig storlek)

| Data | Källa | Licens | Storlek | Användning |
| --- | --- | --- | --- | --- |
| Nationell höjdmodell 2 m | lantmateriet.se öppna data (gratis konto) | CC BY 4.0, © Lantmäteriet | ~40–60 GB rå (LAS) | DEM → slope/aspekt/TWI (svampdata!) + hillshade (visuellt). Derive till 10/50 m tiled TIFF |
| NMD 2023 10 m | Lantmäteriet | CC BY 4.0 | ~1–2 GB | skogsmask (forestClasses 111–117, 121–127) |
| SLU Skogskarta (trädhöjd, volym, trädslag, ålder, SIS) | slu.se/skogsstyrelsen.se | öppna geodata | några GB | habitatfaktorer |
| SLU Markfuktighetskarta | slu.se | öppna | ~1 GB | fuktighet 1–5 |
| SGU jordart/jorddjup/berggrund | sgu.se WFS | öppna | <1 GB | jordart, pH-proxy |
| Skogsstyrelsen avverkningar, nyckelbiotoper, sumpskogar | kartor.skogsstyrelsen.se WFS | öppna | GeoJSON, litet | veto + bonus |
| SMHI GDD5 | opendata.smhi.se | CC BY 4.0 | litet | klimatfaktor |
| OSM Sweden PBF | download.geofabrik.de/europe/sweden-latest.osm.pbf | ODbL, © OpenStreetMap contributors | ~1–2 GB | basemap-vektor + stigar + forest/exclusion-masker (osmium) |
| Ortofoto (satellit) | Lantmäteriet | CC BY 4.0 | **hundratals GB** — kör bara z12+ för utvalda områden, eller ta Sentinel-2 (gratis, 10 m) för översikt | "Satellit"-läge i appen |

**Tips:** för baskarta i prod, rendera egna tiles från OSM-PBF:n (planetiler/tilemaker → PMTiles)
eller ladda ner färdiga rastertiles EN gång (z5–z14 Sverige ≈ 3–6 GB) och self-hosta på R2.
Det undviker tredjeparts-ToS och rate limits, och ger offline-möjlighet. App Store kräver
dessutom HTTPS i prod — R2/CDN löser det.

## 3. Format — vad till vad

- **PMTiles** (en fil, HTTP range requests) för **vektor-baskartor** och **stigar**, och gärna
  även raster-baskartan (raster PMTiles finns). Perfekt att spegla rakt upp på R2/S3.
- **Loose PNG i kataloger** (`{z}/{x}/{y}.png`) för **våra egna lager**: habitat-heatmaps och
  hillshade — redan planerat så (docs/TODO-LAUNCH.md: habitat z5–z10 alla arter ≈ 2.4 GB,
  hillshade z5–z13 ≈ 2 GB, immutable). z11+ körs on-demand från tunn origin.
- **Tiled GeoTIFF 256×256, EPSG:3006** för alla habitat-rasters (matchar manifest + uint16 NMD
  + patch-systemet). `gdalwarp -of GTiff -co TILED=YES -co BLOCKXSIZE=256 -co BLOCKYSIZE=256
  -t_srs EPSG:3006 -tr 10 10` (hela Sverige i 10 m behöver `-tr 50 50`, annars blir lagret
  "tooBig" och servern vägrar cacha det — se docs/AUDIT.md).
- **GeoJSON** för små vektorlager (avverkningar, nyckelbiotoper).

## 4. Pipeline (Mac, mot SSD:n)

1. Ladda ner till `00-sources/` + skriv rad i `_manifest.json` (url, datum, licens, sha256).
2. Derive: `gdalwarp`/`gdal_translate` → `10-derived/rasters-3006/` (10 m och 50 m).
3. `ln -s /Volumes/SvampradarSSD/30-repo-link/layers ~/Projects/mushroom/data/layers`
   (eller kopiera manifest + patches; håll manifest.json i repot, rasters på SSD).
4. Baka tiles: `npm run bake-tiles -- --all-species --bbox 10,55,24,69 --zmin 5 --zmax 10`
   (static) och `npm run bake-overview -- --all-species` för Tier-1 JSON.
5. Synka till R2: `rclone sync 10-derived/habitat r2:svampradar-tiles/habitat
   --checksum --header "Cache-Control: max-age=31536000, immutable"` (samma för hillshade,
   basemap PMTiles). TILE_V i repot höjs vid varje ny bake.

## 5. Per app

- **iOS (Xcode)**: MapLibre style pekar på R2-URLs i prod (HTTPS, ta bort
  NSAllowsArbitraryLoads), lokal server i dev. Baskart-switcher (Terräng/OSM/Satellit) =
  PMTiles/raster-källor ovan. Valfritt offline: per-art habitat-atlas z5–z9 ≈ 12 MB/art +
  basemap PMTiles i app-bunten. Attribution synlig i appen: © OpenStreetMap contributors,
  © Lantmäteriet, Waymarked Trails.
- **Web**: samma tiles från samma R2-bucket (public/map.js redan pekar på /api/tiles;
  i prod byts det mot R2-url).
- **Server/dev**: läser rasters från SSD via symlink; tiles-cachen `data/tile-cache/` är
  lokal och git-ignored.

## 6. Storleksbudget (Sverige)

- Rå källor på SSD: ~60–100 GB (domineras av NH 2 m; ortofoto bara om du verkligen vill ha satellit).
- Derived rasters 50 m: några GB; 10 m: ~10 GB (tiled uint16).
- På R2/CDN: habitat z5–z10 ≈ 2.4 GB + hillshade z5–z13 ≈ 2 GB + basemap ≈ 3–6 GB ≈ **~7–11 GB**
  → ryms i Cloudflare R2 free tier (10 GB) med marginal, annars ~4 öre/mån.
- I telefonen (valfritt offline): basemap PMTiles + per-art atlas ≈ 12 MB/art.

## 7. Checklista innan full Sverige-bake

- [ ] `00-sources/_manifest.json` ifylld (licens + sha256 per fil)
- [ ] alla rasters i `10-derived/rasters-3006/50m` (och 10 m där det behövs) — tiled 256, EPSG:3006
- [ ] symlink `~/Projects/mushroom/data/layers` → SSD; `npm run typecheck`; server startar utan "Saknade datafiler" (utom frivilliga)
- [ ] `npm run test-patches` grönt (Patch A/B) innan hel-bake
- [ ] bake z5–z10 + hillshade → R2 med immutable headers; TILE_V bump
- [ ] iOS: HTTPS-only i prod, attribution, restore purchases, privacy-delete (5.1.1v) — se docs/PROD-READINESS.md
