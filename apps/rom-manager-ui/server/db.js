import Database from 'better-sqlite3';
import path from 'path';
import { dbPath as defaultDbPath } from './paths.js';

let db = null;
let dbFilePath = null;

const SCHEMA = `

CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    platform    TEXT,
    logo        TEXT DEFAULT '',
    folder      TEXT,
    has_dataset INTEGER NOT NULL DEFAULT 0,
    dataset_preset TEXT,
    scrape_mode TEXT DEFAULT 'auto',
    scrape_source_priority TEXT DEFAULT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_slug ON collections(slug);

CREATE TABLE IF NOT EXISTS set_versions (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    version         TEXT NOT NULL,
    dir             TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(collection_id, version)
);
CREATE INDEX IF NOT EXISTS idx_sv_collection ON set_versions(collection_id);

CREATE TABLE IF NOT EXISTS games (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    year            TEXT,
    manufacturer    TEXT,
    platform        TEXT DEFAULT '',
    parent_game_id  INTEGER,
    synopsis        TEXT DEFAULT '',
    title_id        TEXT,
    content_id      TEXT,
    runnable        INTEGER,
    isbios          INTEGER NOT NULL DEFAULT 0,
    isdevice        INTEGER NOT NULL DEFAULT 0,
    driver_status   TEXT,
    driver_emulation TEXT,
    sampleof        TEXT,
    rom_source_id   INTEGER REFERENCES games(id),
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(collection_id, name, platform)
);
CREATE INDEX IF NOT EXISTS idx_games_collection ON games(collection_id);
CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);

CREATE TABLE IF NOT EXISTS game_rom_sets (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    version_id      INTEGER NOT NULL REFERENCES set_versions(id),
    romof           TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    available       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_rs_version ON game_rom_sets(version_id);
CREATE INDEX IF NOT EXISTS idx_rs_game ON game_rom_sets(game_id);

CREATE TABLE IF NOT EXISTS game_rom_files (
    id              INTEGER PRIMARY KEY,
    rom_set_id      INTEGER NOT NULL REFERENCES game_rom_sets(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    size            INTEGER,
    crc32           TEXT,
    md5             TEXT,
    sha1            TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    merge_target    TEXT,
    subtype         TEXT DEFAULT 'game',
    pkg_url         TEXT DEFAULT '',
    UNIQUE(rom_set_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_rf_set ON game_rom_files(rom_set_id);
CREATE INDEX IF NOT EXISTS idx_rf_sha1 ON game_rom_files(sha1);
CREATE INDEX IF NOT EXISTS idx_rf_crc32 ON game_rom_files(crc32);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS game_sets (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    icon        TEXT DEFAULT '',
    description TEXT DEFAULT '',
    platforms   TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_set_games (
    id            INTEGER PRIMARY KEY,
    game_set_id   INTEGER NOT NULL REFERENCES game_sets(id) ON DELETE CASCADE,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_media (
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL DEFAULT '',
    synopsis    TEXT DEFAULT '',
    covers      TEXT DEFAULT '[]',
    screenshots TEXT DEFAULT '[]',
    fanarts     TEXT DEFAULT '[]',
    videos      TEXT DEFAULT '[]',
    source      TEXT DEFAULT '',
    scraped_at  TEXT,
    PRIMARY KEY (name, platform)
);

CREATE TABLE IF NOT EXISTS game_state (
    game_id         INTEGER PRIMARY KEY REFERENCES games(id),
    available       INTEGER NOT NULL DEFAULT 0,
    rating          INTEGER NOT NULL DEFAULT 0,
    favourite       INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gs_favourite ON game_state(favourite);
CREATE INDEX IF NOT EXISTS idx_gs_available ON game_state(available);

CREATE TABLE IF NOT EXISTS scrape_jobs (
    id              TEXT PRIMARY KEY,
    status          TEXT NOT NULL DEFAULT 'running',
    total_games     INTEGER DEFAULT 0,
    scraped         INTEGER DEFAULT 0,
    skipped         INTEGER DEFAULT 0,
    failed          INTEGER DEFAULT 0,
    rate_limited    INTEGER DEFAULT 0,
    progress_msg    TEXT DEFAULT '',
    result          TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collection_builds (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    version_id      INTEGER NOT NULL REFERENCES set_versions(id),
    status          TEXT NOT NULL DEFAULT 'not_started',
    format          TEXT NOT NULL DEFAULT 'split',
    games_total     INTEGER DEFAULT 0,
    games_built     INTEGER DEFAULT 0,
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(collection_id, version_id)
);

CREATE TABLE IF NOT EXISTS download_queue (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL REFERENCES games(id),
    version_id      INTEGER NOT NULL,
    pkg_url         TEXT NOT NULL,
    filename        TEXT NOT NULL,
    file_size       INTEGER DEFAULT 0,
    expected_sha256 TEXT DEFAULT '',
    subtype         TEXT NOT NULL DEFAULT 'game',
    status          TEXT NOT NULL DEFAULT 'pending',
    progress        INTEGER DEFAULT 0,
    error           TEXT,
    retry_count     INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS operations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    collection_id   INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending',
    progress_pct    INTEGER DEFAULT 0,
    progress_msg    TEXT DEFAULT '',
    result          TEXT,
    error           TEXT,
    params          TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_ops_collection ON operations(collection_id);

CREATE TABLE IF NOT EXISTS recently_played (
    game_id   INTEGER PRIMARY KEY REFERENCES games(id),
    played_at TEXT DEFAULT (datetime('now'))
);

`;

export function initDb(dbPath) {
  const resolved = path.resolve(dbPath || defaultDbPath);
  dbFilePath = resolved;

  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Migrations: add columns that may not exist in older databases
  try { db.exec('ALTER TABLE games ADD COLUMN rom_source_id INTEGER REFERENCES games(id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_rom_source ON games(rom_source_id)'); } catch (_) {}

  // Mark orphaned operations as failed
  try {
    db.exec("UPDATE operations SET status='failed', error='Server restarted' WHERE status IN ('pending','running')");
  } catch (_) {}

  return db;
}

export function saveDb() {}

export function getDb() {
  return db;
}

export function getDbPath() {
  return dbFilePath;
}

export function closeDb() {
  if (db) db.close();
}

export function reloadDb() {
  if (db && dbFilePath) {
    db.close();
    db = new Database(dbFilePath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
  }
}
