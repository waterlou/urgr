pub const CREATE_TABLES: &str = "
CREATE TABLE IF NOT EXISTS set_versions (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER,
    version         TEXT NOT NULL,
    dir             TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(collection_id, version)
);

CREATE TABLE IF NOT EXISTS games (
    id              INTEGER PRIMARY KEY,
    collection_id   INTEGER,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    year            TEXT,
    manufacturer    TEXT,
    platform        TEXT DEFAULT '',
    region          TEXT NOT NULL DEFAULT '',
    parent_game_id  INTEGER,
    synopsis        TEXT DEFAULT '',
    isbios          INTEGER NOT NULL DEFAULT 0,
    isdevice        INTEGER NOT NULL DEFAULT 0,
    runnable        INTEGER,
    driver_status   TEXT,
    driver_emulation TEXT,
    sampleof        TEXT,
    rom_source_id   INTEGER REFERENCES games(id),
    created_at      TEXT DEFAULT (datetime('now')),
                    UNIQUE(collection_id, name, platform)
);

CREATE TABLE IF NOT EXISTS game_rom_sets (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL REFERENCES games(id),
    version_id      INTEGER NOT NULL REFERENCES set_versions(id),
    romof           TEXT,
    status          TEXT NOT NULL DEFAULT 'good',
    available       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, version_id)
);

CREATE TABLE IF NOT EXISTS game_rom_files (
    id              INTEGER PRIMARY KEY,
    rom_set_id      INTEGER NOT NULL REFERENCES game_rom_sets(id),
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

CREATE TABLE IF NOT EXISTS game_state (
    game_id         INTEGER PRIMARY KEY REFERENCES games(id),
    available       INTEGER NOT NULL DEFAULT 0,
    rating          INTEGER NOT NULL DEFAULT 0,
    favourite       INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
";

pub const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_game_rom_sets_version ON game_rom_sets(version_id);
CREATE INDEX IF NOT EXISTS idx_game_rom_sets_game ON game_rom_sets(game_id);
CREATE INDEX IF NOT EXISTS idx_rom_files_set ON game_rom_files(rom_set_id);
CREATE INDEX IF NOT EXISTS idx_rom_files_sha1 ON game_rom_files(sha1);
CREATE INDEX IF NOT EXISTS idx_games_collection ON games(collection_id);
CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
CREATE INDEX IF NOT EXISTS idx_games_runnable ON games(runnable);
CREATE INDEX IF NOT EXISTS idx_games_rom_source ON games(rom_source_id);
";

/// Individual ALTER TABLE statements for existing databases.
/// Applied one at a time, skipping errors (column may already exist).
pub const MIGRATIONS: &[&str] = &[
    "ALTER TABLE games ADD COLUMN rom_source_id INTEGER REFERENCES games(id)",
    "ALTER TABLE games ADD COLUMN region TEXT NOT NULL DEFAULT ''",
];
