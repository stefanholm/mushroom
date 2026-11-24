# Svamppack & betalning i "steho" (Gemini-signerad struktur, implementerad i kod)

Status: **implementerat** i `src/habitat.ts` (`PACK_DEFS`/`PACKS`), exponerat via
`/api/meta` (`packs`, `speciesList[].pack/locked`) och 403-gating på tiles/hotspots/debug.
Paketen ligger i KOD — inte i `data/species/artfakta.json` (den är git-ignored data).

## Gratisnivå (6 arter — förtroendebyggare)

`jatteroksvamp`, `blek-taggsvamp`, `brunsopp`, `sandsopp`, `frostvaxing`, `stolt-fjallskivling`

(v1.0: `kantarell` flyttades till `blandad-korg-8`; `jatteroksvamp` är gratis i stället.)

## Svenska Klassiker i Årskort Pro (249 kr/år)

`SVENSKA_KLASSIKER_SPECIES = ["trattkantarell", "karljohan", "svart-trumpetsvamp", "mandelkremla"]`
— aktiva ENDAST medan årskort/pro är aktivt (i prod: ents från App Store Server API, så de låses
automatiskt när prenumerationen avslutas). Exponeras som `svenskaKlassiker` + `svenskaKlassikerActive`
i `/api/shop` och `/api/unlocked`.

Alltid gratis även utanför artlistan: säkerhetsinfo (förväxlingsvarningar, FRIDLYST,
säkerhetschecklista i chatt), Stigar, Terrängskugga, Spara PNG, Hitta bilen, tryck-inspektion.

## Blandade 5-pack (#1–#8 — tvärblandade grupper/miljöer, 0 överlapp)

| Pack | Namn | Pris | Arter |
| --- | --- | --- | --- |
| blandad-korg-1 | Skog & sensommar | 129 kr | trattkantarell, karljohan, mandelkremla, ostronmussling, varmusseron |
| blandad-korg-2 | Kust, tall & höst | 129 kr | rodbrun-stensopp, granblodriska, snobolischampinjon, vinterskivling, frostvaxing |
| blandad-korg-3 | Björk, mosse & skörd | 129 kr | bjorksopp, rodgul-trumpetsvamp, sillkremla, honungsskivling, blamusseron |
| blandad-korg-4 | Blandad skog & övergång | 129 kr | aspsopp, gronkremla, mandelriska, svavelticka, varskivling |
| blandad-korg-5 | Sand, glänta & senhöst | 129 kr | tegelsopp, grynsopp, citronslemskivling, blek-ostronmussling, rokslojskivling |
| blandad-korg-6 | Vår, ved & karaktär | 129 kr | toppmurkla, svart-trumpetsvamp, blomkalssvamp, rodnande-blacksvamp, streckmusseron |
| blandad-korg-7 | Fält, skog & samlarfynd | 129 kr | rund-toppmurkla, farticka, korallticka, rimskivling, blasopp |
| blandad-korg-8 | Tagg, löv & extra fynd | 129 kr | rodgul-taggsvamp, larksopp, kantarell, fjallig-blacksvamp, tallblodriska |

## Områdesspecifika 5-pack (#9–#11 — ärlig geografi/nisch)

| Pack | Namn | Pris | Arter |
| --- | --- | --- | --- |
| syd-adellov-kalk | Syd- & ädellöv / kalkmark | 129 kr | blek-kantarell, kruskantarell, finluden-stensopp, sommartryffel, judasora |
| nordlig-fuktig-profil | Nordlig & fuktig skogsprofil | 129 kr | zonerad-granblodriska, sotvaxing, bla-taggsvamp, rod-svavelticka, brodticka |
| varme-lov-specialsoppar | Värme- & lövpräglade specialsoppar | 129 kr | blodsopp, gulsopp, jattemusseron, tallskrubb, blodriska |

Totalt: 6 gratis + 11×5 = 61 arter, 0 överlapp (fail-fast-validering i modulen kastar fel vid dubblett/saknad).

## Helhetsköp & solo-premium

