# CLOUDFLARE-DEPLOY — målbild för produktion (R2 + Workers + D1)

Datum: 2026-11-22. Beslut efter mätning: bakade tiles snitt **9,4 KB/tile** (kantarell z9–z11).
Hela Sverige z5–z10 alla 61 arter ≈ 250k–277k tiles ≈ **1,4–2,6 GB**; z5–z11 ≈ **5,5 GB**.
Ryms i **R2 gratisnivå (10 GB, 10M Class A-ops/mån, 0 kr egress)**. Hillshade z5–z13 ≈ 279k tiles ≈ ~2 GB.

## 1. Målbild (vem gör vad)

```
Mac/CI (batch, har GeoTIFF:erna)
   │  npm run bake-tiles / cron-hotspots  →  artefakter
   ▼
Cloudflare R2  (statisk hosting, 0 kr egress, immutable cache)
   ├── tiles/<species>/<z>/<x>_<y>.png        (habitat, static=1)
   ├── tiles/hillshade/<z>/<x>_<y>.png
   └── hotspots/<species>/<region>.json       (statiska peaks + factorbrytning, per 1°-ruta)
   ▲
Cloudflare Workers (+ KV cache + D1)
   ├── GET /tiles/*            → R2 (direkt, ingen Worker behövs — custom domain på bucket)
   ├── GET /api/hotspots       → läser R2-JSON, applicerar LIVE väder/säsong (SMHI direkt från Worker, KV-cache 6 h),
   │                             minScore, top-spots-gating per enhet (D1), svar KV-cachat 60 s
   ├── GET /api/shop           → statiskt + ägda flaggor från D1 (kvitto-validerade ents)
   ├── POST /api/redeem, /api/reward/claim, /api/referral/*, /api/single/claim → D1
   ├── POST /api/verify-receipt → App Store Server API (JWS ES256, .p8 som Worker-secret) → D1
   └── webhook App Store Server Notifications v2 → D1 (förnyelser, återbetalningar)
iOS-appen
   ├── tiles direkt från R2-URL (ingen ändring utom base-URL)
   ├── chatt: 100 % on-device (Apple Intelligence) — ingen Mistral-nyckel i prod (docs/CHAT-ONDEVICE.md)
   └── köp: StoreKit 2, kvitto → /api/verify-receipt
```

Node-servern (`~/Projects/mushroom`) blir kvar som **batch/origin-maskin** (bakar artefakter,
kör `npm run validate`, dev-webb) — ingen publik trafik där längre.

## 2. PMTiles vs lösa filer — välj lösa filer

- MapLibre raster-tiles vill ha z/x/y-URL:er → **lösa PNG på R2 + CDN är enklare och cache-vänligare**.
- PMTiles är ett containerformat (range requests) — mest för **vektor**-tiles. Om vi senare går över
  till vektor (t.ex. värmekonturer), då PMTiles. För raster-PNG: behövs inte.
- Cache: sätt `Cache-Control: public, max-age=31536000, immutable` på tiles (innehållet ändras aldrig;
  byt `TILE_VERSION` r15 → r16 i `src/server.ts` vid modelländring och baka om under nytt prefix).

## 3. `/api/hotspots` utan live-GeoTIFF (Workers)

Workers kan inte läsa stora GeoTIFF live. Lösning: **statiska peaks för-bakade + live väder i Worker**.

1. Batch på Macen skriver per art + 1°-ruta (`hotspots/<art>/<lon>x<lat>.json`): topp ~500 celler
   med `habitat`-score + liten factorbrytning (fMoisture/fSoil/gddEff/…) för "varför här"-vyn.
   ~40 KB/fil — hela Sverige × 61 arter ≈ ~1–2 GB R2 om allt bakas, men bara synliga arter behövs.
2. Worker vid anrop: läser JSON för synliga rutor, applicerar `score = min(100, round(100 × habitat × D × (1+0.15·prior)))`
   där `D = season(lat) × rain × frost × flush` beräknas live: SMHI hämtas direkt från Worker
   (`opendata-download-metobs.smhi.se`, CORS `*`, ingen nyckel), KV-cachat 6 h per 0.1°-ruta.
3. Top-spots-gating: enhetens ents slås upp i D1 (från validerat kvitto), `FREE_HIDE_FRACTION`
   döljer topp-30 % för free efter trial, guld på topp-30 % för årskort. **KV-cache-nyckel måste
   innehålla ents-KLASS (free/trial/paid), aldrig individuella ents.**
4. `/api/inspect` (debug/cell): **endast dev på Macen**. I prod: "varför här" från den lagrade
   factorbrytningen i hotspots-JSON:en.

## 4. D1-schema (förslag)

