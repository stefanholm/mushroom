# worker/ — Cloudflare Worker framför Svampradar (R2 + origin-proxy)

**Varför (UX):** stora PNG (tiles/ikoner) serveras direkt från R2 nära användaren med
`Cache-Control: immutable` → snabb cold-start globalt, 0 kr egress (R2 gratisnivå 10 GB).
**IP-skydd:** bara Workern blir publik; Node-originen (`ORIGIN_URL`) exponeras aldrig
(det är där alla beräkningar/vikter finns — se `docs/IP-PROTECTION.md`).

## Deploy-steg

```bash
# 0. En gång: Cloudflare-konto + Wrangler
npm i -g wrangler && wrangler login

# 1. R2-bucket (matchar wrangler.toml)
wrangler r2 bucket create svampradar-tiles

# 2. Baka tiles på Macen (z5–z10 alla arter + hillshade z5–z13), sedan synka till R2:
npm run bake-tiles -- --all-species --bbox 10.9,55.3,24.2,69.1 --zmin 5 --zmax 10
rclone config            # eller: wrangler r2 object put --bulk
rclone sync data/tile-cache/r15/ r2://svampradar-tiles/tiles/
rclone sync public/icons r2://svampradar-tiles/icons/
# (URL /api/tiles/habitat/<art>/<z>/<x>/<y>.png mappas av Workern till R2-nyckeln
#  tiles/habitat/<art>/<z>/<x>_<y>.png — samma layout som på disk.)

# 3. Sätt origin (Node-servern, t.ex. på Mac via tunnel eller liten VPS):
wrangler secret put ORIGIN_URL   # eller [vars] i wrangler.toml
#   ORIGIN_URL = "https://din-node-origin.example.com"

# 4. Deploya + custom domain (gratis HTTPS)
cd worker && wrangler deploy
#   Cloudflare-dash: Workers & Pages → din worker → Settings → Triggers → Custom Domain
#   t.ex. api.svampradar.se  (peka DNS på Cloudflare, proxy orange-cloud ON)

# 5. iOS: byt serverBaseURL till https://api.svampradar.se (ta bort NSAllowsArbitraryLoads
#    i release — HTTPS føljer med; behåll NSAllowsLocalNetworking för dev-Mac)
```

## Routing i Workern (`src/index.ts`)
| Begäran | Var den svaras |
|---|---|
| `/api/tiles/<lager>/<z>/<x>/<y>.png` | R2 `tiles/<lager>/<z>/<x>_<y>.png` (immutable) |
| `/icons/<fil>.png` | R2 `icons/<fil>.png` (immutable) |
| `/api/*`, `/`, `/vendor/*` (inkl. moln/regn-frames) | proxy → `ORIGIN_URL` (frames är redan immutable hos origin → CDN-cachar dem på edge) |

## Nästa steg när detta är uppe (spåras i docs/TODO-LAUNCH.md §0b)
- `POST /api/verify-receipt` i Workern: App Store Server API (JWS ES256, `.p8` som Worker-secret)
  → auktoritativa entitlements i D1 → `/api/shop` + `/api/unlocked` blir korrekta direkt vid start
  utan extra rundor; dev-lägets `?ents=`-trust stängs av i prod.
- App Store Server Notifications v2-webhook → D1 (förnyelser/återbetalningar).
- Flytta även moln/regn-frames till R2 (`frames/clouds/<id>`, `frames/rain/<id>`) när volymen växer.
- D1 för signals/redeem/referrals (i stället för node:sqlite på origin).
