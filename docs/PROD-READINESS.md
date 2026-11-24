# PROD-READINESS — säkerhet, drift på Cloudflare, Apple-godkännande

Datum: 2026-11-23. Kompletterar `docs/CLOUDFLARE-DEPLOY.md` (arkitektur) och
`docs/SIGNALS-LEADERBOARD.md` (signals/topplista).

## 1. Säkerhet & robusthet i backend ( göra nu / innan launch)

Redan gjort i denna commit (`a712407+`): `express.json` strypt till 256 kb, säkerhetsheaders
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP `default-src 'self'`),
`/api/debug/*` avstängda i prod (`DEBUG_API=1` krävs lokalt; `validate-auc.mjs` sätter det själv).

- [ ] **Lita aldrig på klient-`ents` i prod** — validera kvitton via App Store Server API
      (ES256 JWT, `.p8` som Worker-secret), sätt ents i D1. Dev-läget (`?ents=`) bara lokalt.
- [ ] **Rate limits per enhet** (inte bara IP — bakom Cloudflare är alla IP:n CF-edge): KV-räknare
      på `device-id`, t.ex. report-signal 30/10 min, chat 20/10 min, redeem 20/10 min.
- [ ] **Anti-fusk förstärkning:** Apple DeviceCheck-token på `/api/report-signal` i prod
      (verifiera server-side) — stoppar hashade device-ID:n. Befintligt: restid, natt, dygnstak.
- [ ] **CORS:** explicit allowlist (appens domän) i stället för öppet; iOS behöver ingen CORS.
- [ ] **Webhook-signatur:** App Store Server Notifications v2 — verifiera JWS-kedjan mot Apples rot-CA.
- [ ] **Idempotenta köp:** `transaction_id` UNIQUE i D1 → replay-säkert.
- [ ] **Timeouts på alla utgående anrop** (`AbortSignal.timeout`, SMHI redan 8–15 s) + fallback till
      neutrala faktorer vid fel (redan i computeCells).
- [ ] **SQL:** bara prepared statements (node:sqlite/D1 gör detta) — redan så i `signals.ts`.
- [ ] **Hemligheter:** endast som Worker-secrets / lokalt `.env` (git-ignored). Rotera `ADMIN_PIN`.
- [ ] **Logga aldrig GPS/device-id i klartext i prod**; `report-signal` lagrar bara 0.05°-celler.
- [ ] **GDPR:** pseudonymt device-id, publiserad privacy policy, `/api/privacy/delete?device=`
      (raderar enhetens signals/referrals/reward/ents), D1 med EU-jurisdiction om möjligt.
- [ ] **Backup:** D1 point-in-time recovery; R2 versioning på tile-bucketen; alla JSON-lager
      (redeem/referrals) portar till D1 — Workers har ingen lokal disk.
- [ ] **Observability:** 5xx-rate + p95-latens (Workers Analytics / Logpush), Sentry i iOS-appen,
      larm vid SMHI nere > 30 min.
- [ ] **Graceful degradation:** saknas en region-JSON i R2 → tom lista, aldrig 500;
      `layersTooBig`/saknade lager loggas tydligt vid batch.

## 2. Cloudflare-port — checklista så ALLA funktioner funkar i molnet

| Funktion | Nu (Node) | I molnet |
|---|---|---|
| tiles/hillshade | disk-cache + render | **R2 direkt** (custom domain, immutable) |
| hotspots/pins | computeCells live | **för-bakad JSON per art/region i R2** + Worker applicerar väder/säsong live (SMHI direkt från Worker, KV-cache 6 h) |
| meta/artlista | beräknas | statisk JSON (build-time) + väder vid punkt |
| shop | beräknas | statiskt + `owned` från D1 |
| redeem/referral/reward | JSON-filer | **D1** (samma logik) |
| report-signal/leaderboard/nearbyActivity | SQLite `data/signals.db` | **D1** (samma SQL i `src/signals.ts`) |
| kvittovalidering | saknas (dev) | Worker → App Store Server API + ANS v2-webhook |
| chatt | `/api/chat` Mistral | iOS: on-device (klart); webb: Worker → Mistral (secret), rate limit per device |
| debug | `DEBUG_API=1` | finns inte alls i prod |
| batch (bake tiles/hotspots, validate) | Mac/CI med rasters | Mac/CI → skriver R2 (Workers kan inte läsa GeoTIFF); cron via Mac eller liten VPS |

Kritisk cache-regel: KV/R2-cache-nycklar får bara innehålla ents-**klass** (free/trial/annual), aldrig individuella ents.

## 3. Apple-godkännande — checklista

- [ ] **Ta bort recensions-belöningen** (incitament för App Store-recension = avslag). Använd
      `SKStoreReviewController` utan belöning; behåll referral-belöning (2 koder → 2 arter).
- [ ] **Tydlig avslöjning av top-spots-modellen** (free efter trial ser ~70 %): banner i appen
      (klart) + samma text i App Store-beskrivningen.
- [ ] **Privacy Nutrition Label:** "precise location" (används för hotspots, skickas inte vidare),
      device-id pseudonymt (ej kopplad till identitet), ingen tracking. Privacy policy-URL i ASC.
- [ ] **Återställ köp**-knapp (StoreKit 2 `AppStore.sync()`).
- [ ] **HTTPS överallt i prod** (Workers) → ta bort `NSAllowsArbitraryLoads` i release; behåll
      `NSAllowsLocalNetworking` endast i dev-builds (eller ta bort helt).
- [ ] **Tydlig ansvarsfriskrivning:** "ät aldrig svamp enbart efter appen — dubbelkolla alltid med
      fälthandbok/auktoriserad svampkontroll" i appen och i listningen (säkerhet + granskning).
- [ ] **Fridlysta arter:** ingen exakt plats i publika API:er (obsPrior=0 redan), markera
      FRIDLYST i appen (goliatmusseron-paketet gör det).
- [ ] **Platstillstånd:** tydlig svensk `NSLocationWhenInUseUsageDescription`; fungera utan
      (fallback: karta över Sverige, t.ex. Stockholm) — App Review testar utan behörighet ibland.
- [ ] **Inga döda knappar i Review:** alla flöden (köp via sandbox, redeem, reward) måste gå att
      testa; skriv det i review-notes. StoreKit produkter skapade i App Store Connect med samma ID:n.
- [ ] **Lokalisering:** svenska (och ev. engelska) texter + screenshots i rätt storlekar.
- [ ] **Tillgänglighet:** VoiceOver-etiketter på pins/knappar, Dynamic Type.
- [ ] **Kraschfrihet:** Sentry, inga force-unwraps; testa offline-läge (cachade tiles).
- [ ] **Åldersgräns 4+** är rimligt; ingen UGK publik.
- [ ] **2.1 komplett app:** riktig native-app, inte webview — redan OK (MapLibre native).
