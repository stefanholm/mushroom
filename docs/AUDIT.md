# AUDIT — backend + habitat-scoring + live-beredskap över hela Sverige

Datum: 2026-11-22. Scope: hela Node-backenden (`src/server.ts`, `src/layers.ts`, `src/habitat.ts`,
`src/redeem.ts`) plus den live-kritiska frågan: **fungerar allt över hela Sverige vid launch?**

Commit-referenser pekar på branchen `vibe/mistral-chat-df5813` (PR #1, draft).

---

## 1. Backend-audit: hittade fel → fixade

| # | Fel | Fix | Commit |
|---|-----|-----|--------|
| 1 | Referral-ägare kunde inte lösa in intjänad claim — bara `redeemedBy` räknades, inte `earnedBy` | Båda räknas nu (`27f3643`-fixen i `/api/reward/claim`) | `27f3643` |
| 2 | `computeCellsCache` evictade bara fulfilled promises — en rejectad promise (t.ex. SMHI nere) låg kvar och saboterade LRU:n | Rejectade promises evictas också | `27f3643` |
| 3 | `/api/chat` och `/api/debug/cells` saknade rate limit — öppna för abuse/DoS | 20/10 min resp. 10/10 min per IP | `27f3643` |
| 4 | `rebuildHabitat` i webben kraschade med "Source hab-kantarell already exists" (dold som "Servern svarar inte") | Source-id fix (`hab-`-prefix) + 61 placeholder-ikoner så 404:orna försvann | `e1e1552` |
| 5 | `validate-auc.mjs` gjorde ett anrop per punkt (10+ min) | Batch `POST /api/debug/cells` (≤20k punkter, 400/chunk, ents=all) — nu ~1–3 min, 0.09 ms/punkt, identiska scores | `7783b30` |
| 6 | Upprepade computeCells-anrop tog 401 ms (SMHI + lager varje gång) | In-memory LRU (64 poster, 10 min, in-flight-dedup) + Cache-Control per endpoint (tiles 86400, hillshade immutable, meta/hotspots 60 s, shop 300 s, debug no-cache) — 73 ms vid repeat | `140a5ad` |
| 7 | `/api/hotspots` default `minScore=80` gjorde att dynamiska scores (säsong×väder ≤ 100×habitat) aldrig nådde tröskeln → "inga svampar visas" | Default 80 → 50 | `049ac28` |
| 8 | **Hela-Sverige-mask (>128M px) byggdes inte alls → fail-closed → TOM KARTA live** | MaskLayer läser nu i remsor och block-nedprovar till ≤120M celler (block = ceil(√(w·h/120M))), block-aware dilate av vatten/hyggen, block-aware `has()`/`allows()`; varning "NMD-mask nedprovad …" | denna commit |
| 9 | **Fönsterläsning i nya mask-koden använde `[x,y,w,h]` men geotiff vill ha hörn `[x0,y0,x1,y1]`** → bara första remsan lästes, resten tom | `[0, y0, w, y0+rows]`; verifierat med syntetisk 12000×12000-mask (9/9 tester: skog OK, vattenbuffert spärrar, hygge spärrar, utanför raster nej) | denna commit |
| 10 | Stora rasters (>128M px, t.ex. hela Sverige 10 m ≈ 12.4 G px) laddades tyst inte → sampleSync null → faktorer föll till neutral utan förklaring; DEM-gaten gav hårt 0 på null | `RasterLayer.tooBig` + högljutt `console.warn` vid laddning; `layersTooBig: [...]` i `/api/meta`, `/api/debug/cell` och computeCells-meta; DEM-gaten returnerar 0 på null bara när DEM är cacheat (nodata/utanför), annars hoppar över höjd-gaten (→ `!covered` ger 0.4-fallback) | denna commit |
| 11 | `minTempLast48h` använde alltid väggklockan (`Date.now()-48h`) även när användaren valt `?date=` — frostfaktorn blev fel för historiska datum (och fel i AUC-validering) | asOf-medveten: cache-nyckel + fönster `[asOf-48h, asOf]`; live (ingen date) är beteendet identiskt; verifierat: idag −0.1 °C vs 2026-09-15 → 3.2 °C | denna commit |

### Verifierat OK (ingen åtgärd behövs)

- **Tile-diskcache-nycklar** inkluderar species/static/date/sens/z/x/y och multi-tile-nycklar byggs efter entitlement-gating → inget ents-läckage mellan användare.
- **Redeem/referral-spar** är atomiska (tmp+rename) och synkront read-modify-write utan `await` emellan → ingen tävlan.
- **SMHI**: närmaste aktiva station Sverige-weit (cos-lat-korrigerad), 24 h stationscache, 6 h vädercache per 0.1°-ruta, 5-punkts-sampling vid utzoomade bboxes (>0.15°), parallell fetch.
- **bbox-cap** 4° på `/api/hotspots`, `/api/peaks`, `/api/debug/cells`; tile-z begränsad till 3–17.
- **debug/cells** cap 20k punkter/anrop + 403-gating + rate limit.
- **Redeem**: format `SVAMP-XXXX-XXXX-XXXX-C` med checksum, entydig alfabet, per-device idempotens, expiry/revoke, 404/409/410/429, rate limit 20/10 min, JSONL-logg; admin-API:n kräver `ADMIN_PIN` (rate limit 10/10 min).
- **Reward/referral server-side**: `reward:<id>` valideras mot `REVIEW_REWARD_SPECIES` (pool, max 1 recension + 2 referrals = 3 gratis-arter); topparter/exklusiva arter (`TOP_PICKS`, `SOLO_ONLY_SPECIES`) kastas fail-fast vid boot om de hamnar i poolen. Referral kräver faktiskt inlöst kod (egna eller inbjudnas).
- **Top-spots 3-state**: trial (`?trial=1`/ent `trial`) = alla pins, inget guld; free efter trial = ser ~70 % (topp `FREE_HIDE_FRACTION=0.30` döljs, rankat efter score); betalat årskort (`topspots:<år>`) = alla pins + topp-30 % `gold:true`. Verifierat på riktig data: free n=84/goldPeaks=36, trial n=120/gold=0, paid n=120/gold=36.

---

## 2. habitat.ts — deep review av scoringen

Flöde per cell: **hårda grindar → faktorer → S_env → bonusar → slutprodukt**.

### 2.1 Hårda grindar (i ordning)

1. `inClearcut || excluded` → 0 (avverkningar GeoJSON / exkl-polygoner).
2. `!forestOk` → 0 (mask-veto eller OSM-skog-polygon; utanför Sverige/raster → `has()` false → 0, dvs inga pins utanför datatäckning).
3. DEM: `elev < 0.5 m` → 0 (vatten/översvämmat); null+nodata → 0 **bara om DEM är cacheat**; null pga för stort raster → hoppa över (nytt).
4. Mask-veto → 0.
5. Host-gate: `hostVol < minHostEff` → 0, där `minHostEff = minHostVolume × (1 − 0.6·plast)` (generalister kräver mindre värd). `hostGate = 0.1 + 0.9·clamp01(hostVol / (3·minHostEff))` — mjuk övergång ovanför tröskeln. woodHost (vedarter) har ingen volym-tröskel (hostGate=1, täckning via död ved-faktor).
6. Trädhöjd: `v < minTreeEff·relax` → 0, `relax = 0.5` om ålder ≥ 80 år (gamla lågvuxna bestånd, t.ex. hällmark — jättemusseron). Annars `minTreeEff = minTreeHeight × (1 − 0.5·plast)`.
7. **GDD-kuvert (klimat-zon)**: `gddEff` från SMHI gdd5-raster, annars latitud-fallback `2200 − (lat−55)·130 − höjd·0.9`. Kuvertet breddas med `plast×150` GDD; hård 0 utanför hårt kuvert (`fClimate ≤ 0 → return 0`). Detta är "zonen" per art — sydliga arter dör i norr, nordliga i söder, fjällarter dör på lågland (och vice versa via höjd-lapse 0.9 GDD/m).
8. `vetoMoisture` / `vetoSoil` → 0 (art-specifika dödszoner, t.ex. vissa arter tål inte torra marker).
9. Specialist-veto: `plast ≤ 0.3 && (fSoil < 0.2 || fDepth < 0.2)` → 0 (deep-dive-fix, `2b10b26`).

### 2.2 Faktorer → S_env

14 faktorer med vikter som summerar till 1.0: moisture .15, age .15, canopy .09, soil .10,
SIS .07, climate .07, depth .07, terrain .07 (0.7 terräng+0.3 lutning), TWI .04 (hårt tak 18),
waterHollow .03, standStruct .05, waterDist .03 (mjukt avstånd, clamp dist/2500 m, hård 50 m-spärr i masken),
deadwood .05 (endast woodHost). Hydrologisk dubbelräkning borttagen (var .32, nu .25 — deep-dive).

Kurvform per plasticity: `sharp = 1.8 − 1.6·plast`, `floor = 0.02 + 0.28·plast`,
`soft(x) = max(floor, x)`, `S_env = 100·Π soft(f)^(vikt·sharp)`.
Specialister (låg plast) blir nästan binära; generalister förlåtande. Fixad inverterad softFloor (`2b10b26`).

### 2.3 Bonusar & slutprodukt

`M_bonus`: nyckelbiotop ×1.3, sumpskog ×1.15, skogskant ×(1 + 0.15·edge).
`if (!covered) return 0.4` — cell utanför rastertäckning men godkänd av mask/OSM får neutral 0.4.
Slutligen: `hostGate × (S_env/100) × M_bonus × roadFactor` (roadFactor: 0 inom ROAD_ZERO_M, 0.5 inom ROAD_HALF_M, annars 1).

### 2.4 Dynamisk del (server.ts)

`score = min(100, round(100 × habitat × D × (1 + 0.15·prior)))`, `prior = 0` för protected arter,
annars gaussisk närhetsprior från Artportalen-observationer (σ=400 m, cutoff 1200 m, max +15 %).

`D = seasonFactor(lat-skiftad) × rainFactor × frost × flush`:
- **Säsong**: `shift = clamp((59−lat)·0.1, −1, +1)` månader — syd (lat 55) får säsong ~0.4 mån tidigare,
  nord (lat 69) ~1 mån senare; vinter-wrap (t.ex. okt–mar) hanteras med halvmånads-ramper i båda ändar.
  Verifierat: frostvaxing (säsong 9–12) ger seasonFactor 1 den 22 nov; kantarell ger 0 i november (korrekt — säsongen är över).
- **Regn**: `rainFactor = (1−e^(−rain14/32)) × (0.75 + 0.25·(1−e^(−rain90/120)))` — mättande kurvor
  (deep-dive, var linjära). SMHI nederbörd senaste 14/90 d vid närmaste aktiva station; null (ingen data) → 0.5 resp. 1.0 (neutralt).
- **Frost**: `frostSensitive && minTemp48h ≤ −3 °C` → frost = 0. **Nu asOf-korrekt** (se punkt 11 ovan).
- **Flush**: kalla nätter (≤10 °C) senaste 7 d → `flush = 1 + 0.25·min(1, n/4)`.
- `static=1` → D = 1 (rena habitat-tiles; väder=0 annars kan ge "tomma" dynamiska kartor mitt i november — därför iOS alltid skickar `static=1` för tiles och `minScore` sänkt).

### 2.5 Bedömning

Ordningen på grindarna är sund (billiga/definitiva först). GDD-kuvertet + latitud-fallback täcker hela
Sverige även utan gdd5-raster. `!covered → 0.4` är en medveten mjuk fallback. Inga logiska fel hittades
i själva matten vid denna genomgång; de fem deep-dive-fixarna (`2b10b26`) är kvar och testade.
Kvarstående kända förenklingar (accepterade): väder samplas vid bbox-centrum (5 punkter vid stora bboxes),
säsong per cell använder cellens latitud; obsPrior är dev-trustad (i prod ska den vara server-side — den är det, men entitlements är det inte, se §3).

---

## 3. Live över hela Sverige — checklista vid launch

| # | Punkt | Status |
|---|-------|--------|
| 1 | **CRS**: alla rasters EPSG:3006 (SWEREF99 TM); lon/lat konverteras via `toSWEREF` (proj4) i varje sampling. Vektorer (avverkningar, nyckelbiotoper, sumpskogar) också EPSG:3006 | ✅ kod; kontrollera att nedladdade filer faktiskt är 3006 |
| 2 | **Mask (NMD)**: >128M px (hel Sverige 10 m ≈ 12.4 G px) → läses i remsor + block-nedprovas automatiskt (~20–40 m/cell beroende på storlek), vattenbuffert 50 m och hygges-dilate skalas med blockstorleken. Verifierat på syntetisk 144M-px-mask (9/9 tester). Små masker (<128M) tar normal väg (block=1) | ✅ denna commit, testad |
| 3 | **Scoring-rasters**: >128M px/layer cache:as INTE — sampleSync ger null → faktorer blir neutrala (1.0 / default), DEM-höjdgaten hoppas över, och servern loggar högljutt + exponerar `layersTooBig` i `/api/meta` och `/api/debug/cell`. **Rekommendation inför launch**: kör `gdalwarp -tr 50 50 -overwrite` (eller klipp regioner) på alla scoring-rasters; DEM (2 m Sverige ≈ 300 G px) måste ned till 10–25 m. Hillshade-tiles använder `readWindow` (streaming) och fungerar även på stora DEM, bara långsammare första gången | ⚠️ åtgärd krävs på riktiga filer; skydd + synlighet nu på plats |
| 4 | **SMHI väder**: `latest-months` täcker bara senaste ~3 månaderna. `?date=` är max 120 d bakåt (äldre → `parseAsOf` faller tillbaka till idag). För datum utanför datatäckningen blir regn/frost/flush neutrala (0.5/1.0/1) — medvetet. Live (idag) finns alltid data. Staionslistan cachas 24 h, väder 6 h per 0.1°-ruta | ✅ |
| 5 | **Temperatur/säsong/zon**: säsongsfönster per art med latitud-skift ±1 mån (klampat), vinter-wrap för vinterarter; GDD5-kuvert per art (plast breddar ×150) med latitud+höjd-fallback `2200 − (lat−55)·130 − höjd·0.9` — täcker hela Sverige från Malmö (≈2200 GDD) till Treriksröset (≤0 på fjälltoppar → hård 0, korrekt) | ✅ |
| 6 | **Frost**: senaste 48 h:s min-temp vid asOf (fixad denna commit — tidigare alltid "nu"); ≤ −3 °C dödar frostSensitive arter | ✅ |
| 7 | **Bbox/tile-gränser**: hotspots/peaks/debug-cells vägrar bbox > 4°; tiles z 3–17; computeCells cellstorlek auto-skalas så ≤110 celler per anrop + LRU-cache | ✅ |
| 8 | **Entitlements i prod**: dev litar på klientens `?ents=` — i App Store-versionen måste kvitton valideras server-side via App Store Server API (StoreKit 2) innan `ents` sätts. Tills dess kan vem som helst skicka `ents=all` | ⚠️ öppet — nästa iOS-steg |
| 9 | **Top-spots compliance**: free efter trial ser ärligt bara ~70 % av pins (ingen tyst degradering — `meta.capped`, `goldPeaks`, `passId/passLabel/passPriceSek` skickas med, och App Store-listan måste avslöja detta). Trial är StoreKits `is_trial_period` i prod | ⚠️ iOS/App Store-text kvar |
| 10 | **Rate limits**: chat 20/10 min, debug/cells 10/10 min, redeem 20/10 min, admin 10/10 min per IP | ✅ `27f3643` |
| 11 | **Persistens**: redeem-koder, logg, referrals sparas atomiskt (tmp+rename) i `data/` (git-ignored, aldrig iCloud) | ✅ |
| 12 | **iOS-klient**: alltid skicka `ents=` (även tom), `static=1` på tiles, `minScore=70`, timeouts 15 s/25 s på fastSession; rendera `pin.gold` som guldglöd, visa capped-banner från `meta.capped/goldPeaks/passId` | ⚠️ patchar ges separat (Xcode-projektet ligger utanför repot) |

---

## 4. Öppna frågor / rekommendationer

1. **Warp av riktiga rasters innan launch** (se §3.3): hela Sverige vid 10 m ryms inte i minnet per lager;
   50–100 m räcker för habitat-scoring (pins är ändå på 100 m–km-skala). Mask klarar sig själv nu.
2. `npm run validate` (AUC) på riktig Mac-data är nu snabb via batch-endpointen — kör den och skicka
   rapporten till Gemini tillsammans med `docs/MODEL-DEEP-DIVE.md`.
3. `dodved_10m.tif` saknas på Macen (valfritt lager, faktorn blir då neutral 1.0 för vedarter) — ladda ner eller ta bort ur manifestet.
4. Städa `*.bak*` i Xcode-mappen när allt är verifierat.
5. PR #1 är fortfarande draft — slå ihop när iOS är synkad.
