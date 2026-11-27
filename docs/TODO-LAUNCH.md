# TODO-LAUNCH — vad som återstår, uppdelat på server / telefon / statisk hosting

Datum: 2026-11-22. Branched `vibe/mistral-chat-df5813` (PR #1, draft).

## 0b. NÄSTA UX-VINSTER — SPÅRADE (glöm ej) ✅ kom ihåg dessa

- [ ] **Cloudflare Worker + R2 framför** — tiles/ikoner servas immutable direkt från R2 nära
      användaren → snabb cold-start globalt, 0 kr egress; bara Workern blir publik (Node-originen
      exponeras aldrig — IP-skydd, se `docs/IP-PROTECTION.md`). **Skelett klart:** `worker/`
      (wrangler.toml + src/index.ts + README.md med deploy-steg och rclone-kommandon).
      Deploy enligt `worker/README.md`; design i `docs/CLOUDFLARE-DEPLOY.md`.
- [ ] **App Store Server API-kvitto** (`POST /api/verify-receipt` i Workern, JWS ES256 med `.p8`
      som Worker-secret → entitlements i D1; ANS v2-webhook för förnyelser) → `shop`/`unlocked`
      blir auktoritativa direkt vid app-start utan extra rundor; stäng av dev-lägets
      `?ents=`-trust i prod. Se `docs/PROD-READINESS.md` + `docs/CLOUDFLARE-DEPLOY.md` §2/§7.
- [ ] **Per-art-bundlar så telefonen inte ska "tänka"** — KLART i backend:
      `GET /api/v1/bootstrap?species=a,b,c&ents=...` ger nu även `fungi: { <art>: { label, season,
      rainWindowDays, pack, profile, overviewCells (topp-120), zone (SWR-cachat optimalzon),
      zonePending } }` + `skippedSpecies`. iOS behöver alltså bara bootstrap + tiles + frames.
      Nästa steg (valfritt): nedladdningsbar per-art atlas z5–z9 (~12 MB) från R2.
- [ ] **IP-skydd i prod** — se `docs/IP-PROTECTION.md`: debug-endpoints redan 404 utan
      `DEBUG_API=1`; `/api/meta` skickar lager-diagnostik bara lokalt; rate limits på
      hotspots/overview/optimal-zone/bootstrap/tiles; Worker framför så origin är privat.

## 0. Först: fixa git-state på Macen (pull vägrade nyss pga lokal ändring i src/server.ts)

```bash
cd ~/Projects/mushroom
git status -s
git diff src/server.ts | head -40
git stash push -m "lokal server.ts innan pull" -- src/server.ts
git pull --no-edit
git diff stash@{0} HEAD -- src/server.ts | head -40
git stash drop
```

(`-m` måste komma FÖRE `--`.) Om diffen stash vs HEAD är tom/dubblett av det som nu är committat
(`518a6b5`, `921afed`) är det säkert att droppa stashen.

## 1. På servern (detta repo, din Mac `~/Projects/mushroom`)

- [ ] `git pull` enligt §0, sedan `.env`: `ADMIN_PIN=...`, `FREE_HIDE_FRACTION=0.30`,
      `TOP_SPOTS_PRICE_SEK=99` (finns i `.env.example`); starta om (`lsof -ti :3000 | xargs kill && npm run dev`)
- [ ] Ladda ner riktiga hel-Sverige-rasters och **warpa ner dem**: scoring-rasters
      `gdalwarp -tr 50 50` (10 m hel-Sverige ≈ 12.4 G px/layer ryms inte i minnet — servern varnar
      högljutt och sätter `layersTooBig` i `/api/meta` om något är för stort); DEM till 10–25 m;
      NMD-masken kan vara 10 m (nedprovas automatiskt nu, se `518a6b5`). Kontrollera EPSG:3006 på allt.
- [ ] `npm run validate` (AUC) — nu snabb via batch-endpointen; skicka rapporten till Gemini
      tillsammans med `docs/AUDIT.md` + `docs/MODEL-DEEP-DIVE.md`
- [ ] Baka statiska tiles: `npm run bake-tiles -- --all-species --bbox 10.9,55.3,24.2,69.1 --zmin 5 --zmax 10`
      (se §3 för storlek), synka `data/tile-cache/` till R2/S3
- [ ] Beslut: merge:a PR #1 när iOS är synkad (den är draft)
- [ ] (valfritt) cron kl 06:00: batch-baka `hotspots-<art>-<region>.json` till statisk hosting
- [ ] (valfritt) ta bort `dodved_10m.tif` ur manifestet eller ladda ner den

## 2. I telefonen (Xcode-projektet `/Users/stefanh/Documents/Svampradar/Svampradar`, ligger EJ i repot)

- [ ] On-device chat: `Services/OnDeviceChat.swift` från `docs/CHAT-ONDEVICE.md`
      (engångskoll första launch; göm chatt helt utan Apple Intelligence; ingen Mistral-nyckel i appen)
- [ ] Alltid skicka `ents=` på `/api/hotspots` och tiles (även tom), `static=1` på tiles, `minScore=70`,
      timeouts 15 s/25 s på fastSession (patchar från tidigare — finns i konversationen)
- [ ] Rendera `pin.gold` som guldglöd; visa capped-banner från `meta.capped / goldPeaks / passId / passLabel / passPriceSek`
- [ ] StoreKit 2-produkter: 13 pack + `goliatmusseron-solo` (79 kr) + enskilda arter (39 kr) +
      årskort `topspots:2026` (249 kr, från `/api/shop` `topSpotsPass`); i prod validera kvitton
      server-side via App Store Server API (ersätter dev-lägets `ents=`-trust)
- [ ] **Stycklistan (enskilda 39 kr) ska bara visa arter användaren saknar** — `/api/shop?ents=...`
      filtrerar server-side (`singles` = bara icke-ägda, `topPicks` likaså, pack får `owned:true`);
      skicka alltid med klientens ents när shopen hämtas. **Goliatmusseron/jättemusseron är
      solo-only** (`SOLO_ONLY_SPECIES`) — syns aldrig i stycklistan, bara som paketet
      `goliatmusseron-solo` 79 kr (`/api/single/claim` ger 403 för den)
- [ ] Reward-UI: betyg 1–5 eller kommentar → 1 art från poolen; 2 referral-koder → +2 arter
      (`POST /api/reward/claim`, `/api/referral/create|redeem`; pool = `meta.reviewRewardSpecies`)
- [ ] Redeem-kod i shoppen (`POST /api/redeem`)
- [ ] Ikoner: placeholders finns i `public/icons/*.png` (61 st); riktiga foton senare
- [ ] Städa `*.bak*` i Views-mappen när allt är verifierat

## 3. Statisk hosting + hur stora kartorna blir

**Hosting:** Cloudflare R2 + CDN (egress = 0 kr) eller S3+CloudFront. Tiles får `Cache-Control: immutable`
(redan satt). Telefonen laddar bara synliga tiles (tiotals per skärm, några hundra KB per pan) —
GB-siffrorna nedan är vad som ligger på CDN:en, inte på telefonen.

**Tile-antal för Sverige (bbox 10.9,55.3 – 24.2,69.1, Web-Mercator):**

| zoom | tiles per zoom | kumulativt z5–z |
|------|---------------|-----------------|
| 5–9  | 1 234 totalt  | 1 234           |
| 10   | 3 306         | 4 540           |
| 11   | 13 148        | 17 688          |
| 12   | 52 440        | 70 128          |
| 13   | 208 767       | 278 895         |

**Storlek per tile (mätt på servern):** rå RGBA-PNG på brusig demodata gav ~27 KB (z10) – ~82 KB (z12);
riktig slät habitat-data komprimerar betydligt bättre, och **palette-PNG/WebP (score 0–100 = 8 bit)**
antar vi ~10 KB/tile habitat och ~8 KB/tile hillshade i planeringen.

| Lager | Zoom | Tiles | ca storlek |
|-------|------|-------|-----------|
| Habitat, alla 55 arter | z5–z9  | 67 900   | ~0.6 GB (rå RGBA ~5 GB) |
| Habitat, alla 55 arter | z5–z10 | 249 700  | ~2.4 GB (rå ~17 GB) |
| Habitat, alla 55 arter | z5–z11 | 972 840  | ~9.3 GB (rå ~65 GB) |
| Habitat, alla 55 arter | z5–z12 | 3 857 040 | ~37 GB — **för mycket att baka**, kör on-demand |
| Hillshade (ändras sällan) | z5–z13 | 278 895 | ~2.1 GB, immutable |
| Per-art "atlas" nedladdad till telefonen | z5–z9 | 1 234/art | ~12 MB per art |

**Rekommendation:** baka habitat **z5–z10 för alla arter (~2.4 GB, R2 kostar ~4 öre/mån)** +
hillshade z5–z13 (~2 GB). z11+ körs on-demand från en tunn origin (LRU + CDN-cache tar omtag).
Om du vill ha offline-atlas i telefonen: per-art z5–z9 ≈ 12 MB (z10+ för stort att ladda ner).
Baka med `npm run bake-tiles` (finns redan), parallellisera, och synka med t.ex.
`rclone sync data/tile-cache r2:svampradar-tiles` eller `aws s3 sync`.

**Hotspots/pins:** håll on-demand först (LRU-cachad, billig); alternativt daglig batch till
statiska JSON per art/region (~15 KB per region-art, gzip ~4 KB).

**Hillshade — visuellt eller svampdata? Både och:** själva hillshade-PNG-lagret är bara visuellt
(kan skippas helt, eller bakas bara på låga zoom — sparar ~2 GB). Men **DEM + slope används i
själva scoringen**: `fTerrain` får `+0.3·species.sun·cos(aspect−180°)` (sydsluttningar gynnas av
arter med `sun=1`, nordsluttningar av `sun=-1`), svackor får bonus via `species.depression`,
och lutning via slope-rasteret (`fSlope`). Så DEM/slope måste finnas på servern för att räkna
score — de behöver bara inte renderas som tiles.

## 4. Vad som MÅSTE ligga på en server alls

- `/api/chat` (Mistral) — finns kvar för webb/dev; iOS använder on-device istället (docs/CHAT-ONDEVICE.md)
- Kvittovalidering (App Store Server API) + redeem + admin — små serverless functions räcker
- (valfritt) daglig batch för väder-påslagna hotspots

All karttrafik kan alltså bli ren statisk hosting.
