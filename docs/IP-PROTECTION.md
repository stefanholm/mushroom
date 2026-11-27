# IP-PROTECTION — göm beräkningarna i backend, minimera vad klienten kan analysera

Hotspots är produkten, men **modellen** (vikter, faktorer, lager, trösklar i `src/habitat.ts` /
`src/optimal-zone.ts`) ska inte gå att läsa ut ur appen/API:t. Vad som gäller:

## Redan på plats
- **All scoring körs server-side.** Klienten får bara färdiga produkter: PNG-tiles (heatmaps),
  aggregerade pins med heltals-score, overview-celler, och optimalzonen som en färdig polygon.
  Inga vikter, formler eller mellanliggande faktorer skickas någonsin i API-svar.
- **`/api/debug/*` är AV i prod** (`DEBUG_API=1` krävs lokalt; `debugOff()` → 404). Det är där
  full faktor-brytning (`/api/debug/cell`) finns — den ska aldrig nå prod.
- **`/api/meta` skickar bara diagnostik lokalt** (`DEBUG_API=1`): `layersLoaded`, `layersTooBig`,
  `tileVersion`, `hostFallback`, polygon-räknare. I prod skickas bara produkt-fält
  (`forestKnown`, `maskUsed` som booleans hålls kvar). Från och med denna ändring.
- **Repo:t är privat** (`stefanholm/mushroom`) — pusha aldrig till ett publikt repo, och
  `git grep` efter nycklar innan ev. open-souring.
- **Skyddade arter:** aldrig exakta koordinater publikt (befintlig regel).
- **Rate limits per IP+path (10 min):** chat 20, report-signal 30, privacy-delete 10,
  debug/cells 10, **hotspots 120, overview 60, optimal-zone 30, bootstrap 60, tiles 900** —
  stoppar scraping av hela landet / mass-probing av modellen. I prod komplettera med
  Cloudflare Rate Limiting / WAF (bot-score) framför Workern.
- **Entitlement-gating överallt** (`gateSpecies`/`capMeta`): låsta arter ger 403/skipped, så
  även heatmaps för exklusiva arter inte kan probas gratis.

## Med origin-fri Worker (`worker/` — klart i kod, deploy enligt `worker/README.md`)
- Workern servar tiles/ikoner/overview/hotspot-block/zones/frames direkt från R2 och bygger
  `/api/hotspots`, `/api/v1/fungi/overview`, `/api/v1/bootstrap`, `/api/shop`, `/api/unlocked`
  själv; signaler/topplista går via D1. **Rasters och scoringskod finns ALDRIG i molnet** —
  `zones/*.json` är förbakade polygoner (origin/Mac), aldrig rålager.
- Sätt `ORIGIN_URL=""` i prod så Workern 404:ar allt den inte själv hanterar — Node-originen
  (med `src/habitat.ts`, vikter, `floodDamping`) blir då helt privat bakom tunnel/allowlist.

## När Cloudflare Worker är uppe (`worker/`, se `worker/README.md`)
- Bara Workern blir publik (custom domain + HTTPS). **Node-originen (`ORIGIN_URL`) exponeras
  aldrig** — Workern proxar `/api/*` men är det enda publika ansiktet utåt; origin kan
  bindas till 127.0.0.1/tunnel.
- Stora PNG (tiles/ikoner) från R2 med `immutable` — Workern själv innehåller ingen
  scoringskod (bara routing), så det finns inget att reverse-engineera i edge-koden.
- Kvittovalidering (App Store Server API, `.p8` som Worker-secret) gör `shop`/`unlocked`
  auktoritativa utan att klienten kan fejka `ents=` i prod (dev-läget behåller `?ents=`).

## Vad som är omöjligt att dölja (och varför det är OK)
- Heatmap-tiles och pin-scores **är** produkten — en konkurrent kan alltid proba ett
  scoring-API. Det vi skyddar är *hur* scoren räknas (vikter/faktorer/trösklar), inte
  själva kartan. Därför: inga debug-fält i prod, rate limits, och inga exakta
  mellanresultat i svaren.
- Scores skickas som heltal 0–100; `optimalZone.meta` har bara peak/antal celler (produkt-nivå).

## Checklista innan prod
- [ ] `DEBUG_API` är INTE satt på prod-origin (debug-endpoints 404, meta utan diagnostik)
- [ ] Worker är enda publika entry; origin bakom tunnel/allowlist
- [ ] Cloudflare Rate Limiting/WAF på `/api/*`
- [ ] `.p8` och andra secrets bara som Worker-secrets (aldrig i repo/.env i prod)
- [ ] Repo:t privat; `.env` git-ignored (är det)
