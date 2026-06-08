import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

CREATE TABLE IF NOT EXISTS game_entries (
    id          INTEGER PRIMARY KEY,
    version_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    synopsis    TEXT DEFAULT '',
    year        TEXT,
    manufacturer TEXT,
    cloneof     TEXT,
    platform    TEXT DEFAULT '',
    title_id    TEXT,
    content_id  TEXT,
    region      TEXT DEFAULT '',
    covers      TEXT DEFAULT '[]',
    screenshots TEXT DEFAULT '[]',
    FOREIGN KEY (version_id) REFERENCES set_versions(id) ON DELETE CASCADE,
    UNIQUE(version_id, name, region)
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
    subtype         TEXT DEFAULT 'game',
    pkg_url         TEXT DEFAULT '',
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

CREATE TABLE IF NOT EXISTS game_state (
    game_entry_id INTEGER PRIMARY KEY,
    available     INTEGER NOT NULL DEFAULT 0,
    rating        INTEGER NOT NULL DEFAULT 0,
    favourite     INTEGER NOT NULL DEFAULT 0,
    play_count    INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (game_entry_id) REFERENCES game_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_game_state_favourite ON game_state(favourite);
CREATE INDEX IF NOT EXISTS idx_game_state_available ON game_state(available);

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
    game_entry_id   INTEGER NOT NULL,
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
    FOREIGN KEY (game_entry_id) REFERENCES game_entries(id)
);
`;

export function initDb(dbPath) {
  const resolved = path.resolve(dbPath || path.join(__dirname, '..', '..', '..', 'data', 'roms.db'));
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
  // Migration: add platform column if missing
  try { db.run("ALTER TABLE game_entries ADD COLUMN platform TEXT DEFAULT ''"); } catch (_) {}
  // Migration: add synopsis column if missing
  try { db.run("ALTER TABLE game_entries ADD COLUMN synopsis TEXT DEFAULT ''"); } catch (_) {}
  // Migration: add covers column if missing
  try { db.run("ALTER TABLE game_entries ADD COLUMN covers TEXT DEFAULT '[]'"); } catch (_) {}
  // Migration: add screenshots column if missing
  try { db.run("ALTER TABLE game_entries ADD COLUMN screenshots TEXT DEFAULT '[]'"); } catch (_) {}
  // Migration: add title_id and content_id columns to game_entries (NPS integration)
  try { db.run("ALTER TABLE game_entries ADD COLUMN title_id TEXT"); } catch (_) {}
  try { db.run("ALTER TABLE game_entries ADD COLUMN content_id TEXT"); } catch (_) {}
  // Migration: add subtype column to rom_entries (NPS integration)
  try { db.run("ALTER TABLE rom_entries ADD COLUMN subtype TEXT DEFAULT 'game'"); } catch (_) {}
  // Index on title_id (created after migrations add the column)
  try { db.run("CREATE INDEX IF NOT EXISTS idx_game_entries_title_id ON game_entries(title_id)"); } catch (_) {}
  // Migration: game_ratings -> game_state (consolidate app state table)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS game_state (
      game_entry_id INTEGER PRIMARY KEY,
      available     INTEGER NOT NULL DEFAULT 0,
      rating        INTEGER NOT NULL DEFAULT 0,
      favourite     INTEGER NOT NULL DEFAULT 0,
      play_count    INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (game_entry_id) REFERENCES game_entries(id)
    )`);
    // Check if game_ratings table exists before migrating
    const hasRatings = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='game_ratings'");
    if (hasRatings.length && hasRatings[0].values.length > 0) {
      db.run(`INSERT INTO game_state (game_entry_id, rating, favourite, play_count, updated_at)
              SELECT game_entry_id, COALESCE(rating, 0), COALESCE(favourite, 0), COALESCE(play_count, 0), updated_at
              FROM game_ratings`);
      db.run('DROP TABLE game_ratings');
    }
  } catch (_) {}

  // Migration: add region column and recreate game_entries with UNIQUE(version_id, name, region)
  try {
    const needsRebuild = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='game_entries'");
    const createSql = needsRebuild[0]?.values[0]?.[0] || '';
    if (!createSql.includes('region') || createSql.includes('UNIQUE(version_id, name)') || createSql.includes('UNIQUE(version_id, name, year)')) {
      try { db.run('DROP TABLE IF EXISTS game_entries_new'); } catch (_) {}
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`CREATE TABLE game_entries_new (
        id          INTEGER PRIMARY KEY,
        version_id  INTEGER NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        synopsis    TEXT DEFAULT '',
        year        TEXT,
        manufacturer TEXT,
        cloneof     TEXT,
        platform    TEXT DEFAULT '',
        title_id    TEXT,
        content_id  TEXT,
        region      TEXT DEFAULT '',
        covers      TEXT DEFAULT '[]',
        screenshots TEXT DEFAULT '[]',
        FOREIGN KEY (version_id) REFERENCES set_versions(id) ON DELETE CASCADE,
        UNIQUE(version_id, name, region)
      )`);
      db.run('INSERT INTO game_entries_new (id, version_id, name, description, synopsis, year, manufacturer, cloneof, platform, title_id, content_id, covers, screenshots) SELECT id, version_id, name, description, synopsis, year, manufacturer, cloneof, platform, title_id, content_id, covers, screenshots FROM game_entries');
      db.run('DROP TABLE game_entries');
      db.run('ALTER TABLE game_entries_new RENAME TO game_entries');
      db.run('CREATE INDEX IF NOT EXISTS idx_game_entries_title_id ON game_entries(title_id)');
      db.run('PRAGMA foreign_keys = ON');
    }
  } catch (_) {}

  // Migration: add pkg_url column to rom_entries
  try { db.run("ALTER TABLE rom_entries ADD COLUMN pkg_url TEXT DEFAULT ''"); } catch (_) {}

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
