-- D1-schema för Svampradar-Workern. app_id finns från dag 1 så systerappar
-- (bärradar, blomradar, pollenradar) kan dela samma databas utan kollisioner.
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
