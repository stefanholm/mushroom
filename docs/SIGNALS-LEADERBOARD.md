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

## nearbyActivity (i `/api/meta` och `/api/hotspots` meta) — progressiv geografi + feed48h

Slår ihop **anonyma medlemsfynd** (senaste 14 d) + **Artportalen** (`observations.geojson` med
`eventDate`, senaste 30 d, **hela artkatalogen**). **Progressiv geografisk fallback:** välj minsta
scope med ≥3 fynd, annars bredaste med något: `local` (30 km, "Ditt närområde") → `area` (region
t.ex. "Mälardalen"/"Skåne"/"Västkusten") → `part_of_sweden` ("Södra/Mellersta/Norra Sverige") →
`sweden` ("Hela Sverige"). `scope`+`scopeLabel` finns på toppnivå OCH per highlight. 30 km-lokal
nivå + 0.05° celler garanterar att inga exakta positioner röjs; svaret innehåller aldrig koordinater.
Arter filtreras på **i säsong** just nu och **bra lokalt habitat** (`staticHabitatScore ≥ 0.6` vid
användarens plats). Highlights = rullande lista (max 8), sorterad på senaste aktivitet, med både
upplåsta (`kind: "report"`) och låsta (`kind: "upsell"`) arter + `summary`, `timestamp`.

**`feed48h`** skickas **bara för årskort** (`tierMode: "annual"`): senaste 48 h från båda källor
(max 10) blandat med köprekommendationer för låsta arter i säsong med starkt habitat (≥0.8, även
utan fynd). `free`/`trial` får `feed48h: []`.

Nivåstyrd (från `capMeta`): 

| nivå | tierMode | highlights | ctaType |
|---|---|---|---|
| free efter trial (capped) | `free` | **tom** (arter dolda), bara `hasRecentFinds`/`totalRecentFinds`/`sources` | `upgrade_annual_pass` |
| trial | `trial` | full lista | `trial_upsell` |
| årskort (unlocked) | `annual` | full lista | `buy_species_or_pack` om någon highlight är låst, annars `none` |

```json
"nearbyActivity": {
  "hasRecentFinds": true, "totalRecentFinds": 14,
  "scope": "local", "scopeLabel": "Ditt närområde", "radiusKm": 30,
  "sources": ["member", "artportalen"], "tierMode": "annual", "ctaType": "buy_species_or_pack",
  "highlights": [
    { "species": "frostvaxing", "kind": "report", "findCount": 4, "sources": ["member", "artportalen"],
      "scope": "local", "scopeLabel": "Ditt närområde", "habitatScore": 97, "isUnlocked": true, "packId": null,
      "summary": "Gårdagens toppfynd i ditt närområde", "timestamp": "2026-11-24T10:00:10Z" },
    { "species": "vinterskivling", "kind": "upsell", "findCount": 2, "sources": ["member", "artportalen"],
      "scope": "local", "scopeLabel": "Ditt närområde", "habitatScore": 76, "isUnlocked": false,
      "packId": "blandad-korg-2", "summary": "Nya fynd i ditt närområde (Artportalen)",
      "timestamp": "2026-11-24T09:48:49Z" }
  ],
  "feed48h": [ /* samma post-form, bara för annual; free/trial får [] */ ]
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
- nearbyActivity: radie 30 km; progressiv fallback local→area→part_of_sweden→sweden (testat:
  Kiruna → scope sweden "Hela Sverige", 60N/16E → area "Mälardalen"); per-highlight scope/scopeLabel/
  timestamp/summary/kind report|upsell; feed48h bara för årskort (free/trial får []); årskort får
  cta buy_species_or_pack för låst vinterskivling (blandad-korg-2); Artportalen från hela katalogen
  dyker upp direkt med sources:["artportalen"]
- ents=pro → ej art-upplåst men topSpots=true; ents=all → 61 arter, topSpots=false
