# DATAFLOW — vad som går backend → frontend (iOS), när, och hur mycket

Genererad 2026-11-27 från kontraktet i `docs/FRONTEND-CONTRACT.md` (källor: `src/server.ts`, `worker/src/index.ts`).
Siffror är mätta i sandbox (demo-data) — ordningen av storlek är rätt även i prod.

## Vid app-start (1–2 anrop)
| Anrop | När | Svar | Ca storlek | Cache |
|---|---|---|---|---|
| `GET /api/v1/manifest` | alltid först | `tileRev`, bounds, rainSpans, endpoints | ~0,5 kB | 300 s |
| `GET /api/v1/bootstrap?species=..&ents=..` | vid start + artbyte | `shop`, `unlocked`, `leaderboard`, `clouds` manifest, `rainHistory{14,21,28,42}` manifests, `fungi{art:{overviewCells(≤120), zone, zonePending, profile, rainWindowDays}}`, `tileRev`, `rainSpans` | ~44 kB rått (gzip ~6 kB); zonen adderar ~10–20 kB/art | 60 s |

## Per kartvy (pan/zoom)
| Anrop | När | Svar | Ca storlek | Cache |
|---|---|---|---|---|
| `/api/tiles/{habitat/<art>,multi,hillshade}/<z>/<x>/<y>.png` | bara NYA synliga tiles | PNG 256×256 heatmap/terräng | ~8–27 kB/tile (z10–z12), tiotals per pan | **immutable** + `tileRev` |
| `GET /api/hotspots?bbox=..&species=..&static=..&minScore=..&maxP=..&ents=..` | efter pan/zoom/artbyte | pins `{lon,lat,score,species,gold?}` + `meta{source,capped,goldPeaks,trial}` + `skipped` | makro (hela Sverige): ~10 kB rått → ~1,3 kB gzip; detalj: mindre | 60 s |
| `GET /api/v1/fungi/overview?species=..&static=..` | Sverige-vy (zoom ut) | `tiers{55km,18km,6km}` + profiles + goldPeaks | ~5–30 kB | 60 s |
| `GET /api/v1/fungi/optimal-zone?species=..&date=..&static=..` | vid artbyte/lägebyte | EN grön Polygon (`optimalZone`) eller `null` + `meta.peakScore` | ~10–20 kB (ring ~45–260 punkter) | 60 s (SWR 15 min server-side; worker: förbakad zones/*.json) |
| `GET /api/meta?species=..&lat=..&lon=..&fast=1` | artbyte | speciesList 61, packs, topSpots, väder (null på edge) | ~15 kB | 60 s |

## Väder-lagren (moln + regn)
| Anrop | När | Svar | Ca storlek | Cache |
|---|---|---|---|---|
| `GET /api/v1/weather/clouds/manifest` | vid väderlager på | 10–12 frames (nu→+22 h) | manifest ~2 kB | 300 s |
| moln-frame `…/frame/<id>.png` | per animeringssteg | RGBA 160×200 | ~25–30 kB/frame, hela loopen ~300 kB | **immutable** |
| `GET /api/v1/weather/rain-history/manifest?days=14\|21\|28\|42` | vid regn-lager | 8–11 ackumulerade frames/span | manifest ~2–4 kB | 600 s |
| regn-frame `…/frame/<id>.png` | per animeringssteg | RGBA 256×320 | ~25–50 kB/frame | **immutable** |

## Socialt / monetarisering
| Anrop | Svar | Cache |
|---|---|---|
| `GET /api/shop?ents=` | packs/singles/topPicks/topSpotsPass (ägda filtreras bort) | 300 s |
| `GET /api/unlocked?ents=&device=` | `unlocked[]`, klassiker, topSpots | 60 s |
| `POST /api/report-signal` | `{ok}` (403 orimlig förflyttning, 429 dagsgräns) | — |
| `GET /api/leaderboard[?days&device]` | topplista | 60 s |
| `DELETE /api/privacy/delete?device=` | `{ok,deleted}` | — |

## Fel som kan nå frontend
`400 {error}` · `403 {error, locked[]}` → visa shop · `429 {error}` → backoff · `/api/debug/*` 404 i prod.

## Sammanlagt per session (typiskt)
Start ~50 kB gzip. Pan/zoom: några hundra kB tiles (cachas hårt). Väder-loop: ~300–500 kB första gången, sedan 0 (immutable). Alltså väl inom mobilnät; gzip på JSON är aktiverat på origin (`compression`) och Workern komprimerar också.
