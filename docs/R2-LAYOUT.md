# R2-LAYOUT — bucket `natureradar-data` (rclone-remote `r2:`), hur allt är strukturerat

Live just nu (2026-11-27): Worker på `https://svampradar.natureradar-se.workers.dev`, Mälardalen-paket `r15` synkat, iOS pekar på Worker-URL:en.

En bucket, prefix per domän + revision (immutable deploy: baka till NY mapp, byt `tileRev` sist):

```
r2:natureradar-data/
├── promo/family.json                        # korsmarknadsföring mellan appar (utan nytt App Store-släpp)
└── domains/fungi/<TILE_REV>/                # t.ex. r15 idag, r16 vid nästa helbake
    ├── manifest.json                        # publikt manifest (tileRev, bounds, endpoints) — från GET /api/v1/manifest
    ├── catalog.json                         # från GET /api/v1/catalog (61 arter, pack, free, klassiker, prices)
    ├── shop.json                            # från GET /api/shop (statisk bas; worker filtrerar ägda per ents)
    ├── tiles/habitat/<art>/<z>/<x>_<y>.png     # från data/tile-cache/<rev>/habitat/...
    ├── tiles/multi/<z>/<x>_<y>.png
    ├── tiles/hillshade/<z>/<x>_<y>.png
    ├── icons/<art>.png                      # från public/icons/
    ├── overview/<art>.json                  # från data/overview/ (2 km-celler, bake-overview)
    ├── overview/species-pyramid-profile.json
    ├── hotspots/<art>/<bx>_<by>.json        # 10x10 km-block (EPSG:3006, meter-tusental), bake-hotspot-blocks.mts
    ├── zones/<art>-<date>-<static>.json     # förbakad optimalzon, bake-zones.mts (origin/Mac — rasters upp i molnet aldrig)
    ├── frames/clouds/manifest.json + <id>.png   # SMHI SNOW1gv1, bakas av Worker-cron
    ├── frames/rain/manifest-<days>d.json + <days>d/<id>.png  # Metobs param 5, Worker-cron
    └── weather/live.json                    # 0.5°-rutnät rain14/28/42 för live-faktor i Workern
```

**URL → R2-nyckel (worker/src/index.ts):**
- `/api/tiles/<lager>/<z>/<x>/<y>.png` → `domains/fungi/<rev>/tiles/<lager>/<z>/<x>_<y>.png`
- `/icons/<f>` → `domains/fungi/<rev>/icons/<f>`
- `/manifest.json`, `/api/v1/manifest` → `.../manifest.json`
- `/api/hotspots` → läser `hotspots/<art>/*.json` (block efter bbox)
- `/api/v1/fungi/overview` → `overview/*.json`
- `/api/v1/fungi/optimal-zone` → `zones/<art>-<date>-<s>.json`
- `/api/v1/bootstrap` → sätter ihop manifest+catalog+shop+frames+leaderboard(D1)+fungi-bundle
- moln/regn-manifest+frames → `frames/...`

## Synk-kommandon (från Mac, efter bakning)
Baka alltid nya revisioner i `/Volumes/HD2021/SvampradarData/r2_ready/` (med `canonical_gis/` och
`gdalwarp -tr 50 50` på scoring-rasters). Synka i avgränsade delmängder med hög parallellitet —
tiotusentals små JSON-filer i EN stor sync är långsamt (lärdom 2026-11-27):
```bash
node scripts/sync-r2.mjs --rev r16                      # alla delar, --transfers 16 --checkers 16 per del
node scripts/sync-r2.mjs --rev r16 --only hotspots,zones  # bara utvalda delar
node scripts/sync-r2.mjs --rev r16 --dry                # torr körning
REV=r16
rclone sync data/tile-cache/$REV/  r2:natureradar-data/domains/fungi/$REV/tiles/    --transfers 16 --checkers 16
rclone sync public/icons            r2:natureradar-data/domains/fungi/$REV/icons/
rclone sync data/overview           r2:natureradar-data/domains/fungi/$REV/overview/
rclone sync data/r2/hotspots        r2:natureradar-data/domains/fungi/$REV/hotspots/ --transfers 16 --checkers 16
rclone sync data/r2/zones           r2:natureradar-data/domains/fungi/$REV/zones/
# manifest/catalog/shop: hämta från origin först (t.ex. via webbläsare eller node-fetch på Macen)
#   GET /api/v1/manifest -> data/r2/manifest.json ; GET /api/v1/catalog -> catalog.json ; GET /api/shop -> shop.json
rclone copy data/r2/manifest.json data/r2/catalog.json data/r2/shop.json r2:natureradar-data/domains/fungi/$REV/
```

**Immutable deploy:** byt `DEFAULT_TILE_REV` i `worker/wrangler.toml` (och `tileRev` i manifest.json)
FÖRST när hela revisionen är synkad, sedan `cd worker && wrangler deploy`. Rulla tillbaka = byt tillbaka.

## Gratisgränser att passa (0 kr/mån)
- R2: 10 GB lagring, **0 kr egress**, 10M Class A (läs)/mån, **1M Class A-skrivningar/mån** — baka bara z5–z10 (~250k filer), aldrig z11 (~970k). Hotspot-block ~4,5k filer. På sikt PMTiles (61 filer).
- Workers: 100k anrop/dag, 10 ms CPU — cron-bakningen kan behöva Workers Paid ($5/mån), R2-egress är ändå 0 kr.
- D1: 5 GB, 5M läs/dag, 100k skriv/dag — alla tabeller har `app_id` från dag 1 (schema.sql).
- Sätt usage alerts vid 80 % i Cloudflare-dashen.

## Deploy utan driftstopp
Baka till `r16/`, testa, byt sist `tileRev` i `manifest.json` (och `TILE_REV` i wrangler vars vid deploy). Rulla tillbaka = ändra tillbaka — 5 sekunder, ingen användare ser halvfärdigt.
