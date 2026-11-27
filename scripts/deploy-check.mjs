// deploy-check.mjs — kör hela verifierings-checklistan mot en backend (Worker ELLER lokal Node).
//   node scripts/deploy-check.mjs                          # prod Worker
//   node scripts/deploy-check.mjs --base http://127.0.0.1:3000
// Exit 0 om inga FAIL; WARN är ok (t.ex. frames från cron ännu inte bakade).
import process from "node:process";

const args = process.argv.slice(2);
const baseArg = args.indexOf("--base");
const BASE = (baseArg >= 0 ? args[baseArg + 1] : "https://svampradar.natureradar-se.workers.dev").replace(/\/$/, "");
const SPECIES = args.includes("--species") ? args[args.indexOf("--species") + 1] : "blek-taggsvamp";
const BBOX = "17.3,58.9,18.5,59.7";

let pass = 0, warn = 0, fail = 0;
function report(kind, name, extra = "") {
  if (kind === "PASS") { pass++; console.log(`PASS ${name} ${extra}`); }
  else if (kind === "WARN") { warn++; console.log(`WARN ${name} ${extra}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function get(path, opts = {}) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(25000), ...opts });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 60); }
  return { status: r.status, body, headers: r.headers, text };
}

// --- lokal config-kontroll först: fånga placeholders innan deploy/wrangler gör det ---
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tomlPath = path.join(root, "worker", "wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    const toml = fs.readFileSync(tomlPath, "utf8");
    const dbId = /database_id\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
    const bucket = /bucket_name\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
    if (!dbId || dbId.includes("FYLL") || !/^[0-9a-f-]{36}$/.test(dbId)) {
      report("FAIL", "wrangler.toml database_id", `saknas/placeholder: "${dbId || "(tom)"}" — deploy ger [code: 10021]; sätt riktigt ID från Cloudflare-dash`);
    } else report("PASS", "wrangler.toml database_id", dbId);
    if (!bucket || bucket.includes("svampradar-tiles")) report("FAIL", "wrangler.toml bucket_name", `"${bucket}" — ska vara natureradar-data`);
    else report("PASS", "wrangler.toml bucket_name", bucket);
  } else {
    report("WARN", "wrangler.toml", "hittades inte (körs utanför repot?)");
  }
}

console.log(`deploy-check mot ${BASE} (art=${SPECIES})\n`);

let r = await get("/manifest.json").catch((e) => ({ status: 0, body: null, error: e }));
if (r.status === 200 && r.body?.tileRev) report("PASS", "manifest.json", `tileRev=${r.body.tileRev}`);
else report("FAIL", "manifest.json", `status=${r.status}`);
const MANIFEST = r.status === 200 ? r.body : null;

r = await get("/api/v1/catalog");
if (r.status === 200 && r.body?.species?.length === 61) report("PASS", "catalog.json i R2", `arter=${r.body.species.length}`);
else report("FAIL", "catalog.json i R2", `status=${r.status} — UTAN catalog 404:ar shop/unlocked/overview/hotspots/meta! Kör: npm run bake-root && node scripts/sync-r2.mjs --rev r15 --only root`);

r = await get(`/api/v1/bootstrap?species=${SPECIES}&ents=all`);
if (r.status === 200 && r.body?.shop && r.body?.unlocked && Array.isArray(r.body?.rainSpans) && r.body?.fungi?.[SPECIES]) {
  report("PASS", "bootstrap", `rainSpans=${r.body.rainSpans} fungi=${Object.keys(r.body.fungi ?? {}).join(",")} zone=${r.body.fungi[SPECIES].zone ? "JA" : "null/pending"}`);
} else report(r.status === 200 ? "WARN" : "FAIL", "bootstrap", `status=${r.status} shop=${!!r.body?.shop} unlocked=${!!r.body?.unlocked} rainSpans=${r.body?.rainSpans} fungi=${!!r.body?.fungi}`);

r = await get(`/api/meta?species=${SPECIES}&fast=1&ents=all`);
report(r.status === 200 && r.body?.speciesList?.length === 61 ? "PASS" : "FAIL", "meta", `speciesList=${r.body?.speciesList?.length} tileRev=${r.body?.tileRev}`);

r = await get(`/api/v1/fungi/overview?species=${SPECIES}&static=1&ents=all`);
const tk = r.body?.tiers ? Object.keys(r.body.tiers) : [];
report(r.status === 200 && tk.includes("55km") && tk.includes("18km") && tk.includes("6km") && typeof r.body?.goldPeaks === "number" ? "PASS" : "FAIL",
  "overview", `status=${r.status} tiers=${tk.join("/")} goldPeaks=${r.body?.goldPeaks} pins6km=${r.body?.tiers?.["6km"]?.length}`);

r = await get(`/api/hotspots?bbox=${BBOX}&static=1&species=${SPECIES}&ents=all&maxP=20`);
const n = r.body?.hotspots?.length ?? -1;
report(r.status === 200 && n > 0 ? "PASS" : r.status === 200 ? "WARN" : "FAIL", "hotspots",
  `status=${r.status} pins=${n} source=${r.body?.meta?.source ?? "-"} ${r.status === 404 ? "(404 = catalog saknas ELLER worker ej deployad — se catalog-checken ovan)" : "(0 pins = block saknas/nyckelschema fel — kör bake-blocks + sync-r2)"}`);

r = await get(`/api/v1/fungi/optimal-zone?species=${SPECIES}&static=1&ents=all`);
report(r.status === 200 ? (r.body?.optimalZone ? "PASS" : "WARN") : "FAIL", "optimal-zone",
  `status=${r.status} zone=${r.body?.optimalZone ? "JA" : "null"} (null OK utanför säsong, men vid static=1 bör zones/*.json vara synkad — kör bake-zones + sync)`);

// tile-probe: prova flera kandidater (hardcoded default + manifest-bounds-center + Mälardalen r15)
// sa WARN bara betyder "inga tiles i nagot probat omrade" (r15 täcker t.ex. bara Mälardalen)
{
  const cands = ["/api/tiles/hillshade/8/136/84.png", "/api/tiles/hillshade/8/140/75.png"];
  const b = MANIFEST?.bounds;
  if (Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(Number(v)))) {
    const z = 8, n = 2 ** z;
    const lon = (Number(b[0]) + Number(b[2])) / 2, lat = (Number(b[1]) + Number(b[3])) / 2;
    const x = Math.floor(((lon + 180) / 360) * n);
    const rad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    cands.push(`/api/tiles/hillshade/${z}/${x}/${y}.png`);
    cands.push(`/api/tiles/habitat/${SPECIES}/${z}/${x}/${y}.png?static=1`);
  }
  cands.push(`/api/tiles/habitat/${SPECIES}/8/140/75.png?static=1`); // Mälardalen r15
  let hit = null, reported = false;
  for (const p of cands) {
    const rr = await get(p);
    if (rr.status === 200 && (rr.headers.get("content-type") ?? "").includes("png")) { hit = p; break; }
    if (rr.status !== 404 && rr.status !== 200) { report("FAIL", "tile png", `status=${rr.status} ${p}`); reported = true; break; }
  }
  if (hit) report("PASS", "tile png", `200 png via ${hit}`);
  else if (!reported) report("WARN", "tile png", `404 pa alla kandidater (${cands.join(", ")}) — diagnostik: rclone lsf r2:natureradar-data/domains/fungi/r15/tiles/ | head + find data/tile-cache/r15 -name '*.png' | wc -l ; sedan: node scripts/sync-r2.mjs --rev r15 --only tiles (se att den INTE skriver 'hoppar över')`);
}

r = await get(`/icons/${SPECIES}.png`);
report(r.status === 200 && (r.headers.get("content-type") ?? "").includes("png") ? "PASS" : r.status === 404 ? "WARN" : "FAIL", "icon png", `status=${r.status} type=${r.headers.get("content-type")} (404 = icons ej synkade: node scripts/sync-r2.mjs --rev r15 --only icons)`);

r = await get(`/api/v1/weather/clouds/manifest`);
report(r.status === 200 && (r.body?.frames?.length ?? 0) > 0 ? "PASS" : r.status === 404 || r.status === 502 ? "WARN" : "FAIL", "clouds manifest", `status=${r.status} frames=${r.body?.frames?.length}`);

r = await get(`/api/v1/weather/rain-history/manifest?days=28`);
report(r.status === 200 && (r.body?.frames?.length ?? 0) > 0 ? "PASS" : r.status === 404 || r.status === 502 ? "WARN" : "FAIL", "rain manifest 28d", `status=${r.status} frames=${r.body?.frames?.length} (cron inom 6 h annars)`);

r = await get(`/api/unlocked?device=deploycheck&ents=all`);
report(r.status === 200 && Array.isArray(r.body?.unlocked) ? "PASS" : "FAIL", "unlocked", `n=${r.body?.unlocked?.length}`);

r = await get(`/api/hotspots?bbox=${BBOX}&static=1&species=kantarell`, {});
report(r.status === 403 ? "PASS" : "WARN", "403 låst art utan ents", `status=${r.status} (kantarell ska ge 403 för free)`);

r = await get(`/api/report-signal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "deploycheck", species: SPECIES, lat: 59.3, lon: 18.1, score: 50 }) });
report(r.status === 200 && r.body?.ok ? "PASS" : "WARN", "report-signal (D1)", `status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)} ${r.status === 502 ? "(502 = D1 legacy-schema eller saknat schema — kör: npx wrangler d1 execute svampradar-db --remote --command \"DROP TABLE IF EXISTS signals; DROP TABLE IF EXISTS devices; DROP TABLE IF EXISTS profiles; DROP TABLE IF EXISTS reward_ledger;\" följt av: npx wrangler d1 execute svampradar-db --remote --file=worker/schema.sql)" : ""}`);

console.log(`\n${pass} PASS, ${warn} WARN, ${fail} FAIL — ${BASE}`);
process.exit(fail > 0 ? 1 : 0);
