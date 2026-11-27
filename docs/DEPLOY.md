# DEPLOY — vad som ska upp i Cloudflare, i vilken ordning, och hur du verifierar

Live just nu (2026-11-27): Worker `https://svampradar.natureradar-se.workers.dev`, R2 `natureradar-data`
(rclone-remote `r2:`), D1 `svampradar-db`, aktiv revision `DEFAULT_TILE_REV="r15"` (Mälardalen).
Layout i bucketten: `docs/R2-LAYOUT.md`. Denna sida är hela flödet på ett ställe.

## 0. Innan du pull:ar på Macen (git-krock)
Du har lokala ändringar i `worker/src/index.ts` + `scripts/bake-malardalen-r2.mjs` (Gemini-varianten,
med `.bak_20261127_*`-backups). Repot har nu hela kontraktet (bootstrap med shop/unlocked/rainSpans,
overview med tier-nycklar 55km/18km/6km + goldPeaks, zones från R2, edge-/api/meta). Spara undan:
```bash
cd ~/Projects/mushroom
git stash push -m "gemini-worker-variant" -- worker/src/index.ts scripts/bake-malardalen-r2.mjs
git pull --no-edit
git stash show -p stash@{0} | head -50   # jämför; droppa om repots variant duger
```
(`-m` FÖRE `--`.) Block-nycklar måste vara `<bx>_<by>` i SWEREF 10 km-meter (så skriver
`npm run bake-blocks`); om Gemini-scriptet skrev andra nycklar (t.ex. lon/lat-offset) → baka om blocken
med `bake-hotspot-blocks.mts`, annars hittar Workern inga pins ("inga svampar").

## 1. Baka (på Macen, rasters finns där — aldrig i molnet)
```bash
# Mälardalen-test (r15): eller hel Sverige (r16) när canonical_gis är komplett
npm run bake-overview -- --all-species                     # data/overview/*.json (+ pyramid profile)
npm run bake-blocks -- --species <arter> --out data/r2/hotspots [--bbox ...]   # 10x10 km-block
npx tsx scripts/bake-zones.mts --species <arter> --both --out data/r2/zones   # optimalzoner (VIKTIGT)
npm run bake-tiles -- --species <arter> --bbox ... --zmin 5 --zmax 10         # data/tile-cache/<rev>/
# root-filer från origin (Node igång lokalt):
#   /api/v1/manifest -> data/r2/manifest.json ; /api/v1/catalog -> catalog.json ; /api/shop -> shop.json
```
**Zoner (`zones/*.json`) måste alltid bakas och synkas** — Workern kan inte räkna optimalzon utan rasters;
saknas filen blir `optimalZone: null` i appen (loggat `hasZone=false peak=-1`).

## 2. Synka till R2 (avgränsade delar — många små filer)
```bash
node scripts/sync-r2.mjs --rev r15                      # per delmapp, --transfers 16 --checkers 16
# eller färdigpaketerat träd (t.ex. /Volumes/HD2021/SvampradarData/r2_ready med domains/...):
node scripts/sync-r2.mjs --src /Volumes/HD2021/SvampradarData/r2_ready
```

## 3. Byt revision SIST + deploya
```bash
# ändra DEFAULT_TILE_REV="r16" i worker/wrangler.toml (och tileRev i manifest.json) NÄR allt är synkat
cd worker && npx wrangler deploy
```

## 4. Verifiera med curl (innan du felsöker i Swift — nya workers.dev kan ge TLS -1200 i iOS i några minuter)
```bash
W=https://svampradar.natureradar-se.workers.dev
curl -sS "$W/manifest.json" | head -c 200; echo
curl -sS "$W/api/v1/bootstrap?species=blek-taggsvamp&ents=all" | python3 -c "import json,sys; d=json.load(sys.stdin); print('shop' in d, 'unlocked' in d, d.get('rainSpans'), list(d.get('fungi',{}).keys()))"
curl -sS "$W/api/v1/fungi/overview?species=blek-taggsvamp&static=1&ents=all" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['mode'], d['goldPeaks'], list(d['tiers'].keys()))"
curl -sS "$W/api/hotspots?bbox=17.3,58.9,18.5,59.7&static=1&species=blek-taggsvamp&ents=all&maxP=20" | python3 -c "import json,sys; d=json.load(sys.stdin); print('pins:', len(d['hotspots']), 'source:', d['meta']['source'])"
curl -sS "$W/api/v1/fungi/optimal-zone?species=blek-taggsvamp&static=1&ents=all" | python3 -c "import json,sys; d=json.load(sys.stdin); print('zone:', d.get('optimalZone') is not None, 'cached:', d.get('cached'))"
curl -sSI "$W/api/tiles/hillshade/8/136/84.png" | head -3
curl -sS "$W/api/v1/weather/rain-history/manifest?days=28" | head -c 150; echo   # från cron (inom 6 h)
```
Förväntat: bootstrap har shop/unlocked/rainSpans/fungi; overview har `tiers` med nycklar **55km/18km/6km**
+ goldPeaks; hotspots `source: r2-blocks` med pins; optimal-zone `cached:true` när zones synkats.

## 5. iOS-kontrakt att hålla koll på
- `OverviewResponse`: `overviewRevision, mode, capped, trial, goldPeaks, profiles, tiers [String:[OverviewTierSpot]]` — tier-nycklar 55km/18km/6km.
- Bootstrap: `shop, unlocked, rainSpans [14,21,28,42], clouds, rainHistory{14,21,28,42}, fungi{species:{overviewCells, zone, zonePending, profile, rainWindowDays}}`.
- `/api/debug/cell` finns INTE i prod (404) → `#if DEBUG` i Swift.
- `?ents=` accepteras bara när `ORIGIN_URL` är satt (dev); i prod kommer ents från D1 via `/api/verify-receipt`.

## 6. Säkerhet
Om en R2-nyckel syns i terminal/logg → revokera+rotera direkt i Cloudflare-dash (`wrangler secret put` för secrets).