- `devices(device_id TEXT PK, created_at, ents TEXT)` — ents från senaste validerade kvittot
- `transactions(tx_id PK, device_id, product_id, purchased_at, expires_at, raw_jwt)`
- `redeem_codes(code PK, grant, uses, used_by TEXT, expires, revoked, note)` + `redeem_log`
- `referrals(code PK, owner_device, redeemed_by TEXT, created_at)` + `reward_claims(device_id, species, type, at)`
- `admin_pin` sätts som Worker-secret, inte i D1.

## 5. StoreKit 2-mappning (15 produkter)

| Produkt-ID (App Store Connect) | Pris | Server-mappning |
|---|---|---|
| 13 paket (`blandad-korg-1..8`, 3 regionala, `goliatmusseron-solo`, `all`) | 29–149 kr | ent = pack-id (`all` ger alla arter men **inte** årskortets guld — jmf beslut 0069fa0) |
| `topspots.2026` | 99 kr | ent `topspots:2026` (årskort, guld-toppar) |
| `single.species` (consumable) | 10 kr | appen skickar vald art till `/api/single/claim` + kvitto; server ger `species:<id>` (403 för solo-only jattemusseron) |

- **Kvittovalidering i prod:** App Store Server API — ES256 JWT signerat med `.p8`-nyckeln (secret i Worker),
  verifiera `transactionId`, spara i D1, sätt ents där. **Lita aldrig på klientens `?ents=` i prod** (just nu dev-läge).
- **App Store Server Notifications v2**-webhook till Worker vid förnyelse/återbetalning.
- **Återställ köp** måste finnas (App Review kollar): StoreKit 2 `AppStore.sync()` + läs `currentEntitlements`.
- **Trial:** använd StoreKit intro-offer; servern kollar `is_trial_period` i kvittot → trial-state (alla pins, inget guld).

## 6. Kostnad (gratisnivåer räcker länge)

- R2: 10 GB, 10M Class A/mån, 100M Class B/mån, **0 kr egress**. Bakning = ~250k–1M PUTs — håll dig
  under 10M/mån (baka inte om allt varje dag; baka om vid modelländring/ny säsong).
- Workers gratis: 100k req/dag, 10 ms CPU — räcker för API:t; gå till Betald ($5/mån) om kvittoverifiering
  (JWT) eller stora hotspots-svar behöver mer CPU.
- D1 gratis: 5 GB, miljontals rader — mer än tillräckligt.
- Rate limiting: enkel KV-räknare per IP (eller Cloudflare Rate Limiting på betald plan).

## 7. App Store-checklista (viktigt — innan du skickar in)

1. **Recensionsbelöning = risk för avslag** (incitament för App Store-recensioner är förbjudet).
   Använd `SKStoreReviewController` **utan belöning**; behåll referral-belöningen (2 koder → 2 arter,
   det är inte en App Store-recension). Överväg att ta bort review-claim helt i prod-v1.
2. **HTTPS:** Workers ger gratis HTTPS → ta bort `NSAllowsArbitraryLoads` i release-build;
   behåll bara `NSAllowsLocalNetworking` för dev mot Macen.
3. **Privacy Policy + GDPR:** device-id + referrals = personuppgifter. Publicera policy,
   erbjud radering (admin-endpoint som tar bort enhetsdata), och aldrig koordinater för fridlysta arter i publika API:er.
4. **Licenser:** verifiera villkor för NMD (Lantmäteriet), SMHI (öppna data), SGU jordart/jorddjup,
   Skogsstyrelsen (SLU skogskarta), Artportalen/GBIF — lägg attribution i appens Om-sida vid behov.
5. **App Review:** sätt standardkarta över Sverige (t.ex. Stockholm) så pins syns utan platstillstånd;
   hantera "plats nekas" snyggt. Demo-konto behövs om login krävs (ni har inget — bra).
6. **Top-spots-modellen (dölj 30 % efter trial):** tillåten om tydligt avslöjad — det gör ni via
   `meta.capped/goldPeaks/passLabel/passPriceSek` + banner + App Store-listning. Behåll avslöjandet.
7. Ålder 4+ är rimligt. Testflight-build med .storekit-filen kopplad i schemat (som du gjort).
8. Töm debug-endpoints (`/api/debug/*`) eller PIN-skydda dem i prod — de är öppna nu.

## 8. Bake-pipeline

- `npm run bake-tiles -- --all-species --bbox 10.9,55.3,24.2,69.1 --zmin 5 --zmax 10` på Macen (overnight, parallellisera),
  sedan `rclone sync data/tile-cache/r15/ r2://svampradar-tiles/` (eller `wrangler r2 object put --bulk`).
- z11+ serveras on-demand från en tunn origin (eller bakas för top-10 arter).
- Cron kl 06:00: baka om `hotspots/<art>/<region>.json` (väder ändras dagligen).
