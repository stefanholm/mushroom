# Belöningsmodell (awards) & topplista — för Gemini

Implementerat i kod: `src/habitat.ts` (`REVIEW_REWARD_SPECIES`, `TOP_PICKS`,
`MAX_REWARD_CLAIMS`, `SINGLE_PRICE_SEK`, `SOLO_ONLY_SPECIES`), `src/server.ts`
(`/api/reward/claim`, `/api/single/claim`, `/api/shop`), webb-shop i `public/map.js`.

## 1. Pool & claims

- **Pool**: 12 låsta "helt ok"-arter (`REVIEW_REWARD_SPECIES`). Alla ligger också i vanliga
  pack (fail-fast i koden). Toppar/exklusiva (kantarell, karljohan, trattkantarell, trumpet-/
  taggsvampar, jattemusseron, sommartryffel, murklor, korallticka, blomkålssvamp) är spärrade.
- **Max 3 gratis-upplåsningar per användare = 1 app-recension + 2 referral-koder**
  (`MAX_REVIEW_CLAIMS = 1`, `MAX_REFERRAL_CLAIMS = 2`, `MAX_REWARD_CLAIMS = 3`).
  `POST /api/reward/claim {species, type: "review"|"referral", rating?, comment?, claimed:[...], types:[...]}`
  → 200 + `rewardClaimsLeft`, 409 vid dubblett, 403 när typens max är nått, 400 om
  review saknar betyg/kommentar.
- **Referral-koder**: `POST /api/referral/create {device}` → `{code, shareText}`;
  `POST /api/referral/redeem {code, device}` → 200 (max 2 per enhet), 404 ogiltig kod,
  403 egen kod, 409 redan använd. (Dev: in-memory; produktion: i DB kopplad till Apple-ID.)
  Efteråt kan samma art köpas enskilt för 10 kr (`species:<id>`).
- Jättemusseron är `SOLO_ONLY` — aldrig i poolen, bara `goliatmusseron-solo` (79 kr, foto/karta).

## 2. Verifierbarhet per kanal (viktigt — olika kanaler är olika säkra)

| Kanal | Verifierbar server-side? | Hur vi gör |
| --- | --- | --- |
| **App Store-betyg** (SKStoreReviewController) | **Nej** — Apple exponerar inte reviews via API | Be om betyg i appen, men belöna på den **in-app-kommentar** vi själva lagrar (se nedan). Betyget är "nudge", inte krav. |
| **In-app kommentar/feedback** | **Ja** — vi lagrar den i vår egen backend | Krav för reward: betyg 1–5 ELLER kommentar ≥3 tecken, sparad server-side med device-id + tidsstämpel. |
| **Dela till Instagram/Facebook** | **Inte direkt** — ingen öppen API för att läsa andras posts | Dela-kort genererar en **unika referral-kod**; när en ny användare anger koden vid första start låses en pool-art upp åt båda (verifierbart i vår DB). Själva Instagram/Facebook-posten går inte att verifiera utan Business API — därför referral-koden. |
| **E-post/tips vän** | Ja, via samma referral-kod | Samma mekanism. |

**Anti-fusk:** max 3 claims/användare (serverräknat), device-id + tidsstämpel på varje claim,
rate-limit (1 claim/24 h), pool-art kan inte claimas två gånger (409). I produktion: koppla
claims till App Store-konto (receipt) så samma Apple-ID inte kan farma på flera enheter.

## 3. Topplistan (⭐ Topp 5 i shopen)

- `TOP_PICKS` = kantarell (gratis), karljohan, trattkantarell, svart-trumpetsvamp,
  rodbrun-stensopp — visas överst som enskilda köp (gratis eller 10 kr) med bild.
- **Regel (fail-fast i kod):** Topp 5 får aldrig innehålla reward-pool-arter — bara arter man
  verkligen betalat för, eller som är gratis från början.
- Under topp-listan: 13 pack-kort (med bild på top-art per pack) + rullista för alla 54
  låsta arter à 10 kr.

## 4. Framtida awards att överväga (Gemini)

- Referral-kod (ovan) — ger organisk tillväxt + verifierbar belöning.
- "Första fyndet" — användaren loggar ett eget svampfynd (foto+plats) → en pool-art.
  Verifierbart via vår DB (foto måste följa med), men skyddad art = bara foto.
- Säsongs-badges (inte köp): plockade 5 arter → badge. Engagement utan intäkt.
- Pro finns kvar i koden men är `forSale=false` (för kort säsong).
