# Utkast: svamppack, regionpack & betalning i "steho" (att bolla med Gemini)

Status: **utkast för diskussion** — inget är låst. Mål: tydlig, icke-girig prissättning där
säkerhet ALLTID är gratis.

## Grundprinciper (inte förhandlingsbara)

1. **Säkerhet är alltid gratis**: alla 43 nybörjarsäkra arter, förväxlingsvarningar
   (`lookalikes`), FRIDLYST-markeringar, expert-kontrollistor, chattens säkerhetsregler,
   Giftinformationscentralen-info. Ingen paywall på livsfarlig information.
2. **Inga annonser, inga dark patterns.** Tydliga priser i SEK, Family Sharing via StoreKit.
3. **Gratisversionen ska vara riktigt användbar** — man ska kunna svampjaga med den.

## Föreslaget innehåll

### Gratis (bas)
- Karta + värmelager för alla säkra arter (ej expertarter) — online.
- Chatt: 20 frågor/dag (säkerhetsreglerna alltid på).
- Stigar, Terrängskugga, Spara PNG, tryck-inspektion (`/api/debug/cell`), Hitta bilen.
- 1 region online (valfri, t.ex. ditt eget län).

### Svamppack (engångsköp, teman av arter)
- "Kantarell & trattkantarell" — 29 kr
- "Soppar & tickor" — 39 kr
- "Skivlingar EXPERT" (murklor, champinjoner, kremlor… bakom kontrollista) — 49 kr
- "Vinter & ved-svampar" — 29 kr
- "Alla 61 arter" — 99 kr (bästa värde)
- Innehåll per pack: arternas värmelager + ikoner + detaljerade artkort + säsong/GDD-fönster.

### Regionpack (engångsköp per län, offline PMTiles)
- 39 kr/län, eller "Hela Sverige offline" — 149 kr.
- Innehåll: PMTiles per län (basemap + värmeraster bakade via `npm run bake-tiles`) → funkar utan täckning.

### Pro-prenumeration
- 49 kr/mån eller 299 kr/år (≈ 25 kr/mån), 7 dagars gratis provperiod.
- Innehåll: obegränsad chatt, **fläckvarning** (bakgrundsvarning när du passerar in-season habitat —
  kräver Always-location, därför Pro), hela Sverige offline, alla svamppack, nya arter direkt vid släpp.

## Öppna frågor att bolla med Gemini

1. One-time vs prenumeration-mix: är 299 kr/år + engångspack för austère? Risk: för många köpalternativ → beslutsångest. Kanske bara Gratis / Pro / Regionpack-län?
2. Ska Expertpack vara gratis i stället (säkerhetsskäl) och bara "avancerade artkort" köpas?
3. Prisnivåer i SEK för Sverige 2026 — vad tar liknande appar (Svampguiden, iNaturalist premium är gratis…) — differentiering: vi är den enda med habitatprognos + fläckvarning.
4. B2B: kommuner/skogsägare (nyckelbiotoper, svampinventering) — separat licens?
5. Fläckvarning: Always-location kan skrämma — räcker "När appen används" + notis vid rörelse?
6. StoreKit: consumables (pack) vs non-consumable (region/län) vs subscription — rätt kategorier? Family Sharing på allt?
7. Gratis trials: 7 dagar Pro — risk för abuse, men branschstandard.

## Tekniskt (implementerat, dev-läge)

- `src/habitat.ts`: varje art har `pack` (gratis-arter saknar pack). `PACKS` katalog +
  `isSpeciesUnlocked(id, ents)`.
- `/api/meta` svarar med `entitlements`, `packs` (id/label/priceSek/kind/speciesCount) och
  `speciesList[].pack/locked`.
- `/api/tiles/habitat/...`, `/api/tiles/multi/...`, `/api/hotspots`, `/api/peaks`,
  `/api/debug/cell` svarar **403 `{error, locked:[...]}`** för låsta arter.
- Entitlements skickas idag som `?entitlements=pro,expert` (csv) — **bara för dev/test**.
  I produktion: validera App Store-kvittot server-side (App Store Server API / StoreKit 2
  `verifyReceipt`) och sätt entitlements där; klienten får aldrig bestämma själv.
- Offline PMTiles per Regionpack är klient-filer (ingen server-gating behövs).
- Fläckvarning: iOS background location + `/api/hotspots?lat&lon&radius` — se GEMINI-HANDOFF §1.
