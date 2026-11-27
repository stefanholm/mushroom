-- D1-schema för Svampradar-Workern. app_id finns från dag 1 så systerappar
-- (bärradar, blomradar, pollenradar) kan dela samma databas utan kollisioner.
--
-- LEGACY-MIGRATION: om körningen failar med "no such column: ..." finns en gammal
-- tabell med annat schema (t.ex. profiles(app_id, device_uuid, username, points, ...)).
-- Pre-launch är det säkert att droppa och köra om, t.ex.:
--   npx wrangler d1 execute svampradar-db --remote --command "DROP TABLE IF EXISTS profiles;"
--   npx wrangler d1 execute svampradar-db --remote --file=worker/schema.sql
-- Workern själv-healar saknade kolumner via ALTER TABLE ADD COLUMN (se src/d1.ts),
-- men detta CLI-schema kräver att tabellerna antingen saknas eller har rätt kolumner.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  device TEXT NOT NULL,
  alias TEXT NOT NULL,
  species TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  grid_lat REAL NOT NULL,
  grid_lon REAL NOT NULL,
  score REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'report',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_app ON signals(app_id, at);
CREATE INDEX IF NOT EXISTS idx_signals_grid ON signals(app_id, grid_lat, grid_lon);

CREATE TABLE IF NOT EXISTS devices (
  app_id TEXT NOT NULL,
  device TEXT NOT NULL,
  ents TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, device)
);

-- Framtida: reward_ledger(app_id, device, kind, species, at) för betyg/referral-claims.
CREATE TABLE IF NOT EXISTS profiles (
  app_id TEXT NOT NULL,
  device TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, device)
);
CREATE TABLE IF NOT EXISTS reward_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  device TEXT NOT NULL,
  kind TEXT NOT NULL,
  species TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_app ON reward_ledger(app_id, device);
