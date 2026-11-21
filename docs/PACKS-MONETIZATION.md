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

## Helhetsköp

- `all` — Alla 61 arter, **149 kr** engångsköp.
- `pro` — Pro, **299 kr/år** (alt 49 kr/mån): allt ovan + fläckvarning + obegränsad chatt + offline hela Sverige.
- Regionpack per län offline: 39 kr/län (PMTiles, klient-side) — ej i PACK_DEFS än.

## Regler (inte förhandlingsbara)

1. Säkerhet alltid gratis (se ovan). 2. Inga annonser/dark patterns. 3. Tydliga SEK-priser, Family Sharing.
4. Expertarter (murklor, champinjoner, vårmusseron, kremlor, Cortinarius…) är köpbara men ALLTID
   med expertMode-varning + kontrollista i UI — packköp ger aldrig "plocka direkt".

## Tekniskt

- `?entitlements=blandad-korg-6,pro` (csv) är dev-läge; produktion: validera App Store-kvittot
  server-side (App Store Server API) och sätt entitlements där.
- `/api/tiles/*`, `/api/hotspots`, `/api/peaks`, `/api/debug/cell` → 403 `{error, locked:[...]}` vid låst art.
