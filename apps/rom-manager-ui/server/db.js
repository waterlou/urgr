import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { dbPath as defaultDbPath } from './paths.js';

let db = null;
let dbFilePath = null;
let SQL = null;

async function ensureSqlJs() {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}
await ensureSqlJs();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS set_versions (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    version     TEXT NOT NULL,
    dir         TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(source, version)
);

CREATE TABLE IF NOT EXISTS games (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    year            TEXT,
    manufacturer    TEXT,
    platform        TEXT DEFAULT '',
    parent_game_id  INTEGER,
    synopsis        TEXT DEFAULT '',
    title_id        TEXT,
    content_id      TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS game_rom_sets (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL,
    version_id      INTEGER NOT NULL,
    romof           TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES set_versions(id),
    UNIQUE(game_id, version_id)
);

CREATE TABLE IF NOT EXISTS game_rom_files (
    id              INTEGER PRIMARY KEY,
    rom_set_id      INTEGER NOT NULL,
    filename        TEXT NOT NULL,
    size            INTEGER,
    crc32           TEXT,
    md5             TEXT,
    sha1            TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    merge_target    TEXT,
    subtype         TEXT DEFAULT 'game',
    pkg_url         TEXT DEFAULT '',
    FOREIGN KEY (rom_set_id) REFERENCES game_rom_sets(id) ON DELETE CASCADE,
    UNIQUE(rom_set_id, filename)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
CREATE INDEX IF NOT EXISTS idx_rom_sets_version ON game_rom_sets(version_id);
CREATE INDEX IF NOT EXISTS idx_rom_sets_game ON game_rom_sets(game_id);
CREATE INDEX IF NOT EXISTS idx_rom_files_set ON game_rom_files(rom_set_id);
CREATE INDEX IF NOT EXISTS idx_rom_files_sha1 ON game_rom_files(sha1);
CREATE INDEX IF NOT EXISTS idx_rom_files_crc32 ON game_rom_files(crc32);

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
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_slug ON collections(slug);

CREATE TABLE IF NOT EXISTS collection_versions (
    id            INTEGER PRIMARY KEY,
    collection_id INTEGER NOT NULL,
    version_id    INTEGER NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES set_versions(id),
    UNIQUE(collection_id, version_id)
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
    game_set_id   INTEGER NOT NULL,
    game_id       INTEGER NOT NULL,
    FOREIGN KEY (game_set_id) REFERENCES game_sets(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_media (
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL DEFAULT '',
    synopsis    TEXT DEFAULT '',
    covers      TEXT DEFAULT '[]',
    screenshots TEXT DEFAULT '[]',
    videos      TEXT DEFAULT '[]',
    scraped_at  TEXT,
    PRIMARY KEY (name, platform)
);

CREATE TABLE IF NOT EXISTS game_state (
    game_id         INTEGER PRIMARY KEY,
    available       INTEGER NOT NULL DEFAULT 0,
    rating          INTEGER NOT NULL DEFAULT 0,
    favourite       INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(id)
);

CREATE INDEX IF NOT EXISTS idx_game_state_favourite ON game_state(favourite);
CREATE INDEX IF NOT EXISTS idx_game_state_available ON game_state(available);
CREATE INDEX IF NOT EXISTS idx_game_state_game ON game_state(game_id);

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
    collection_id   INTEGER NOT NULL,
    version_id      INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'not_started',
    format          TEXT NOT NULL DEFAULT 'split',
    games_total     INTEGER DEFAULT 0,
    games_built     INTEGER DEFAULT 0,
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES set_versions(id),
    UNIQUE(collection_id, version_id)
);

CREATE TABLE IF NOT EXISTS download_queue (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL,
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
    completed_at    TEXT,
    FOREIGN KEY (game_id) REFERENCES games(id)
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

CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_collection ON operations(collection_id);
`;

export function initDb(dbPath) {
  const resolved = path.resolve(dbPath || defaultDbPath);
  dbFilePath = resolved;

  if (fs.existsSync(resolved)) {
    const buffer = fs.readFileSync(resolved);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);

  // Migration: add videos column to game_media
  try { db.run("ALTER TABLE game_media ADD COLUMN videos TEXT DEFAULT '[]'"); } catch (_) {}
  // Migration: add scrape_mode column to collections
  try { db.run("ALTER TABLE collections ADD COLUMN scrape_mode TEXT DEFAULT 'auto'"); } catch (_) {}

  // Create recently_played table (simple cross-version list)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS recently_played (
      game_id   INTEGER PRIMARY KEY,
      played_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) {}

  // Mark orphaned operations as failed
  try {
    db.run("UPDATE operations SET status='failed', error='Server restarted' WHERE status IN ('pending','running')");
  } catch (_) {}

  return db;
}

export function saveDb() {
  if (db && dbFilePath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  }
}

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
  if (db && dbFilePath && fs.existsSync(dbFilePath)) {
    db.close();
    const buffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(buffer);
    db.run('PRAGMA foreign_keys = ON');
  }
}