- `all` — Alla 61 arter, **399 kr** engångsköp (toppköpet; enda sättet att få allt på en gång).
- `goliatmusseron-solo` — **79 kr**, enbart jättemusseron: **foto/karta-paket** (FRIDLYST/VU —
  appen visar habitat + artinfo, aldrig plocktips).
- `pro` finns kvar som entitlement i koden men är **inte till salu** (`forSale=false`, dold i
  `/api/shop`) — säsongen är för kort för prenumeration. Kan aktiveras för betatestare/dev.

### Prisbedömning (129 kr per 5-pack, 79 solo, 399 alla, 39 kr enskild)
Rimligt för Sverige: jämför appar som kostar 30–60 kr engång eller ~300 kr/år prenumeration.
5-pack 129 kr, solo 79 kr, alla 61 för 399 kr, enskild art 39 kr, årskort 249 kr/år.
Solo 79 kr motiveras av att jättemusseron är sällsynt + skyddad (foto-upplevelse).
**Enskild svamp kostar 39 kr** (`species:<id>`) — alla låsta arter utom `jattemusseron`
(solo-only). 39 kr är ett medvetet impulse-köp men meningen är konvertering/engagemang, inte intäkt per køp.

### Shop-visning
- Varje packkort visar bild på mest prominent art (högst ätvärde): `/icons/<id>.png`
  (PNG:er läggs i `public/icons/` på Macen; webben gömmer bilden om filen saknas).
- Rullista "Köp en enskild svamp" längst ner i shopen (alla 54 låsta arter à 39 kr).
- Alla 12 reward-arter ligger garanterat i varsitt pack (fail-fast i modulen) — ingen art är
  "död" (varken köpbara eller rewardbara saknas).
- `/api/shop` ger även `singles`, `singlePriceSek`, `soloOnlySpecies`, `image`/`topSpecies` per pack.
- Dev-endpoint `POST /api/single/claim {species}` (samma mönster som `/api/reward/claim`).

### Belöningsflödet (verifierbart, flera claims)
- `REVIEW_REWARD_SPECIES` (12 låsta arter) kan låsas upp **gratis** via betyg/kommentar —
  max **`MAX_REWARD_CLAIMS = 3`** per användare. `POST /api/reward/claim {species, claimed:[...]}`
  svarar 200 (med `rewardClaimsLeft`), **409** om redan upplåst, **403** när max är nått.
  I produktion verifieras varje betyg server-side (App Store Server API / eget review-API).
- Efter gratis-claims kan samma arter **köpas enskilt (39 kr)** som alla andra — dvs poolen
  är "förhandsmak", inte evig gratis. `/api/shop.singles` = alla 54 låsta arter.
- ⭐ Topp 5 (`TOP_PICKS`) får aldrig innehålla reward-pool-arter eller gratisarter (fail-fast) —
  bara arter man verkligen betalat för: karljohan, trattkantarell, svart-trumpetsvamp,
  rodbrun-stensopp, rodgul-trumpetsvamp à 39 kr.
- Regionpack per län offline: 39 kr/län (PMTiles, klient-side) — ej i PACK_DEFS än.

## "Lås upp 1 svamp mot betyg/kommentar" (review-reward)

- Pool: `REVIEW_REWARD_SPECIES` (12 arter, **alla låsta** "helt ok"-arter: bjorksopp, aspsopp,
  tegelsopp, grynsopp, larksopp, sillkremla, mandelkremla, gronkremla, ostronmussling,
  blek-ostronmussling, rokslojskivling, vinterskivling). Topparter och exklusiva/känsliga arter
  (kantarell, karljohan, trattkantarell, trumpet/taggsvampar, jattemusseron, sommartryffel, murklor,
  korallticka, blomkålssvamp…) kan ALDRIG komma via belöning.
- Max 1 art per användare; sparas som entitlement `reward:<id>` i samma lista som packköp.
- Server-validerat: `?entitlements=reward:karljohan` kastas bort (403) — bara id:n i poolen accepteras.
  `/api/meta` returnerar `reviewRewardSpecies`. I produktion: verifiera betyget server-side via
  App Store/Server API innan `reward:<id>` sätts.

## Regler (inte förhandlingsbara)

