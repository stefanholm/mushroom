# DEPLOY — vad som ska upp i Cloudflare, i vilken ordning, och hur du verifierar

Live just nu (2026-11-27): Worker `https://svampradar.natureradar-se.workers.dev`, R2 `natureradar-data`
(rclone-remote `r2:`), D1 `svampradar-db`, aktiv revision `DEFAULT_TILE_REV="r15"` (Mälardalen).
Layout i bucketten: `docs/R2-LAYOUT.md`. Denna sida är hela flödet på ett ställe.

## 0. Innan du pull:ar på Macen (git-krock)

**Pull-krock på worker/wrangler.toml?** Repot har nu samma database_id — gör:
`git checkout -- worker/wrangler.toml` (efter att du kollat `git diff worker/wrangler.toml`),
sedan `git pull --no-edit && npm install`. Verifiera alltid efter pull: `git log --oneline -1`
ska visa senaste SHA (annars saknas nya scripts som `bake-root`).

**R2 root-filer heter `catalog.json`** (inte `meta.json` — gamla paket). Saknas catalog.json i R2
404:ar shop/unlocked/overview/hotspots/meta i Workern (de behöver katalogen). Workern har fallback
till meta.json, men kör hellre: `npm run bake-root` innan `sync-r2 --only root`.

**Uppladdning är ADDITIV (rclone copy)** — `sync-r2.mjs` använder copy default så en saknad lokal
mapp aldrig raderar R2 (lärdom: `rclone sync` tömde r15-root när bake-root inte körts). `--delete`
finns kvar men bara för hel revisionsväxling.

**D1 måste ha schemat:** `npx wrangler d1 execute svampradar-db --remote --file=worker/schema.sql`
Om någon tabell redan finns med andra kolumner (legacy, t.ex. gammal `profiles(app_id, device_uuid, ...)`
→ CLI failar med `no such column: ...`): droppa alla fyra och kör om (pre-launch, ingen data att spara):
`npx wrangler d1 execute svampradar-db --remote --command "DROP TABLE IF EXISTS signals; DROP TABLE IF EXISTS devices; DROP TABLE IF EXISTS profiles; DROP TABLE IF EXISTS reward_ledger;"`
och sedan `--file=worker/schema.sql` igen. (502 på report-signal = schema-mismatch.)
Workern själv-healar dessutom saknade kolumner vid körning via `ALTER TABLE ADD COLUMN` (se `worker/src/d1.ts`
`ensureSchema`) — men använd ALDRIG `env.DB.exec()` med flerradig SQL i workern: riktiga D1 kastar
`D1_EXEC_ERROR: ... incomplete input` (node:sqlite i testarna gör inte det, vilket maskerade felet lokalt).

**VARNING vid paste av kommandon i zsh:** lägg ALDRIG till `kommentar` efter ett kommando i ett
inklistrat block — din zsh kör då `#` som argument (sett: `pathspec ':(prefix:0)#' ...`), och hela
raden faller. Skriv kommentarer på egna rader utan `#`, eller ännu hellre: inga kommentarer alls.

**Binding-namn:** repots `worker/wrangler.toml` binder R2 som `TILES` och kod läser `env.TILES` —
Gemini-varianten hade `DATA`. Efter pull + `npx wrangler deploy    # config-kontroll innan: node scripts/deploy-check.mjs kollar wrangler.toml
#   (database_id maste vara riktigt — annars faller deploy med [code: 10021] och gammal worker ligger kvar)` matchar det igen.
Du har lokala ändringar i `worker/src/index.ts` + `scripts/bake-malardalen-r2.mjs` (Gemini-varianten,
med `.bak_20261127_*`-backups). Repot har nu hela kontraktet (bootstrap med shop/unlocked/rainSpans,
overview med tier-nycklar 55km/18km/6km + goldPeaks, zones från R2, edge-/api/meta). Spara undan:
```bash
cd ~/Projects/mushroom
git stash push -m "gemini-worker-variant" -- worker/src/index.ts scripts/bake-malardalen-r2.mjs
git pull --no-edit
npm install   # efter pull: nya beroenden (t.ex. compression); undvik npx-install-prompten
git stash show -p stash@{0} | head -50   # jämför; droppa om repots variant duger
```
(`-m` FÖRE `--`.) Block-nycklar måste vara `<bx>_<by>` i SWEREF 10 km-meter (så skriver
`npm run bake-blocks`); om Gemini-scriptet skrev andra nycklar (t.ex. lon/lat-offset) → baka om blocken
med `bake-hotspot-blocks.mts`, annars hittar Workern inga pins ("inga svampar").

Se även `docs/FRONTEND-CONTRACT.md` — exakt vad iOS ska skicka (endpoints, params, svar, failproof).

## 1. Baka (på Macen, rasters finns där — aldrig i molnet)
```bash
# Mälardalen-test (r15): eller hel Sverige (r16) när canonical_gis är komplett
npm run bake-overview -- --all-species                     # data/overview/*.json (+ pyramid profile)
npm run bake-blocks -- --species <arter> --out data/r2/hotspots [--bbox ...]   # 10x10 km-block
npx tsx scripts/bake-zones.mts --species <arter> --both --out data/r2/zones   # optimalzoner (VIKTIGT)
npm run bake-tiles -- --species <arter> --bbox ... --zmin 5 --zmax 10         # data/tile-cache/<rev>/
# root-filer (manifest/catalog/shop) — utan Node igång, direkt från koden:
npm run bake-root                          # skriver data/r2/{manifest,catalog,shop}.json (tileRev fran src/server.ts)
# (alternativt med Node igång: /api/v1/manifest, /api/v1/catalog, /api/shop)
# Obs: ingen meta.json behövs — Workerns edge-/api/meta byggs från catalog.json.
# Moln/regn-frames (frames/clouds, frames/rain) bakas av Workerns cron inom 6 h efter deploy;
#   finns de inte: vanta pa cron eller baka fran origin.
```
**Zoner (`zones/*.json`) måste alltid bakas och synkas** — Workern kan inte räkna optimalzon utan rasters;
saknas filen blir `optimalZone: null` i appen (loggat `hasZone=false peak=-1`).

## 2. Synka till R2 (avgränsade delar — många små filer)
```bash
node scripts/sync-r2.mjs --rev r15 --only root,zones,hotspots   # root fran bake-root + zoner/block
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
