import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db = null;
let dbFilePath = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS set_versions (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    version     TEXT NOT NULL,
    dir         TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(source, version)
);

CREATE TABLE IF NOT EXISTS game_entries (
    id          INTEGER PRIMARY KEY,
    version_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    year        TEXT,
    manufacturer TEXT,
    cloneof     TEXT,
    FOREIGN KEY (version_id) REFERENCES set_versions(id) ON DELETE CASCADE,
    UNIQUE(version_id, name)
);

CREATE TABLE IF NOT EXISTS rom_entries (
    id              INTEGER PRIMARY KEY,
    game_entry_id   INTEGER NOT NULL,
    filename        TEXT NOT NULL,
    size            INTEGER,
    crc32           TEXT,
    md5             TEXT,
    sha1            TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    merge_target    TEXT,
    FOREIGN KEY (game_entry_id) REFERENCES game_entries(id) ON DELETE CASCADE,
    UNIQUE(game_entry_id, filename)
);

CREATE TABLE IF NOT EXISTS scanned_games (
    id          INTEGER PRIMARY KEY,
    version_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    sha1        TEXT,
    size        INTEGER,
    status      TEXT NOT NULL DEFAULT 'ok',
    FOREIGN KEY (version_id) REFERENCES set_versions(id) ON DELETE CASCADE,
    UNIQUE(version_id, name)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_game_entries_version ON game_entries(version_id);
CREATE INDEX IF NOT EXISTS idx_rom_entries_game ON rom_entries(game_entry_id);
CREATE INDEX IF NOT EXISTS idx_rom_entries_sha1 ON rom_entries(sha1);
CREATE INDEX IF NOT EXISTS idx_scanned_games_version ON scanned_games(version_id);

CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    platform    TEXT,
    logo        TEXT DEFAULT '',
    folder      TEXT,
    has_dataset INTEGER NOT NULL DEFAULT 0,
    dataset_preset TEXT,
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
    game_entry_id INTEGER NOT NULL,
    FOREIGN KEY (game_set_id) REFERENCES game_sets(id) ON DELETE CASCADE,
    FOREIGN KEY (game_entry_id) REFERENCES game_entries(id),
    UNIQUE(game_set_id, game_entry_id)
);

CREATE TABLE IF NOT EXISTS game_ratings (
    id            INTEGER PRIMARY KEY,
    game_entry_id INTEGER NOT NULL UNIQUE,
    rating        INTEGER DEFAULT 0,
    favourite     INTEGER NOT NULL DEFAULT 0,
    play_count    INTEGER DEFAULT 0,
    updated_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (game_entry_id) REFERENCES game_entries(id)
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
`;

export async function initDb(dbPath) {
  const SQL = await initSqlJs();
  const resolved = path.resolve(dbPath || path.join(__dirname, '..', '..', '..', 'data', 'roms.db'));
  dbFilePath = resolved;

  if (fs.existsSync(resolved)) {
    const buffer = fs.readFileSync(resolved);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run(SCHEMA);

  // No default seed data — start empty

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
