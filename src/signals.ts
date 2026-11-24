// Anonyma svampfynd ("signals") + topplista — persistent lagring i SQLite (node:sqlite),
// redo att port:a till Cloudflare D1 i produktion. Lagrar ALDRIG exakt GPS, bara 0.05°
// (≈5×5 km) rutor. Anti-fusk: omöjlig restid per enhet, nattkontroll (solhöjd < -6° → 0 p),
// dygnstak per enhet, viktning efter modellbehov (blinda fläckar, habitat, kantsäsong, helg).
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const CELL_DEG = 0.05; // ≈5×5 km i Sverige
const MAX_SPEED_KMH = 250;
const NIGHT_SUN_ELEV_DEG = -6; // civil skymning
const BASE_POINTS = 10;
const DAILY_CAP = 100;
const TRAVEL_LOOKBACK_MS = 24 * 3600 * 1000;

const ALIASES = [
  "Hamm", "Räv", "Uggla", "Älg", "Bäver", "Orre", "Tjäder", "Mård", "Grävling", "Huggorm",
  "Lom", "Falk", "Morkulla", "Rådjur", "Gris", "Varg", "Lo", "Fiskmås", "Tran", "Blåsmes",
];

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  const dir = path.join(here, "..", "data");
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "signals.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dev TEXT NOT NULL,
      alias TEXT NOT NULL,
      species TEXT NOT NULL,
      cellLat REAL NOT NULL,
      cellLon REAL NOT NULL,
      at INTEGER NOT NULL,
      points REAL NOT NULL,
      flags TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_signals_at ON signals(at);
    CREATE INDEX IF NOT EXISTS idx_signals_dev ON signals(dev);
    CREATE INDEX IF NOT EXISTS idx_signals_cell ON signals(cellLat, cellLon);
    CREATE TABLE IF NOT EXISTS devmeta (
      dev TEXT PRIMARY KEY,
      lastCellLat REAL, lastCellLon REAL, lastAt INTEGER,
      today TEXT, todayPoints REAL NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export function cellOf(v: number): number {
  return Math.floor(v / CELL_DEG) * CELL_DEG;
}

export function aliasFor(dev: string): string {
  const h = crypto.createHash("sha256").update("svampradar:" + dev).digest();
  return ALIASES[h[0] % ALIASES.length];
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Solhöjd (grad) för lat/lon vid tidpunkt — enkel SPA-approximation, räcker för dag/natt-koll.
export function sunElevationDeg(lat: number, lon: number, atMs: number): number {
  const d = new Date(atMs);
  const dayOfYear = Math.floor((atMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const decl = (23.44 * Math.PI) / 180 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const hourAngle = (15 * (utcHours - 12) + lon) * Math.PI / 180;
  const latR = (lat * Math.PI) / 180;
  const sinElev = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) * 180 / Math.PI;
}

export type ReportInput = {
  device: string;
  species: string;
  lat: number;
  lon: number;
  habitatScore?: number | null; // 0..1 från staticHabitatScore i anroparens cell
  seasonFactor?: number | null; // 0..1 för arten just nu
};

export type ReportResult =
  | { ok: true; points: number; flags: string[]; alias: string; cellLat: number; cellLon: number }
  | { ok: false; status: number; error: string };

export function reportSignal(input: ReportInput, nowMs = Date.now()): ReportResult {
  const { device, species, lat, lon } = input;
  if (!device || typeof device !== "string") return { ok: false, status: 400, error: "device krävs" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, status: 400, error: "lat/lon krävs" };
  if (lat < 54.5 || lat > 70 || lon < 10 || lon > 25.5) {
    return { ok: false, status: 400, error: " utanför Sverige" };
  }
  const database = getDb();
  const cellLat = cellOf(lat);
  const cellLon = cellOf(lon);
  const alias = aliasFor(device);
  const flags: string[] = [];

  // Anti-fusk 1: omöjlig restid — samma enhet på två rutor långt ifrån inom kort tid.
  const meta = database
    .prepare("SELECT lastCellLat, lastCellLon, lastAt, today, todayPoints FROM devmeta WHERE dev = ?")
    .get(device) as { lastCellLat: number | null; lastCellLon: number | null; lastAt: number | null; today: string | null; todayPoints: number } | undefined;
  if (meta?.lastAt && nowMs > meta.lastAt && nowMs - meta.lastAt < TRAVEL_LOOKBACK_MS) {
    const dist = haversineKm(meta.lastCellLat!, meta.lastCellLon!, cellLat, cellLon);
    const hours = (nowMs - meta.lastAt) / 3600000;
    if (hours > 0 && dist / hours > MAX_SPEED_KMH) {
      return { ok: false, status: 403, error: "orimlig_restid" };
    }
  }

  // Anti-fusk 2: astronomisk dagsljuskontroll — 0 p mitt i natten på den rut+datum.
  const elev = sunElevationDeg(lat, lon, nowMs);
  let points = BASE_POINTS;
  if (elev < NIGHT_SUN_ELEV_DEG) {
    points = 0;
    flags.push("natt");
  } else {
    // Viktning efter modellbehov: blinda fläckar (få fynd i rutan senaste 14 d) väger tyngre.
    const since = nowMs - 14 * 86400000;
    const cellCount = (database
      .prepare("SELECT COUNT(*) AS n FROM signals WHERE cellLat = ? AND cellLon = ? AND at >= ?")
      .get(cellLat, cellLon, since) as { n: number }).n;
    if (cellCount < 3) {
      points *= 1.5;
      flags.push("blindfläck");
    }
    // Habitatbekräftelse: arten trivs faktiskt här enligt modellen.
    if (input.habitatScore !== null && input.habitatScore !== undefined && input.habitatScore >= 0.7) {
      points *= 1.25;
      flags.push("habitatbekräftelse");
    }
    // Kantsäsong: art precis i början/slutet av sin säsong är extra värdefull.
    const sf = input.seasonFactor;
    if (sf !== null && sf !== undefined && sf > 0 && sf < 0.9) {
      points *= 1.2;
      flags.push("kantsäsong");
    }
    // Subtil vardag/helg-rimlighet.
    const dow = new Date(nowMs).getUTCDay();
    if (dow === 0 || dow === 6) {
      points *= 1.1;
      flags.push("helg");
    }
    // Dygnstak per enhet.
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const todayPoints = meta && meta.today === today ? meta.todayPoints : 0;
    if (todayPoints + points > DAILY_CAP) {
      points = Math.max(0, DAILY_CAP - todayPoints);
      flags.push("dygnstak");
    }
    points = Math.round(points * 10) / 10;
  }
  // Spara fyndet (alltid, även 0 p — statistiken är värdefull) och uppdatera enhets-meta.
  database
    .prepare("INSERT INTO signals (dev, alias, species, cellLat, cellLon, at, points, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(device, alias, species, cellLat, cellLon, nowMs, points, flags.join(","));
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const todayPoints = meta && meta.today === today ? meta.todayPoints : 0;
  database
    .prepare(
      "INSERT INTO devmeta (dev, lastCellLat, lastCellLon, lastAt, today, todayPoints) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(dev) DO UPDATE SET lastCellLat=excluded.lastCellLat, lastCellLon=excluded.lastCellLon, lastAt=excluded.lastAt, today=excluded.today, todayPoints=excluded.todayPoints",
    )
    .run(device, cellLat, cellLon, nowMs, today, todayPoints + points);
  return { ok: true, points, flags, alias, cellLat, cellLon };
}

export type LeaderboardRow = { rank: number; alias: string; points: number; finds: number };

export function leaderboard(days = 5, limit = 10, nowMs = Date.now()): LeaderboardRow[] {
  const since = nowMs - days * 86400000;
  const rows = getDb()
    .prepare(
      "SELECT alias, SUM(points) AS p, COUNT(*) AS n FROM signals WHERE at >= ? GROUP BY dev ORDER BY p DESC, n DESC LIMIT ?",
    )
    .all(since, limit) as { alias: string; p: number; n: number }[];
  return rows.map((r, i) => ({ rank: i + 1, alias: r.alias, points: Math.round(r.p * 10) / 10, finds: r.n }));
}

export function myScore(dev: string, days = 5, nowMs = Date.now()): { points: number; finds: number; rank: number | null } {
  const since = nowMs - days * 86400000;
  const database = getDb();
  const mine = database
    .prepare("SELECT COALESCE(SUM(points),0) AS p, COUNT(*) AS n FROM signals WHERE dev = ? AND at >= ?")
    .get(dev, since) as { p: number; n: number };
  const better = database
    .prepare("SELECT COUNT(*) AS c FROM (SELECT dev, SUM(points) AS p FROM signals WHERE at >= ? GROUP BY dev HAVING p > ?)")
    .get(since, mine.p) as { c: number };
  return { points: Math.round(mine.p * 10) / 10, finds: mine.n, rank: mine.n > 0 ? better.c + 1 : null };
}

export type NearbyFind = { species: string; at: number; points: number; cellLat: number; cellLon: number };

// Fynd (anonyma, från signals) inom radiusKm runt lat/lon sedan sinceMs.
export function nearbyFinds(lat: number, lon: number, radiusKm: number, sinceMs: number, nowMs = Date.now()): NearbyFind[] {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const rows = getDb()
    .prepare(
      "SELECT species, at, points, cellLat, cellLon FROM signals WHERE at >= ? AND cellLat BETWEEN ? AND ? AND cellLon BETWEEN ? AND ?",
    )
    .all(sinceMs, lat - dLat, lat + dLat, lon - dLon, lon + dLon) as NearbyFind[];
  return rows.filter((r) => haversineKm(lat, lon, r.cellLat + CELL_DEG / 2, r.cellLon + CELL_DEG / 2) <= radiusKm + 3);
}

// Alla fynd sedan sinceMs (för progressiva scope: area/part/sweden), senaste först, max limit.
export function allFinds(sinceMs: number, limit = 20000): NearbyFind[] {
  return getDb()
    .prepare("SELECT species, at, points, cellLat, cellLon FROM signals WHERE at >= ? ORDER BY at DESC LIMIT ?")
    .all(sinceMs, limit) as NearbyFind[];
}
