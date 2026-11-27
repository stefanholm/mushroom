// test-local.mts — kör Workerns fetch-handler lokalt med mockad R2 (katalog på disk)
// och mockad D1 (node:sqlite). Ingen Cloudflare-inloggning behövs.
// Kör:  npx tsx worker/test-local.mts [seedDir]   (default /tmp/r2seed)
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "./src/index.js";
import type { Env } from "./src/cf-types.js";

const SEED = process.argv[2] ?? "/tmp/r2seed";

// --- mock R2 över katalog ---
const objects = new Map<string, { data: Buffer; contentType: string; cacheControl: string }>();
function walk(dir: string, prefix: string) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const key = prefix + f;
    if (fs.statSync(p).isDirectory()) walk(p, key + "/");
    else {
      const ext = f.endsWith(".png") ? "image/png" : "application/json; charset=utf-8";
      objects.set(key, { data: fs.readFileSync(p), contentType: ext, cacheControl: ext.includes("png") ? "public, max-age=31536000, immutable" : "public, max-age=300" });
    }
  }
}
walk(SEED, "");
console.log(`mock R2: ${objects.size} objekt från ${SEED}`);

const TILES = {
  async get(key: string) {
    const o = objects.get(key);
    if (!o) return null;
    return {
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(o.data)); c.close(); } }),
      size: o.data.length,
      httpMetadata: { contentType: o.contentType, cacheControl: o.cacheControl },
    };
  },
  async put(key: string, value: ArrayBuffer) {
    objects.set(key, { data: Buffer.from(value), contentType: key.endsWith(".png") ? "image/png" : "application/json", cacheControl: "mock" });
  },
  async list(options?: { prefix?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, options?.limit ?? 1000);
    return { objects: keys.map((key) => ({ key })) };
  },
};

// --- mock D1 över node:sqlite ---
const db = new DatabaseSync(":memory:");
const DB = {
  exec(sql: string) { db.exec(sql); return Promise.resolve(); },
  prepare(sql: string) {
    const stmt = db.prepare(sql);
    let vals: unknown[] = [];
    return {
      bind(...v: unknown[]) { vals = v; return this; },
      async first(col?: string) {
        const row = stmt.get(...(vals as never[])) as Record<string, unknown> | null;
        if (!row) return null;
        return (col ? row[col] : row) as never;
      },
      async all() { return { results: stmt.all(...(vals as never[])) as never[] }; },
      async run() { stmt.run(...(vals as never[])); return {}; },
    };
  },
};

const env: Env = { TILES: TILES as never, DB: DB as never, DEFAULT_TILE_REV: "r15", APP_ID: "svampradar", FREE_HIDE_FRACTION: "0.3", ORIGIN_URL: "http://127.0.0.1:3100" };

let pass = 0, fail = 0;
const ck = (n: string, c: boolean, x = "") => { if (c) { pass++; console.log("OK  ", n, x); } else { fail++; console.log("FAIL", n, x); } };
async function call(path: string, init?: RequestInit) {
  const res = await worker.fetch(new Request("https://api.svampradar.se" + path, init), env, { waitUntil() {} } as never);
  let body: unknown = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text.slice(0, 40); }
  return { status: res.status, body, headers: res.headers };
}

// manifest från R2
let r = await call("/manifest.json");
ck("manifest.json från R2", r.status === 200 && (r.body as { tileRev?: string })?.tileRev === "r15", `tileRev=${(r.body as { tileRev?: string })?.tileRev}`);
ck("manifest immutable? (json -> max-age=300)", r.headers.get("cache-control")?.includes("max-age=300") === true);

// hotspots från R2-block (kantarell, ents=all)
r = await call("/api/hotspots?bbox=17.3,58.9,18.5,59.7&static=1&species=kantarell&ents=all&maxP=50&minScore=55");
const pins = (r.body as { hotspots?: unknown[] })?.hotspots ?? [];
ck("hotspots från R2-block 200", r.status === 200 && pins.length > 0, `pins=${pins.length} source=${(r.body as { meta?: { source?: string } })?.meta?.source}`);
ck("alla pins inom bbox och >= minScore", pins.every((p) => (p as { lon: number; lat: number; score: number }).lon >= 17.3 && (p as { lon: number }).lon <= 18.5 && (p as { score: number }).score >= 55));

// hotspots låst utan ents (kantarell ej free)
r = await call("/api/hotspots?bbox=17.3,58.9,18.5,59.7&static=1&species=kantarell");
ck("hotspots 403 utan ents (kantarell låst)", r.status === 403 && Array.isArray((r.body as { locked?: string[] })?.locked), `status=${r.status}`);
// men årskort (klassiker) låser upp kantarell
r = await call("/api/hotspots?bbox=17.3,58.9,18.5,59.7&static=1&species=kantarell&ents=topspots.2026");
ck("hotspots 200 med årskort (klassiker)", r.status === 200 && ((r.body as { hotspots?: unknown[] })?.hotspots?.length ?? 0) > 0, `pins=${(r.body as { hotspots?: unknown[] })?.hotspots?.length}`);

