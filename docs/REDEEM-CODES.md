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

## Administration (CLI, ingen webb-admin än)

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

## Relation till referral/reward

- **Referral-koder** (användare delar sin egen kod, `POST /api/referral/create`) är kvar
  oförändrade — de ger referral-claims i reward-poolen (max 2, totalt max 3 gratisarter).
- **Inlösenkoder** är admin-utfärdade och ger direkt entitlement — de räknas INTE mot
  reward-poolen och kan även låsa upp solo/all/pro (admins val).

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
