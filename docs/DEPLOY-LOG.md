# DEPLOY-LOG — register över uppladdningar till Cloudflare (R2 + Worker)

Fyll på en rad efter varje bake+sync+deploy. `scripts/sync-r2.mjs` skriver ut en färdig loggrad.
Proceduren i detalj: `docs/DEPLOY.md` + `docs/R2-LAYOUT.md`.

| Datum | Revision | Worker version ID | Vad som synkades | rclone-tid | Verifierat (deploy-check) | Anteckningar |
|---|---|---|---|---|---|---|
| 2026-11-27 | r15 (Mälardalen) | 2f3d21b2-0917-4e76-a5f9-3ef8247a07fb | ikoner 61, overview 61, tiles 199 (z5–z10), hotspot-block 22021 (Gemini-script, äldre nyckelschema) | — | delvis (overview OK via curl) | Första deploy; blocks med fel nyckelschema → hotspots [] |
| 2026-11-27 | r15 (åter-deploy av gammal lokal variant) | 84fddafd-b038-49f7-9d9c-5a5db20e5330 | (ingen ny sync — pull föll pga # i paste) | — | FAIL: hotspots [], zone {"zone":null} | Se DEPLOY.md §0 varning om # i zsh |
| 2026-11-27 | r15 (repo-version efter pull b15de56) | _(fyll i)_ | zones + hotspot-block (rätt `<bx>_<by>`-schema) via sync-r2 --only zones,hotspots | _(fyll i)_ | `node scripts/deploy-check.mjs` | väntar på pull+deploy |
| 2026-11-27 | r15 | deploy FAIL [code: 10021] (saknat database_id) | zones (2 filer, peak 0.787) + hotspots (68 block, 10 200 pins) synkade OK (2,1 s + 0,3 s) | 2,4 s | gammal worker kvar: pins=0, zone=null, tiers=tier1..3 | database_id = d588ad45-81e5-4d59-8d77-4914142ca7e1 nu i wrangler.toml (25b9bdf+); deploy-check kollar config fore nätet |
| 2026-11-27 | r15 | _(nytt version-ID efter deploy)_ | + root (manifest/catalog/shop via npm run bake-root) | _(fyll i)_ | deploy-check mot prod | zoner nu i R2; frames via cron inom 6 h |
| 2026-11-27 | r15 | 9f8b87fb-8ab3-4118-93b7-bdfce4a3d1ea | R2 har hotspots/overview/tiles/zones + meta.json (saknar catalog.json!) | — | 2 PASS 6 WARN 4 FAIL: manifest+zone OK; overview/hotspots/meta/unlocked 404 (catalog.json saknas), report-signal 502 (D1-schema) | orsak: pull föll (lokal wrangler.toml) → bake-root kördes ej → rclone sync tömde root. Fix: checkout wrangler.toml, pull 802f97c+, bake-root, sync-r2 (copy, additivt), D1 re-init |

## Regler (från lärdomarna)
- Baka nya revisioner i `/Volumes/HD2021/SvampradarData/r2_ready/`; synka i delar (`sync-r2.mjs --rev rX [--only ...]`, `--transfers 16 --checkers 16`); byt `DEFAULT_TILE_REV` i `worker/wrangler.toml` SIST; `wrangler deploy`; verifiera med `node scripts/deploy-check.mjs` (eller curl först vid TLS -1200 på nya workers.dev).
- Om en R2-nyckel syns i terminal/logg: revokera+rotera direkt i dash.
- Inga `#`-kommentarer i inklistrade zsh-block.