// overview från R2
r = await call("/api/v1/fungi/overview?species=kantarell&static=1&ents=all&minScore=55");
const tiers = (r.body as { tiers?: Record<string, unknown[]> })?.tiers ?? {};
ck("overview från R2: tiers 55/18/6km", r.status === 200 && tiers["55km"]?.length > 0 && tiers["6km"]?.length > 0,
  `55km=${tiers["55km"]?.length} 18km=${tiers["18km"]?.length} 6km=${tiers["6km"]?.length}`);
ck("overview profile med", !!(r.body as { profiles?: Record<string, unknown> })?.profiles?.kantarell);

// bootstrap i worker
r = await call("/api/v1/bootstrap?species=kantarell&ents=all");
const f = (r.body as { fungi?: Record<string, { overviewCells?: unknown[]; zonePending?: boolean; rainWindowDays?: number }> })?.fungi?.kantarell;
ck("bootstrap: tileRev + fungi bundle", r.status === 200 && (r.body as { tileRev?: string })?.tileRev === "r15" && !!f && f.overviewCells!.length > 0,
  `cells=${f?.overviewCells?.length} win=${f?.rainWindowDays} zonePending=${f?.zonePending}`);
ck("bootstrap: shop + unlocked + leaderboard", !!(r.body as { shop?: unknown; unlocked?: { unlocked?: string[] } })?.shop && (r.body as { unlocked?: { unlocked?: string[] } })?.unlocked?.unlocked?.includes("kantarell"));

// edge /api/meta från catalog.json (AppModels.swift-kontrakt)
r = await call("/api/meta?species=kantarell&ents=all");
ck("edge /api/meta: speciesList 61 + tileRev + topSpots", r.status === 200 && (r.body as { speciesList?: unknown[] })?.speciesList?.length === 61 && (r.body as { tileRev?: string })?.tileRev === "r15" && !!(r.body as { topSpots?: unknown })?.topSpots,
  `species=${(r.body as { species?: string })?.species} tileRev=${(r.body as { tileRev?: string })?.tileRev}`);
r = await call("/api/meta?species=kantarell");
ck("edge /api/meta utan ents: kantarell locked i speciesList", (r.body as { speciesList?: { id: string; locked: boolean }[] })?.speciesList?.find((s) => s.id === "kantarell")?.locked === true);

// unlocked via ents
r = await call("/api/unlocked?device=dev1&ents=topspots.2026");
ck("unlocked: kantarell via årskort-klassiker", r.status === 200 && (r.body as { unlocked?: string[] })?.unlocked?.includes("kantarell"));
r = await call("/api/unlocked?device=dev1");
ck("unlocked utan ents: bara free 5", r.status === 200 && (r.body as { unlocked?: string[] })?.unlocked?.length === 5);

// D1: report-signal + leaderboard + privacy delete
r = await call("/api/report-signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "dev1", species: "kantarell", lat: 59.3, lon: 18.1, score: 80 }) });
ck("report-signal 200 (D1)", r.status === 200 && (r.body as { ok?: boolean })?.ok === true);
r = await call("/api/leaderboard?device=dev1");
ck("leaderboard 200 med rad", r.status === 200 && ((r.body as { leaderboard?: unknown[] })?.leaderboard?.length ?? 0) === 1);
r = await call("/api/privacy/delete?device=dev1", { method: "DELETE" });
ck("privacy/delete 200 idempotent", r.status === 200 && (r.body as { ok?: boolean })?.ok === true);
r = await call("/api/leaderboard?device=dev1");
ck("leaderboard tom efter delete", ((r.body as { leaderboard?: unknown[] })?.leaderboard?.length ?? 0) === 0);

// okänd route proxas till origin när ORIGIN_URL är satt (dev), annars 404 från Workern
r = await call("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ck("okänd route proxas till origin (ej worker-404)", r.status !== 404, `status=${r.status}`);
{
  const envNoOrigin: Env = { ...env, ORIGIN_URL: "" };
  const res2 = await worker.fetch(new Request("https://api.svampradar.se/api/chat", { method: "POST", body: "{}" }), envNoOrigin, { waitUntil() {} } as never);
  ck("utan ORIGIN_URL: 404 från Workern", res2.status === 404, `status=${res2.status}`);
}

// PNG-enkodern (smoke)
const { encodePng } = await import("./src/png.js");
const png = await encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(128));
ck("png encoder: signatur OK", png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71, `bytes=${png.length}`);

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
