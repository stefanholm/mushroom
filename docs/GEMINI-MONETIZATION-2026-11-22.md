# Till Gemini — monetisering & produktläge 2026-11-22 (fråga: är 70/30 rätt?)

## Vad som är byggt och pushat (branch vibe/mistral-chat-df5813, PR #1 draft)

1. **Modell-fixar (deep-dive):** specialist-veto, inverterat softFloor, S_env-ombalansering,
   mättande regnkurvor, obsPrior takad (+15 %, σ 400 m, protected=0) — `2b10b26`.
2. **Perf:** minScore default 50 på hotspots/peaks (`049ac28`), computeCells LRU +
   Cache-Control på API:er (`140a5ad`), batch `POST /api/debug/cells` för validate
   (0.09 ms/punkt, ~200× snabbare — `npm run validate` gick från 10+ min till ~1–3 min, `7783b30`).
3. **Free tier:** 6 arter; Gemini bytte `smorsopp` → `frostvaxing` (säsong 9–12) så november
   inte är tomt + 5-punkts regnsampling (`4db3605`).
4. **Packs/singles:** 11×5-pack + solo (goliatmusseron 79 kr) + all 149 kr; Pro ej till salu;
   singles 10 kr; top-5 utan kantarell; reward-pool: 1 recension + 2 referrals = max 3 arter
   (server-side per device, persistenta i `data/referrals.json` — `5cc2776`).
5. **Inlösenkoder (redeem codes):** format `SVAMP-XXXX-XXXX-XXXX-C` (checksum), grant =
   `all` | `pro` | `<packId>` | `species:<id>` | `topspots:<år>` | csv av flera.
   Admin **i appen** (Inställningar → 🛠 Admin, PIN = `ADMIN_PIN` i .env): välj 🍄 1 art /
   📦 1–3 pack / 🌍 alla, uses, expires, note; lista + återkalla; referral-statistik + logg.
   API: `POST /api/admin/redeem`, `/api/admin/redeem/revoke`, `GET /api/admin/overview`;
   användare: `POST /api/redeem {code, device}` i Affären (🎁-kort). CLI kvar:
   `npm run redeem -- ...`. Koder i `data/redeem-codes.json` (git-ignored), logg i
   `data/redeem-log.json` (`2082d7e`, `5cc2776`).
6. **Top-spots / årskort (`topspots:<år>`, 99 kr, `TOP_SPOTS_PRICE_SEK`):** tre lägen på
   `/api/hotspots` + `/api/peaks` — **provperiod** (`?trial=1`, i prod från StoreKit
   `is_trial_period`): alla pins, inget guld; **free efter trial**: topp-`FREE_HIDE_FRACTION`
   (default **0.30**, rankat efter score) försvinner (`meta.capped=true`, `goldPeaks`=antal);
   **betalat årskort**: alla pins tillbaka + topp-fraktionen får `gold:true` (glöder guld —
   bara betalande ser). Uppmätt på riktig data: free n=84, paid n=120, gold=36 → free ser
   exakt 70 %. Packköp låser arter oberoende av årskortet. (`4c9366a`, `9da0c3d`, `701a84a`,
   `27bd079`, `eb34e47`)
7. **UI-fixar:** `rebuildHabitat` source-id-bugg, 61 platshållar-ikoner `npm run icons`
   (`e1e1552`), redeem-kort i Affären.

## Fråga till Gemini: är 70/30 rätt?

- Free ser ~70 % av pinsen per vy men **alltid utan de hetaste 30 %**; betalande får alla
  + topp-30 % i guld. Min bedömning: **0.30 är en bra default** — free får fortfarande
  mycket värde (84/120 pins), och de gömda 30 % är tydligt "de bästa". Men vi bör A/B-testa
  **0.20 / 0.30 / 0.40** mot köpkonvertering till årskortet. Vad tror du?
- Ska free efter trial se *antalet* gömda ställen (`meta.goldPeaks`) eller ett vagare
  "vissa ställen är låsta"? (Just nu: exakt antal — funkar som teaser.)
- Ska guld-pins för betalande visa exakt score, eller bara "het"/"hetast"-nivåer?
- Är **99 kr engångsköp för årskort 2026** rätt pris för Sverige, eller hellre månadsvis
  29 kr aug–okt, eller prenumeration med 7 dagars trial (auto-renew)? Notera: användaren
  ville inte sälja Pro "pga kort säsong" — årskort löser det genom att gälla hela året.
- Compliance: provperiod måste deklareras tydligt i App Store-beskrivningen (vi capp:ar
  först efter trial, aldrig tyst). Är modellen "trial → cappa" OK enligt App Store 3.1 /
  EU Omnibus så länge det är deklarerat? Förslag på formulering i beskrivningen?
- Interaktionen pack ↔ årskort: idag låser pack *arter* och årskort *topp-ställen inom
  upplåsta arter*. Ska årskortet även ingå i "all"? (Just nu: `all` ser guld också.)

## Övrigt att granska

- `npm run validate` på riktiga lager (nu snabb via batch-endpointen) — AUC före/efter
  deep-dive-fixarna; är 0.558-baslinen rimlig?
- iOS-klient: skicka alltid `ents=`, `static=1`, `trial=1` under provperiod, läs
  `meta.capped/goldPeaks/topSpots` för guld + upsell; debounca hotspots 300 ms.
- Nästa: StoreKit 2-koppling (produkter: 11 pack + solo + singles + årskort `topspots:2026`),
  App Store Server API-verifiering av kvitton (då blir ents server-side, inte klient-påstådda).
