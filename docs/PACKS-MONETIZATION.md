# Svamppack & betalning i "steho" (Gemini-signerad struktur, implementerad i kod)

Status: **implementerat** i `src/habitat.ts` (`PACK_DEFS`/`PACKS`), exponerat via
`/api/meta` (`packs`, `speciesList[].pack/locked`) och 403-gating på tiles/hotspots/debug.
Paketen ligger i KOD — inte i `data/species/artfakta.json` (den är git-ignored data).

## Gratisnivå (6 arter — förtroendebyggare)

`kantarell`, `blek-taggsvamp`, `brunsopp`, `sandsopp`, `smorsopp`, `stolt-fjallskivling`

Alltid gratis även utanför artlistan: säkerhetsinfo (förväxlingsvarningar, FRIDLYST,
säkerhetschecklista i chatt), Stigar, Terrängskugga, Spara PNG, Hitta bilen, tryck-inspektion.

## Blandade 5-pack (#1–#8 — tvärblandade grupper/miljöer, 0 överlapp)

| Pack | Namn | Pris | Arter |
| --- | --- | --- | --- |
| blandad-korg-1 | Skog & sensommar | 39 kr | trattkantarell, karljohan, mandelkremla, ostronmussling, varmusseron |
| blandad-korg-2 | Kust, tall & höst | 39 kr | rodbrun-stensopp, granblodriska, snobolischampinjon, vinterskivling, frostvaxing |
| blandad-korg-3 | Björk, mosse & skörd | 29 kr | bjorksopp, rodgul-trumpetsvamp, sillkremla, honungsskivling, blamusseron |
| blandad-korg-4 | Blandad skog & övergång | 29 kr | aspsopp, gronkremla, mandelriska, svavelticka, varskivling |
| blandad-korg-5 | Sand, glänta & senhöst | 29 kr | tegelsopp, grynsopp, citronslemskivling, blek-ostronmussling, rokslojskivling |
| blandad-korg-6 | Vår, ved & karaktär | 39 kr | toppmurkla, svart-trumpetsvamp, blomkalssvamp, rodnande-blacksvamp, streckmusseron |
| blandad-korg-7 | Fält, skog & samlarfynd | 29 kr | rund-toppmurkla, farticka, korallticka, rimskivling, blasopp |
| blandad-korg-8 | Tagg, löv & extra fynd | 29 kr | rodgul-taggsvamp, larksopp, jatteroksvamp, fjallig-blacksvamp, tallblodriska |

## Områdesspecifika 5-pack (#9–#11 — ärlig geografi/nisch)

| Pack | Namn | Pris | Arter |
| --- | --- | --- | --- |
| syd-adellov-kalk | Syd- & ädellöv / kalkmark | 29 kr | blek-kantarell, kruskantarell, finluden-stensopp, sommartryffel, judasora |
| nordlig-fuktig-profil | Nordlig & fuktig skogsprofil | 29 kr | zonerad-granblodriska, sotvaxing, bla-taggsvamp, rod-svavelticka, farsticka |
| varme-lov-specialsoppar | Värme- & lövpräglade specialsoppar | 29 kr | blodsopp, gulsopp, jattemusseron, tallskrubb, blodriska |

Totalt: 6 gratis + 11×5 = 61 arter, 0 överlapp (fail-fast-validering i modulen kastar fel vid dubblett/saknad).

## Helhetsköp & solo-premium

- `all` — Alla 61 arter, **149 kr** engångsköp (toppköpet; enda sättet att få allt på en gång).
- `goliatmusseron-solo` — **79 kr**, enbart jättemusseron: **foto/karta-paket** (FRIDLYST/VU —
  appen visar habitat + artinfo, aldrig plocktips).
- `pro` finns kvar som entitlement i koden men är **inte till salu** (`forSale=false`, dold i
  `/api/shop`) — säsongen är för kort för prenumeration. Kan aktiveras för betatestare/dev.

### Prisbedömning (29–39 kr per 5-pack, 79 solo, 149 alla, 10 kr enskild)
Rimligt för Sverige: jämför appar som kostar 30–60 kr engång eller ~300 kr/år prenumeration.
5-pack 29–39 kr ligger i "impulsköp"-spannet; 149 kr för alla 61 är ett tydligt bästa-värde.
Solo 79 kr motiveras av att jättemusseron är sällsynt + skyddad (foto-upplevelse).
**Enskild svamp kostar 10 kr** (`species:<id>`) — alla låsta arter utom `jattemusseron`
(solo-only). 10 kr är lågt men meningen är konvertering/engagemang, inte intäkt per køp.

### Shop-visning
- Varje packkort visar bild på mest prominent art (högst ätvärde): `/icons/<id>.png`
  (PNG:er läggs i `public/icons/` på Macen; webben gömmer bilden om filen saknas).
- Rullista "Köp en enskild svamp" längst ner i shopen (alla 54 låsta arter à 10 kr).
- Alla 12 reward-arter ligger garanterat i varsitt pack (fail-fast i modulen) — ingen art är
  "död" (varken köpbara eller rewardbara saknas).
- `/api/shop` ger även `singles`, `singlePriceSek`, `soloOnlySpecies`, `image`/`topSpecies` per pack.
- Dev-endpoint `POST /api/single/claim {species}` (samma mönster som `/api/reward/claim`).

### Affärsregel: belöningsarter säljs aldrig enskilt
Arter i `REVIEW_REWARD_SPECIES` (12 st) kan låsas upp **gratis** via betyg/kommentar — därför
säljs de **aldrig** som enskilda 10 kr-köp och får aldrig vara i ⭐ Topp 5 (fail-fast i koden).
De finns kvar i sina vanliga pack. Så topp-listan/enskilda-köpen innehåller bara arter man
verkligen måste betala för (eller som är gratis från början). `/api/shop.singles` är därför
42 arter (54 låsta − 12 reward-pool); `POST /api/single/claim` svarar 403 för reward-arter.
Topplistan (`TOP_PICKS`): kantarell (gratis), karljohan, trattkantarell, svart-trumpetsvamp,
rodbrun-stensopp à 10 kr.
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
