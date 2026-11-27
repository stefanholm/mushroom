// D1-endpoints i Workern: signaler/topplista/privacy/ents — samma kontrakt som
// Node-originen (src/signals.ts), med kolumnen app_id från dag 1 (systerappar).
import type { D1DatabaseLike, Env } from "./cf-types.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  device TEXT NOT NULL,
  alias TEXT NOT NULL,
  species TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  grid_lat REAL NOT NULL, grid_lon REAL NOT NULL,
  score REAL NOT NULL, kind TEXT NOT NULL DEFAULT 'report',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_app ON signals(app_id, at);
CREATE INDEX IF NOT EXISTS idx_signals_grid ON signals(app_id, grid_lat, grid_lon);
CREATE TABLE IF NOT EXISTS devices (
  app_id TEXT NOT NULL, device TEXT NOT NULL, ents TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL, PRIMARY KEY (app_id, device)
);
`;

let schemaReady = false;
async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.exec(SCHEMA_SQL);
  schemaReady = true;
}

const DAY_MS = 86400000;
const CELL_DEG = 0.05;
function aliasFor(device: string, appId: string): string {
  // enkel deterministisk alias utan crypto (Workers har crypto.subtle — använd detta i prod)
  let h = 2166136261;
  const s = appId + "|" + device;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "svamp-" + (h >>> 0).toString(36);
}

export async function getEnts(env: Env, device: string): Promise<string[]> {
  if (!device) return [];
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT ents FROM devices WHERE app_id=? AND device=?")
    .bind(env.APP_ID ?? "svampradar", device).first<{ ents: string }>();
  try { return row ? JSON.parse(row.ents) : []; } catch { return []; }
}
export async function setEnts(env: Env, device: string, ents: string[]): Promise<void> {
  if (!device) return;
  await ensureSchema(env);
  await env.DB.prepare("INSERT INTO devices(app_id, device, ents, updated_at) VALUES(?,?,?,?) ON CONFLICT(app_id, device) DO UPDATE SET ents=excluded.ents, updated_at=excluded.updated_at")
    .bind(env.APP_ID ?? "svampradar", device, JSON.stringify(ents), Date.now()).run();
}

// ?ents= från klienten accepteras bara i dev (ORIGIN_URL satt). I prod kommer ents från
// /api/verify-receipt (App Store Server API) -> devices-tabellen.
export async function resolveEnts(req: Request, env: Env): Promise<string[]> {
  const url = new URL(req.url);
  const device = url.searchParams.get("device") ?? "";
  const stored = await getEnts(env, device);
  const fromQuery = (url.searchParams.get("ents") ?? url.searchParams.get("entitlements") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((e) => (/^topspots\.\d{4}$/.test(e) ? "topspots:" + e.slice(9) : e)); // samma normalisering som Node
  const allowQuery = !!env.ORIGIN_URL; // dev-läge
  const all = new Set<string>([...stored, ...(allowQuery ? fromQuery : [])]);
  return [...all];
}

export async function reportSignal(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const device = String(body?.device ?? "");
  const species = String(body?.species ?? "");
  const lat = Number(body?.lat), lon = Number(body?.lon);
  if (!device || !species || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "device, species, lat, lon krävs" }, { status: 400 });
  }
  const at = Date.now();
  // anti-cheat (förenklad port av src/signals.ts): travel > 250 km/h -> 403, dygnscap 100
  const last = await env.DB.prepare(
    "SELECT lat, lon, at FROM signals WHERE app_id=? AND device=? ORDER BY at DESC LIMIT 1",
  ).bind(env.APP_ID ?? "svampradar", device).first<{ lat: number; lon: number; at: number }>();
  if (last) {
    const dtH = (at - last.at) / 3600000;
    const dLat = lat - last.lat, dLon = (lon - last.lon) * Math.cos((lat * Math.PI) / 180);
    const km = Math.sqrt(dLat * dLat + dLon * dLon) * 111;
    if (dtH > 0 && km / dtH > 250) return Response.json({ error: "Orealistisk förflyttning." }, { status: 403 });
  }
  const dayStart = at - (at % DAY_MS);
  const cnt = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM signals WHERE app_id=? AND device=? AND at>=?",
  ).bind(env.APP_ID ?? "svampradar", device, dayStart).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 100) return Response.json({ error: "Dagsgränsen nådd." }, { status: 429 });
  const score = Math.max(0, Math.min(100, Number(body?.score ?? 0) || 0));
  await env.DB.prepare(
    "INSERT INTO signals(app_id, device, alias, species, lat, lon, grid_lat, grid_lon, score, kind, at) VALUES(?,?,?,?,?,?,?,?,?,? ,?)",
  ).bind(
    env.APP_ID ?? "svampradar", device, aliasFor(device, env.APP_ID ?? "svampradar"), species,
    lat, lon, Math.round(lat / CELL_DEG) * CELL_DEG, Math.round(lon / CELL_DEG) * CELL_DEG,
    score, String(body?.kind ?? "report"), at,
  ).run();
  return Response.json({ ok: true });
}

export async function leaderboard(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? 5) || 5));
  const since = Date.now() - days * DAY_MS;
  const rows = await env.DB.prepare(
    "SELECT alias, SUM(score) AS s, COUNT(*) AS n FROM signals WHERE app_id=? AND at>=? GROUP BY alias ORDER BY s DESC LIMIT 10",
  ).bind(env.APP_ID ?? "svampradar", since).all<{ alias: string; s: number; n: number }>();
  return Response.json({ days, leaderboard: rows.results });
}

export async function myScore(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const device = url.searchParams.get("device") ?? "";
  if (!device) return Response.json({ error: "device krävs" }, { status: 400 });
  await ensureSchema(env);
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? 5) || 5));
  const since = Date.now() - days * DAY_MS;
  const row = await env.DB.prepare(
    "SELECT alias, SUM(score) AS s, COUNT(*) AS n FROM signals WHERE app_id=? AND device=? AND at>=? GROUP BY alias",
  ).bind(env.APP_ID ?? "svampradar", device, since).first<{ alias: string; s: number; n: number }>();
  return Response.json({ days, alias: aliasFor(device, env.APP_ID ?? "svampradar"), score: row?.s ?? 0, finds: row?.n ?? 0 });
}

export async function deleteDevice(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const device = url.searchParams.get("device") ?? "";
  if (!device) return Response.json({ error: "device krävs" }, { status: 400 });
  await ensureSchema(env);
  const app = env.APP_ID ?? "svampradar";
  await env.DB.prepare("DELETE FROM signals WHERE app_id=? AND device=?").bind(app, device).run();
  await env.DB.prepare("DELETE FROM devices WHERE app_id=? AND device=?").bind(app, device).run();
  return Response.json({ ok: true, deleted: true }); // idempotent
}

export type { D1DatabaseLike };
