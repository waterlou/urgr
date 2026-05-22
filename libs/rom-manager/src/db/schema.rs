pub const CREATE_TABLES: &str = "
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
";

pub const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_game_entries_version ON game_entries(version_id);
CREATE INDEX IF NOT EXISTS idx_rom_entries_game ON rom_entries(game_entry_id);
CREATE INDEX IF NOT EXISTS idx_rom_entries_sha1 ON rom_entries(sha1);
CREATE INDEX IF NOT EXISTS idx_scanned_games_version ON scanned_games(version_id);
";
