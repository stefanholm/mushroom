# Handoff report to Gemini — svampradar "steho" next round

This document is the full brief for the next implementation round. Read it top to bottom,
then figure out the details marked **GEMINI FIGURES OUT** yourself and implement.
Repo: `stefanholm/mushroom`, branch `vibe/mistral-chat-df5813` (draft PR #1, base `main`).
Latest commit at writing: `0f12d0c`.

## 0. Current state (already built and verified on the user's Mac)

- Stack: Node 22+ (Mac: Homebrew node v26.13.1), Express 5, tsx, TypeScript 5.9
  (`npm run typecheck` = `tsc --noEmit` gate), ESM. Mistral chat via
  `@mistralai/mistralai`, model `mistral-small-latest`, key in `.env` server-side only.
  Answers in Swedish. System prompt at `src/server.ts:13` (`SYSTEM_PROMPT`).
- MapLibre GL 6.19 from `/vendor/maplibre`; web UI in `public/` (species pills max 4,
  date slider ISO `YYYY-MM-DD` server-side, sensitivity slider ±10 around base 70,
  basemap Terräng/OSM/Satellit, hiking trails overlay, "Spara PNG" export).
- Scoring in `src/habitat.ts`: hard gates (NMD forest classes, water 50 m, paved road
  50 m zero / 80 m ×0.5, buildings 30 m, clear-cuts, host volume, tree height, moisture
  veto, GDD5 climate gate, soil veto) then geometric-mean `S_env` then dynamic `D`
  (season, rain14, frost, cool-night flush). Full equations in `docs/SCORING.md`.
- **31 species** with eatScore ★, season, safety note, GDD envelopes, soil-depth ideals,
  calibrated against ~9 578 Artportalen observations via GBIF
  (`scripts/fetch-artdatabanken.mjs`, `npm run artfakta`). Goliatmusseron badged
  FRIDLYST/VU; trattkantarell carries the toppig giftspindling warning.
- Layers: real NMD 10 m mask + real SGU jorddjup 10 m on the Mac; demo rasters for the
  rest (SLU Skogskarta, markfuktighet, jordart, 2 m DEM, gdd5 — drop-in real files same
  filenames in `data/layers/`, manifest `data/layers/manifest.json`).
- Endpoints (`src/server.ts`): `/api/chat`, `/api/meta` (speciesList + `gdd5` at
  lat/lon + tileVersion), `/api/tiles/habitat/:species/:z/:x/:y.png`,
  `/api/tiles/multi/:z/:x/:y.png?species=a,b`, `/api/hotspots?species&bbox` (peaks ≥ 80,
  ~120 m spacing, cap 120, for iOS symbol layer), `/api/peaks`, `/api/debug/cell`
  (full factor breakdown), `/api/hillshade`, `/api/tiles/hillshade/...`.
  Tile cache `data/tile-cache/r15/...`, `TILE_VERSION = "r15"`.
- Verified on the Mac: `maskUsed: true`, `gdd5: 1502` at 59.4/18.1, real `fDepth` from
  SGU, 2 730 kantarell tiles baked z9–14 (125 s, 0 errors), 3 207 PNGs / 55 MB cache,
  9 578 Artportalen observations in `data/validation/observations.geojson`.

## 1. NEW FEATURE — "fläckvarning": alert when passing an in-season hotspot patch

**User request:** when the user walks/drives past a patch that has mushroom habitat for a
selected species that is currently in season, fire a local notification.

**GEMINI FIGURES OUT** the concrete design. Constraints and options to weigh:

- iOS: `CLCircularRegion` monitoring is capped (~20 regions), so monitoring every peak is
  impossible. Choose between (a) significant-location-change + background fetch +
  server-side check, or (b) re-registering a small set of regions around the *nearest*
  peaks from `/api/hotspots?species=<selected>&bbox=<small box around user>&date=<today>`
  (cap 120 peaks already server-side). Needs Always location permission, background
  modes, and aggressive dedupe (notify once per hotspot id, per day) to save battery.
- Backend: decide whether `/api/hotspots` is enough or a radius form
  (`/api/hotspots?species=…&lat=…&lon=…&radius=500`) is cleaner for "am I inside/near one".
  Must respect the season factor (only alert for species in season on that date) and the
  120-day date cap.
- Web fallback: `watchPosition` foreground-only version (no background alerts in browser).
- Notification text in Swedish, e.g. "Svamphabitat i närheten: Kantarell ★5 — säsong
  jun–nov. Kom ihåg: ät aldrig svamp du inte är 100 % säker på." — **never** say "ätlig
  här", only "habitat för X". Include the species safety note from `/api/meta`.
- Privacy: location stays on device for the check, or is sent to own backend only.

## 2. AI chat — should it use the iPhone's own on-device AI? DECISION + hardwiring

**User question:** wire the in-app AI question into the iPhone's own AI (Apple Intelligence /
Foundation Models on-device)?

**Decision: NO for anything safety-critical.** Rationale to keep in the report:

