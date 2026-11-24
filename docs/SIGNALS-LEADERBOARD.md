# SIGNALS & LEADERBOARD — anonyma fynd, anti-fusk, topplista, nearbyActivity

Datum: 2026-11-23. Persistent lagring i **SQLite** (`node:sqlite`, `data/signals.db`, git-ignored) —
redo att porta till **Cloudflare D1** i produktion (samma schema funkar rakt av).

## Datamodell

- `signals(id, dev, alias, species, cellLat, cellLon, at, points, flags)` — **aldrig exakt GPS**,
  bara 0.05° ≈ 5×5 km-rutor (`cellOf`).
- `devmeta(dev, lastCellLat, lastCellLon, lastAt, today, todayPoints)` — för restids-koll och dygnstak.
- Alias = sha256("svampradar:"+device) → ordlista (Hamm, Räv, Uggla, …) — samma enhet får alltid samma alias.

## Endpoints

### `POST /api/report-signal` { device, species, lat, lon }
- Rate limit 30/10 min/IP. 400 utan device / okänd art / utanför Sverige. 403 vid orimlig restid.
- Server-side scoring (alltid server-tid, klienten kan inte backdata):
  - bas 10 p
  - **natt** (solhöjd < −6° på rut+datum, `sunElevationDeg`) → **0 p**, flag `natt`
  - **blindfläck** ×1.5 om <3 fynd i rutan senaste 14 d
  - **habitatbekräftelse** ×1.25 om modellen ger ≥0.7 där
  - **kantsäsong** ×1.2 om artens seasonFactor är 0–0.9 just nu
  - **helg** ×1.1 (lör/sön UTC)
  - **dygnstak** 100 p/enhet/dygn
  - **orimlig restid** >250 km/h mellan två rutor samma enhet → 403 `orimlig_restid`
- Svar: `{ ok, points, flags[], alias, cellLat, cellLon }`

### `GET /api/leaderboard?days=5` → `{ days, leaderboard: [{rank, alias, points, finds}] }` (Topp 10)
### `GET /api/leaderboard/score?device=X&days=5` → `{ days, alias, points, finds, rank }`

## nearbyActivity (i `/api/meta` och `/api/hotspots` meta)

Slår ihop **anonyma medlemsfynd** (senaste 14 d, inom 7 km, från signals) + **Artportalen**
(`observations.geojson` med `eventDate`, senaste 30 d, inom 7 km). Filtreras på arter **i säsong**
just nu (`seasonalFactor > 0`) med **bra lokalt habitat** (`staticHabitatScore ≥ 0.6` vid användarens plats).

Nivåstyrd (från `capMeta`): 

| nivå | tierMode | highlights | ctaType |
|---|---|---|---|
| free efter trial (capped) | `free` | **tom** (arter dolda), bara `hasRecentFinds`/`totalRecentFinds`/`sources` | `upgrade_annual_pass` |
| trial | `trial` | full lista | `trial_upsell` |
| årskort (unlocked) | `annual` | full lista | `buy_species_or_pack` om någon highlight är låst, annars `none` |

```json
"nearbyActivity": {
  "hasRecentFinds": true, "totalRecentFinds": 14, "sources": ["member", "artportalen"],
  "tierMode": "annual", "ctaType": "buy_species_or_pack",
  "highlights": [{ "species": "vinterskivling", "findCount": 1, "sources": ["member"],
                   "habitatScore": 76, "isUnlocked": false, "packId": "blandad-korg-2" }]
}
```

## Entitlement-separation (ändrat 2026-11-23)

- `pro` / `topspots:<år>` (Årskort) låser **inte** upp arter/paket — bara 100 % av träffarna
  (ingen 70 %-cap, guld på topparna). Verifierat: `ents=pro` → 6 gratisarter upplåsta, tiles för
  låsta arter → 403.
- Endast `all`, paket-ID, `species:<id>`, `reward:<id>` låser upp arter. `all` ger arter men
  **inte** årskortets guld (beslut 0069fa0).

## Verifierat i sandbox (2026-11-23)

- rapport dagtid: 200, 18.8 p (blindfläck×habitat), alias satt
- samma enhet demo→Kiruna direkt: **403 orimlig_restid**
- natt (solhöjd −50.9°): **0 p**, flag `natt`
- leaderboard Top 10 + egen score/rank: OK
- nearbyActivity: free döljer arter (cta upgrade_annual_pass), trial full (trial_upsell),
  årskort full + buy_species_or_pack för låst vinterskivling (packId blandad-korg-2)
- ents=pro → ej art-upplåst men topSpots=true; ents=all → 61 arter, topSpots=false
