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

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_game_entries_version ON game_entries(version_id);
CREATE INDEX IF NOT EXISTS idx_game_entries_version_name_region ON game_entries(version_id, name, region);
CREATE INDEX IF NOT EXISTS idx_game_entries_cloneof ON game_entries(cloneof);
CREATE INDEX IF NOT EXISTS idx_rom_entries_game ON rom_entries(game_entry_id);
CREATE INDEX IF NOT EXISTS idx_rom_entries_sha1 ON rom_entries(sha1);
CREATE INDEX IF NOT EXISTS idx_rom_entries_crc32 ON rom_entries(crc32);

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
    FOREIGN KEY (game_set_id) REFERENCES game_sets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_media (
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL DEFAULT '',
    synopsis    TEXT DEFAULT '',
    covers      TEXT DEFAULT '[]',
    screenshots TEXT DEFAULT '[]',
    scraped_at  TEXT,
    PRIMARY KEY (name, platform)
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
CREATE INDEX IF NOT EXISTS idx_game_state_entry ON game_state(game_entry_id);

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

  // Migration: set default platform for MAME/FBNeo games (reverted — see BUGS.md)
  try { db.run("UPDATE game_entries SET platform = '' WHERE platform = 'Arcade' AND EXISTS (SELECT 1 FROM set_versions sv WHERE sv.id = game_entries.version_id AND sv.source = 'MAME')"); } catch (_) {}

  // Migration: add romof column to game_entries
  try { db.run("ALTER TABLE game_entries ADD COLUMN romof TEXT"); } catch (_) {}

  // Drop scanned_games table (CLI now returns JSON directly)
  try { db.run("DROP TABLE IF EXISTS scanned_games"); } catch (_) {}

  // Recently played games (max 6)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS recently_played (
      game_entry_id INTEGER PRIMARY KEY,
      played_at     TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) {}

  // Migration: normalize NULL regions and deduplicate game_entries
  try {
    db.run("PRAGMA foreign_keys=OFF");
    // Delete NULL-region entries where an empty-region entry already exists for same name+version
    db.run("DELETE FROM game_entries WHERE region IS NULL AND EXISTS (SELECT 1 FROM game_entries e2 WHERE e2.version_id = game_entries.version_id AND e2.name = game_entries.name AND e2.region = '')");
    // Normalize remaining NULL to empty string
    db.run("UPDATE game_entries SET region = '' WHERE region IS NULL");
    // Deduplicate any remaining duplicates (keep newest)
    db.run("DELETE FROM game_entries WHERE id NOT IN (SELECT MAX(id) FROM game_entries GROUP BY version_id, name, region)");
    db.run("PRAGMA foreign_keys=ON");
  } catch (_) {}

  // Migration: create game_media table, migrate covers/screenshots, drop columns
  try {
    db.run(`CREATE TABLE IF NOT EXISTS game_media (
      name        TEXT NOT NULL,
      platform    TEXT NOT NULL DEFAULT '',
      synopsis    TEXT DEFAULT '',
      covers      TEXT DEFAULT '[]',
      screenshots TEXT DEFAULT '[]',
      scraped_at  TEXT,
      PRIMARY KEY (name, platform)
    )`);
    // Copy existing covers/screenshots to game_media
    db.run(`INSERT OR IGNORE INTO game_media (name, platform, covers, screenshots, scraped_at)
      SELECT name, COALESCE(NULLIF(platform, ''), 'arcade'),
        CASE WHEN covers != '[]' THEN covers ELSE '[]' END,
        CASE WHEN screenshots != '[]' THEN screenshots ELSE '[]' END,
        datetime('now')
      FROM game_entries
      WHERE covers != '[]' OR screenshots != '[]'
      GROUP BY name, COALESCE(NULLIF(platform, ''), 'arcade')`);
  } catch (_) {}

  // Migration: drop covers/screenshots from game_entries
  try {
    db.run("ALTER TABLE game_entries DROP COLUMN covers");
    db.run("ALTER TABLE game_entries DROP COLUMN screenshots");
  } catch (_) {
    // Columns might not exist or sql.js doesn't support DROP COLUMN — recreate
    try {
      const cols = db.exec("PRAGMA table_info(game_entries)")[0]?.values?.map(v => v[1]) || [];
      if (cols.includes('covers') || cols.includes('screenshots')) {
        db.run('PRAGMA foreign_keys = OFF');
        db.run(`CREATE TABLE game_entries_new (
          id, version_id, name, description, synopsis, year, manufacturer,
          cloneof, platform, title_id, content_id, region,
          FOREIGN KEY (version_id) REFERENCES set_versions(id) ON DELETE CASCADE,
          UNIQUE(version_id, name, region)
        )`);
        db.run(`INSERT INTO game_entries_new (id, version_id, name, description, synopsis, year, manufacturer, cloneof, platform, title_id, content_id, region)
          SELECT id, version_id, name, description, synopsis, year, manufacturer, cloneof, platform, title_id, content_id, region FROM game_entries`);
        db.run('DROP TABLE game_entries');
        db.run('ALTER TABLE game_entries_new RENAME TO game_entries');
        db.run('CREATE INDEX IF NOT EXISTS idx_game_entries_version ON game_entries(version_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_game_entries_version_name_region ON game_entries(version_id, name, region)');
        db.run('PRAGMA foreign_keys = ON');
      }
    } catch (_) {}
  }

  // Startup: mark orphaned operations as failed
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