- On-device models cannot enforce a controlled system prompt with the same reliability, and
  a hallucinated "yes, edible" for a deadly lookalike (vit flugsvamp, toppig giftspindling,
  murklor) is a manslaughter-grade failure mode. The server-side Mistral chat
  (`mistral-small-latest`, `SYSTEM_PROMPT` at `src/server.ts:13`) stays the **single
  authority** for any identification/edibility verdict.
- On-device AI may only be used for non-verdict convenience (rephrasing, Swedish grammar,
  summarizing), never to answer "är denna ätlig?".

**"Hardwired critical" requirement — implement in the server prompt + a guardrail pass:**

1. Always answer in Swedish.
2. **Never** confirm edibility from a text or photo description alone; require the user to
   verify against an independent field guide (e.g. Nya svampboken).
3. For every species mentioned, always name its deadly lookalikes in Sweden and what
   distinguishes them (ridged/branching åsar vs true skivor for kantarell/trattkantarell vs
   toppig giftspindling; vitt ådernät + rör for karljohan vs gallsopp; etc.).
4. Always state uncertainty explicitly ("jag kan inte vara säker på …").
5. Goliatmusseron = FRIDLYST/VU, never "plocka försiktigt". Murklor/Gyromitra, champinjoner,
   små Lepiota, vårmusseron/bolmörtsskivling, Cortinarius = never recommend.
6. Poisoning suspicion → Giftinformationscentralen, 112 vid akuta symtom.
7. **GEMINI FIGURES OUT** the mechanism: e.g. a two-pass self-critique (model must list
   check-failed risks before answering) plus a deterministic server-side refusal pattern
   list (if user text matches "är den ätlig/kan jag äta/ätbar" → answer with the fixed
   safety checklist, not a verdict).

## 3. Terrängskugga toggle — name and sharpness

- The hillshade layer exists (`/api/hillshade`, `/api/tiles/hillshade/...`) but was removed
  from the web UI because it looked too blurred.
- Re-add as a toggle named exactly **"Terrängskugga"** (Swedish UI label), default OFF.
- **GEMINI FIGURES OUT** the renderer changes to make it visibly sharper, not blurrier:
  reduce the blur radius/passes in the hillshade tile renderer (or render from the 2 m DEM
  unsmoothed), raise contrast/exaggeration, enable only at higher zoom (suggestion: z ≥ 12),
  and place it *under* the heat layer at ~15–20 % opacity so it adds terrain relief without
  muddying the hotspots.

## 4. Updated ideas / backlog (supersedes the previous list)

Quick web-UI wins: tap-to-inspect card from `/api/debug/cell`; preset pills "I säsong nu"
(month + local `gdd5` envelope filter) and "Nybörjarsäkra" (hide `protected`); dark Nordic
theme (#1D2B24 / #4F775A / #E89B2D); **Terrängskugga toggle (sharp, see §3)**; hot-core
glow in `renderHabitatTile`; date slider shows ISO date + "Nu" button.
**NEW: fläckvarning alert when passing an in-season habitat patch (§1).**
**NEW: AI answers hardwired critical, server-side only (§2).**
Backend/accuracy: `scripts/validate-auc.mjs` (`npm run validate`) scoring
`data/validation/observations.geojson` via `/api/debug/cell` → AUC per species/region;
real SMHI PTHBV 1991–2020 `smhi_gdd5.tif`; real SLU Skogskarta 10 m rasters; SGU berggrund
kalk layer for the calcareous pockets (tallblodriska/grynsopp/rödgul trumpetsvamp).
iOS `steho`: hybrid heat + `pin-<species>` icon mode (`/api/tiles/multi` + `/api/hotspots`),
"I din zon" from `/api/meta?lat&lon` gdd5, tap → `/api/debug/cell` card, **fläckvarning (§1)**,
offline PMTiles per län.
App Store: HTTPS backend origin, attribution screen (NV/SGU/SMHI/SLU/OSM/GBIF), privacy
label (no accounts, location in-flight only), PR #1 from draft to ready.

## 5. Hard constraints for any code you write

- User's Mac: always `cd ~/Projects/mushroom` first; **never put inline `#` comments in
  paste blocks** (breaks their zsh); `.env` is git-ignored and never iCloud-synced.
- `gdalwarp` needs `-overwrite` or `rm -f` when the target exists.
- `npm run demo-data` must never clobber real data (skips existing files unless `--force`).
- `date` query param is ISO `YYYY-MM-DD` only (e.g. `2026-09-10`), max 120 days back.
- Overpass/OSM-API/Geofabrik/SLU/SGU/NV download hosts are blocked from the build sandbox and
  from the user's Mac — NMD mask + offline `osm-bake` path only.
- Typecheck gate: `npm run typecheck` must pass. Deliver = commit + push to
  `vibe/mistral-chat-df5813` (PR #1 updates in place).

## 6. Open questions for Gemini

1. Fläckvarning: significant-location polling vs re-registered circular regions — pick one,
   justify battery cost, and specify the exact background-mode entitlements.
2. Should `/api/hotspots` grow a `lat/lon/radius` form, or is bbox enough?
3. Exact two-pass critical-answer prompt in Swedish + the deterministic refusal patterns.
4. Hillshade renderer parameters that keep Terrängskugga sharp at z 12–16.
5. AUC validation: which species/region splits, and what AUC threshold triggers recalibration?
