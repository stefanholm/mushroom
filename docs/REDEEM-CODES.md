# Inlösenkoder (redeem codes) — plan

Syfte: kod som låser upp innehåll utan köp — för **vänner/testare**, **kunder som haft
problem** (support-kompensation) och marknadsföring. Ska synas i **Affären** i både
webben och iOS-appen.

## Kodformat

`SVAMP-XXXX-XXXX-XXXX-C` — 12 slumpade tecken + 1 kontrollsiffra (checksum mod 31).
Alfabet utan svårlästa tecken (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, dvs utan 0/O, 1/I/L).
Inmatning normaliseras (versaler, streck/blanksteg ignoreras), kontrollsiffran fångar
stavfel → "Ogiltig kod" direkt.

## Vad en kod kan ge (`grant` = entitlement direkt)

| grant | effekt |
| --- | --- |
| `all` | alla arter |
| `pro` | Pro |
| `<packId>` | ett helt pack, t.ex. `blandad-korg-1`, `goliatmusseron-solo` |
| `species:<id>` | en enskild art (ej solo-only — ge då solo-packet) |

## Administration — inifrån appen (admin-panel) ELLER CLI

Sätt först `ADMIN_PIN=hemlig-pin` i `.env` (git-ignored). Admin är avstängt tills PIN är satt.

**I appen:** Inställningar → 🛠 Admin — inlösenkoder → lås upp med PIN. Där kan du välja vad
koden ska ge:
- 🍄 **1 art** (dropdown över icke-fria arter)
- 📦 **1–3 pack** (checkboxar, max 3 per kod → grant blir t.ex. `blandad-korg-1,blandad-korg-2`)
- 🌍 **Alla arter** (`all`)
plus uses (max enheter, 0 = obegränsat), valfritt expires-datum och anteckning.
Koden visas direkt med kopiera-knapp. Panelen listar alla koder (med Återkalla-knapp) samt
referral-statistik och inlösen-loggen.

**Via API:** `POST /api/admin/redeem {pin, grant, uses, expires, note}`,
`POST /api/admin/redeem/revoke {pin, code}`, `GET /api/admin/overview?pin=`.
Rate limit 10 försök/10 min per IP. Fel PIN → 403.

**Via CLI (samma sak):**

```
npm run redeem -- create --grant blandad-korg-1 --uses 5 --note "kompis” --expires 2027-06-30
npm run redeem -- create --grant all --uses 1 --note "support ärende #123"
npm run redeem -- list
npm run redeem -- show SVAMP-XXXX-XXXX-XXXX
npm run redeem -- revoke SVAMP-XXXX-XXXX-XXXX
```

- `uses` = max antal **olika enheter** (0 = obegränsat). Samma enhet kan lösa in samma kod
  igen (idempotent) — funkar vid ominstallation av appen.
- `expires` = sista giltighetsdag (YYYY-MM-DD), valfritt.
- Koder sparas i **`data/redeem-codes.json`** (git-ignored, atomisk skrivning tmp+rename).
  Backa upp filen om du vill ha historik utanför servern.
- Varje inlösen loggas i **`data/redeem-log.json`** (JSONL: tid, kod, device, grant) —
  användbart vid support.
- Servern läser kodfilen **per anrop**, så CLI-ändringar gäller direkt utan omstart.

## API

- `POST /api/redeem {code, device}` → `200 {ok, entitlement, label, alreadyRedeemed}`
  eller `400/404/409/410/429` med tydligt fel (saknas, ogiltig kontrollsiffra, förbrukad,
  utgången/återkallad, för många försök: max 20 per 10 min per enhet+IP).
- `GET /api/redeem?device=<id>` → vilka koder enheten redan löst in (används för att
  återställa efter ominstallation).

## Flöde i appen

1. Affären (🛍️) får ett kort **"🎁 Har du en inlösenkod?"** högst upp: textfält + "Lös in".
2. Vid 200: entitlement läggs till i lokala ents (`mushroom-ents` i webben, Keychain/
   UserDefaults i iOS) → artlistan, tiles och hotspots låses upp direkt (samma
   `?ents=`-flöde som köp/reward).
3. iOS: samma POST till `/api/redeem`, device = appens UUID (Keychain). Samma UI-kort i
   shop-vyn.

## Relation till referral/reward (nu server-side och persistenta)

- **Referral-koder** (`POST /api/referral/create` → dela kod → vän löser in via
  `POST /api/referral/redeem`) är nu **persistenta** i `data/referrals.json`. Både den som
  löser in och kodägaren får +1 referral-credit (`redeemedBy` / `earnedBy`).
- `POST /api/reward/claim` kontrollerar nu **server-side** per enhet (`device` i body):
  max 1 review-claim (kräver betyg 1–5 eller kommentar) + max 2 referral-claims, och en
  referral-claim kräver att enheten faktiskt löst in en referral-kod (`redeemedBy[device]`),
  totalt max 3 reward-arter. Claims sparas i `referrals.json` — överlever omstarter och
  går inte att fuska via klientens ents.
- **Inlösenkoder** är admin-utfärdade och ger direkt entitlement (även csv av flera pack)
  — de räknas INTE mot reward-poolen och kan även låsa upp solo/all/pro (admins val).

### Viktigt om Apple (ärlighet)
- **Köp verifieras i produktion via App Store Server API** (JWS-kvitton från StoreKit 2
  valideras server-side → ents sätts där, inte av klienten). Detta är "självspelande pianot"
  för intäkterna.
- **Recensioner går INTE att verifiera via något Apple-API** — det finns ingen publik metod
  att kontrollera att en användare lämnat betyg/kommentar. Därför är review-claim
  klient-påstådd här (i prod: visa `SKStoreReviewController` först + rimlighetslogg;
  acceptera att någon fåtal fuskar — det kostar en 10-kr-art).

## Anti-abuse

- Rate limit 20 försök/10 min per enhet+IP.
- uses räknas per distinkt device; samma device idempotent.
- revoke/expires stänger koden direkt (filen läses per anrop).
- Koderna är inte hemliga i kryptografisk mening (de är lösenord) — filen är
  git-ignored; i produktion bör koder hashas i DB och admin-API:t skyddas med
  `ADMIN_TOKEN` från .env (nästa steg om du vill ha webb-admin).

## Produktion (iOS/StoreKit)

I prod ska entitlements komma från server-validerade App Store-kvitton, inte från
klienten. Inlösenkoder kompletterar då som server-side grants: efter `POST /api/redeem`
returnerar servern entitlementet och klienten sparar det tillsammans med kvittona;
vid varje `/api/tiles`/`/api/hotspots` skickas hela ents-listan som idag.