1. Säkerhet alltid gratis (se ovan). 2. Inga annonser/dark patterns. 3. Tydliga SEK-priser, Family Sharing.
4. Expertarter (murklor, champinjoner, vårmusseron, kremlor, Cortinarius…) är köpbara men ALLTID
   med expertMode-varning + kontrollista i UI — packköp ger aldrig "plocka direkt".

## Tekniskt

- `?entitlements=blandad-korg-6,pro` (csv) är dev-läge; produktion: validera App Store-kvittot
  server-side (App Store Server API) och sätt entitlements där.
- `/api/tiles/*`, `/api/hotspots`, `/api/peaks`, `/api/debug/cell` → 403 `{error, locked:[...]}` vid låst art.

## Top-spot fraktion — "hetaste ställena" bakom Årskort (`topspots:<år>`)

- **Tre lägen** (fraktion **FREE_HIDE_FRACTION**, default **0.30** — rankat efter score):
  1. **Provperiod** (`?trial=1` eller ent `trial`; i prod från StoreKit/App Store Server API
     `is_trial_period`): alla pins, **inget guld** — full upplevelse som smakprov.
  2. **Free efter provperiod**: topp-**30 %** av pinsen **försvinner helt** (`meta.capped=true`) —
     free ser alltså ~**70 %** av ställena, men alltid utan de absolut hetaste.
  3. **Betalat årskort** (`topspots:<år>`/`topspots`/`all`/`pro`): alla pins tillbaka och
     topp-fraktionen får **`gold: true`** → glödande guld-pins som bara betalande ser.
  `/api/hotspots` (båda grenarna) och `/api/peaks` följer detta; svaren har `meta.capped`,
  `meta.trial`, `goldPeaks`/`goldCells` (antal i topp-fraktionen), `passId`, `passLabel`,
  `passPriceSek`. `/api/meta` och `/api/unlocked` exponerar `topSpots {capped, trial,
  topHiddenFraction, passId, passLabel, passPriceSek, unlocked}`. Packköp låser arter
  oberoende av årskortet.
  OBS compliance: provperioden måste vara tydligt deklarerad (App Store listar den för
  prenumerationer; för egen trial — beskriv i app-beskrivningen).
- Produkt: **Årskort för innevarande år** — id `topspots:<år>` (t.ex. `topspots:2026`), engångsköp
  `TOP_SPOTS_PRICE_SEK` (default 249 kr, env), exponeras i `/api/shop` som `topSpotsPass`.
  `canSeeTopSpots` accepterar `all`, `pro`, `topspots` (alla år) och `topspots:<aktuellt år>`.
  Redeem-koder/admin kan ge `topspots:2026`. "Säsong" togs bort som begrepp — årskort är tydligare.
- **Guld för betalande:** endast pins i topp-fraktionen med `gold: true` (bara när årskortet
  är köpt — aldrig under trial) renderas glödande guld i klienten (iOS: guld-symbol + glow).
  Free efter provperiod får inga sådana pins alls; `meta.goldPeaks` ger antalet för
  upsell-meddelandet ("🔒 N av ställena glöder i guld med Årskort 2026").
- **Compliance (viktigt):** att "fungera 100 % vid nedladdning och sedan cappas" utan
  tydlig förhandsinformation riskerar att klassas som vilseledande (Marknadsföringslagen /
  EU Omnibus) och App Store-avslag. Gör i stället: provperiod tydligt deklarerad (eller
  cap från första start) + 🔒-teaser + tydlig text i App Store-beskrivningen ("gratis visar
  ~70 % av ställena; Årskort låser upp de hetaste 30 % som glöder i guld"). Aldrig tyst
  degradering efter användning.
- Naturvårdssida: jättemusseron (protected) har redan obsPrior=0; capen minskar även
  tramp på de allra hetaste ställena för gratisanvändare.
- Rekommendation nivå: fraktion **0.30 är lagom** — free ser ~70 % av ställena i varje vy
  men missar alltid de absolut hetaste. Testa A/B 0.20 / 0.30 / 0.40 mot konvertering till
  årskort (`FREE_HIDE_FRACTION` i .env).
