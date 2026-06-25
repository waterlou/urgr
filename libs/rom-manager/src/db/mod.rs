mod schema;

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::models::*;

// Re-exports so lib.rs doesn't need changing (NpsGame/NpsRom are now in models)
pub use crate::models::{NpsGame, NpsRom};

pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(schema::CREATE_TABLES)?;
        conn.execute_batch(schema::INDEXES)?;
        Self::run_migrations(&conn);
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(schema::CREATE_TABLES)?;
        conn.execute_batch(schema::INDEXES)?;
        Self::run_migrations(&conn);
        Ok(Self { conn })
    }

    /// Apply schema migrations, skipping errors for already-existing columns.
    fn run_migrations(conn: &Connection) {
        for stmt in schema::MIGRATIONS {
            if let Err(e) = conn.execute_batch(stmt) {
                // Ignore "duplicate column" errors from ALTER TABLE
                let msg = e.to_string();
                if !msg.contains("duplicate column") {
                    eprintln!("Migration warning: {}", msg);
                }
            }
        }
    }

    // ── Set Versions ──

    pub fn import_version(
        &self,
        collection_id: Option<i64>,
        version: &str,
        dir: Option<&str>,
    ) -> Result<i64> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO set_versions (collection_id, version, dir) VALUES (?1, ?2, ?3)",
            params![collection_id, version, dir],
        )?;
        let id: i64 = if let Some(cid) = collection_id {
            tx.query_row(
                "SELECT id FROM set_versions WHERE collection_id = ?1 AND version = ?2",
                params![cid, version],
                |r| r.get(0),
            )?
        } else {
            tx.query_row(
                "SELECT id FROM set_versions WHERE collection_id IS NULL AND version = ?1",
                params![version],
                |r| r.get(0),
            )?
        };
        tx.commit()?;
        Ok(id)
    }

    pub fn list_versions(&self) -> Result<Vec<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.collection_id, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM game_rom_files grf
                     JOIN game_rom_sets grs ON grf.rom_set_id = grs.id
                     WHERE grs.version_id = sv.id) as total_roms
             FROM set_versions sv
             ORDER BY sv.collection_id, sv.version",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                collection_id: r.get(1)?,
                version: r.get(2)?,
                dir: r.get(3)?,
                total_games: r.get(4)?,
                total_roms: r.get(5)?,
            })
        })?;
        let mut versions = Vec::new();
        for row in rows {
            versions.push(row?);
        }
        Ok(versions)
    }

    pub fn get_version_by_collection_and_version(
        &self,
        collection_id: i64,
        version: &str,
    ) -> Result<Option<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.collection_id, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM game_rom_files grf
                     JOIN game_rom_sets grs ON grf.rom_set_id = grs.id
                     WHERE grs.version_id = sv.id) as total_roms
             FROM set_versions sv WHERE sv.collection_id = ?1 AND sv.version = ?2",
        )?;
        let mut rows = stmt.query_map(params![collection_id, version], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                collection_id: r.get(1)?,
                version: r.get(2)?,
                dir: r.get(3)?,
                total_games: r.get(4)?,
                total_roms: r.get(5)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn get_version(&self, id: i64) -> Result<Option<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.collection_id, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM game_rom_files grf
                     JOIN game_rom_sets grs ON grf.rom_set_id = grs.id
                     WHERE grs.version_id = sv.id) as total_roms
             FROM set_versions sv WHERE sv.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                collection_id: r.get(1)?,
                version: r.get(2)?,
                dir: r.get(3)?,
                total_games: r.get(4)?,
                total_roms: r.get(5)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn delete_version(&self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM set_versions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_version_count(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM set_versions",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn latest_version(&self, collection_id: i64) -> Result<Option<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.collection_id, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM game_rom_files grf
                     JOIN game_rom_sets grs ON grf.rom_set_id = grs.id
                     WHERE grs.version_id = sv.id) as total_roms
             FROM set_versions sv
             WHERE sv.collection_id = ?1
             ORDER BY sv.version DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![collection_id], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                collection_id: r.get(1)?,
                version: r.get(2)?,
                dir: r.get(3)?,
                total_games: r.get(4)?,
                total_roms: r.get(5)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    // ── Games ──

    pub fn insert_game(&self, collection_id: i64, game: &ParsedGame) -> Result<i64> {
        let id: i64 = self.conn.query_row(
            "INSERT INTO games (collection_id, name, description, year, manufacturer, platform, isbios, isdevice, runnable, driver_status, driver_emulation, sampleof)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(collection_id, name, platform) DO UPDATE SET
               description = excluded.description,
               year = excluded.year,
               manufacturer = excluded.manufacturer,
               platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE platform END,
               isbios = excluded.isbios,
               isdevice = excluded.isdevice,
               runnable = COALESCE(excluded.runnable, runnable),
               driver_status = COALESCE(excluded.driver_status, driver_status),
               driver_emulation = COALESCE(excluded.driver_emulation, driver_emulation),
               sampleof = excluded.sampleof
             RETURNING id",
            params![
                collection_id,
                game.name,
                game.description,
                game.year,
                game.manufacturer,
                game.platform,
                game.isbios,
                game.isdevice,
                game.runnable,
                game.driver_status,
                game.driver_emulation,
                game.sampleof,
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    /// Resolve cloneof → parent_game_id for all games with a non-empty cloneof.
    /// romof is NOT stored in parent_game_id (it's per-version on game_rom_sets
    /// and resolved at build time by compute_game_roms).
    /// Uses (collection_id, name, platform) to uniquely identify games.
    pub fn resolve_parents(&self, games: &[ParsedGame]) -> Result<()> {
        let mut name_plat_to_id: std::collections::HashMap<(String, String), i64> = std::collections::HashMap::new();
        for chunk in games.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT name, platform, id FROM games WHERE name IN ({})", placeholders);
            let mut stmt = self.conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|g| &g.name as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(params.as_slice(), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })?;
            for row in rows {
                let (name, platform, id) = row?;
                name_plat_to_id.insert((name, platform), id);
            }
        }

        for game in games {
            let Some(ref cloneof) = game.cloneof else { continue };
            if cloneof.is_empty() { continue; }
            let parent_key = (cloneof.clone(), game.platform.clone());
            let parent_id = match name_plat_to_id.get(&parent_key) {
                Some(&id) => id,
                None => match self.conn.query_row(
                    "SELECT id FROM games WHERE name = ?1 AND platform = ?2",
                    params![cloneof, game.platform],
                    |r| r.get::<_, i64>(0),
                ) {
                    Ok(id) => id,
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(e) => return Err(crate::Error::Source(format!("Parent lookup error: {}", e))),
                },
            };
            let child_key = (game.name.clone(), game.platform.clone());
            let Some(&child_id) = name_plat_to_id.get(&child_key) else { continue };
            self.conn.execute(
                "UPDATE games SET parent_game_id = ?1 WHERE id = ?2",
                params![parent_id, child_id],
            )?;
        }
        Ok(())
    }

    pub fn list_games(&self, version_id: i64) -> Result<Vec<Game>> {
        let mut stmt = self.conn.prepare(
        "SELECT g.id, g.name, g.description, g.year, g.manufacturer, g.platform,
                g.parent_game_id, g.synopsis, g.isbios, g.isdevice,
                g.runnable, g.driver_status, g.driver_emulation, g.sampleof
         FROM games g
         JOIN game_rom_sets grs ON grs.game_id = g.id
         WHERE grs.version_id = ?1
         ORDER BY g.name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            Ok(Game {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                year: r.get(3)?,
                manufacturer: r.get(4)?,
                platform: r.get(5)?,
                parent_game_id: r.get(6)?,
                synopsis: r.get(7)?,
                isbios: r.get(8)?,
                isdevice: r.get(9)?,
                runnable: r.get(10)?,
                driver_status: r.get(11)?,
                driver_emulation: r.get(12)?,
                sampleof: r.get(13)?,
            })
        })?;
        let mut games = Vec::new();
        for row in rows {
            games.push(row?);
        }
        Ok(games)
    }

    pub fn list_game_names(&self, version_id: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT g.name FROM games g
             JOIN game_rom_sets grs ON grs.game_id = g.id
             WHERE grs.version_id = ?1 ORDER BY g.name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| r.get::<_, String>(0))?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row?);
        }
        Ok(names)
    }

    pub fn get_game(&self, game_id: i64) -> Result<Option<Game>> {
        let mut stmt = self.conn.prepare(
        "SELECT id, name, description, year, manufacturer, platform,
                parent_game_id, synopsis, isbios, isdevice,
                runnable, driver_status, driver_emulation, sampleof
         FROM games WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![game_id], |r| {
            Ok(Game {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                year: r.get(3)?,
                manufacturer: r.get(4)?,
                platform: r.get(5)?,
                parent_game_id: r.get(6)?,
                synopsis: r.get(7)?,
                isbios: r.get(8)?,
                isdevice: r.get(9)?,
                runnable: r.get(10)?,
                driver_status: r.get(11)?,
                driver_emulation: r.get(12)?,
                sampleof: r.get(13)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn get_game_by_name(&self, collection_id: i64, name: &str) -> Result<Option<Game>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, year, manufacturer, platform,
                    parent_game_id, synopsis, isbios, isdevice,
                    runnable, driver_status, driver_emulation, sampleof
             FROM games WHERE collection_id = ?1 AND name = ?2",
        )?;
        let mut rows = stmt.query_map(params![collection_id, name], |r| {
            Ok(Game {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                year: r.get(3)?,
                manufacturer: r.get(4)?,
                platform: r.get(5)?,
                parent_game_id: r.get(6)?,
                synopsis: r.get(7)?,
                isbios: r.get(8)?,
                isdevice: r.get(9)?,
                runnable: r.get(10)?,
                driver_status: r.get(11)?,
                driver_emulation: r.get(12)?,
                sampleof: r.get(13)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    // ── ROM Sets ──

    pub fn clear_game_roms_for_version(&self, version_id: i64) -> Result<()> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM game_rom_sets WHERE version_id = ?1",
            params![version_id],
            |r| r.get(0),
        )?;
        let file_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM game_rom_files WHERE rom_set_id IN (SELECT id FROM game_rom_sets WHERE version_id = ?1)",
            params![version_id],
            |r| r.get(0),
        )?;
        self.conn.execute_batch(
            &format!("DELETE FROM game_rom_files WHERE rom_set_id IN (SELECT id FROM game_rom_sets WHERE version_id = {version_id});
                       DELETE FROM game_rom_sets WHERE version_id = {version_id};")
        )?;
        eprintln!("[import] Cleared {} game_rom_files and {} game_rom_sets for version_id={}", file_count, count, version_id);
        Ok(())
    }

    pub fn insert_rom_set(
        &self,
        game_id: i64,
        version_id: i64,
        romof: Option<&str>,
    ) -> Result<i64> {
        // RETURNING id returns the rowid of the affected row whether it was inserted
        // (new rom_set) or updated (ON CONFLICT path).
        let id: i64 = self.conn.query_row(
            "INSERT INTO game_rom_sets (game_id, version_id, romof) VALUES (?1, ?2, ?3)
             ON CONFLICT(game_id, version_id) DO UPDATE SET romof = excluded.romof
             RETURNING id",
            params![game_id, version_id, romof],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    pub fn insert_rom_files_batch(&self, rom_set_id: i64, roms: &[ParsedRom]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for rom in roms {
            tx.execute(
                "INSERT INTO game_rom_files (rom_set_id, filename, size, crc32, md5, sha1, status, merge_target)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(rom_set_id, filename) DO UPDATE SET
                   size = excluded.size, crc32 = excluded.crc32,
                   md5 = excluded.md5, sha1 = excluded.sha1,
                   status = excluded.status, merge_target = excluded.merge_target",
                params![
                    rom_set_id,
                    rom.filename,
                    rom.size,
                    rom.crc32,
                    rom.md5,
                    rom.sha1,
                    rom.status,
                    rom.merge_target,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_romof(&self, game_id: i64, version_id: i64) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT romof FROM game_rom_sets WHERE game_id = ?1 AND version_id = ?2",
        )?;
        let mut rows = stmt.query_map(params![game_id, version_id], |r| r.get::<_, Option<String>>(0))?;
        match rows.next() {
            Some(row) => Ok(row?),
            None => Ok(None),
        }
    }

    // ── ROM queries ──

    pub fn list_roms_for_game(&self, game_id: i64, version_id: i64) -> Result<Vec<RomFile>> {
        let mut stmt = self.conn.prepare(
            "SELECT grf.id, grf.rom_set_id, grf.filename, grf.size, grf.crc32, grf.md5, grf.sha1, grf.status, grf.merge_target, grf.subtype
             FROM game_rom_files grf
             JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
             WHERE grs.game_id = ?1 AND grs.version_id = ?2
             ORDER BY grf.filename",
        )?;
        let rows = stmt.query_map(params![game_id, version_id], |r| {
            Ok(RomFile {
                id: r.get(0)?,
                rom_set_id: r.get(1)?,
                filename: r.get(2)?,
                size: r.get(3)?,
                crc32: r.get(4)?,
                md5: r.get(5)?,
                sha1: r.get(6)?,
                status: r.get(7)?,
                merge_target: r.get(8)?,
                subtype: r.get(9)?,
            })
        })?;
        let mut roms = Vec::new();
        for row in rows {
            roms.push(row?);
        }
        Ok(roms)
    }

    // ── Queries ──

    pub fn get_game_count(&self, version_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM game_rom_sets WHERE version_id = ?1",
            params![version_id],
            |r| r.get(0),
        )?)
    }

    pub fn diff_versions(
        &self,
        version_id_a: i64,
        version_id_b: i64,
    ) -> Result<VersionDiff> {
        let va = self.get_version(version_id_a)?.unwrap();
        let vb = self.get_version(version_id_b)?.unwrap();

        // Closure: list all game IDs in a version, sorted.
        let list_game_ids = |version_id: i64| -> Result<std::collections::BTreeSet<i64>> {
            let mut stmt = self.conn.prepare(
                "SELECT grs.game_id FROM game_rom_sets grs
                 WHERE grs.version_id = ?1 ORDER BY grs.game_id",
            )?;
            let ids = stmt.query_map(params![version_id], |r| r.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(ids)
        };

        // Closure: get the rom_set id for a (version, game_id) pair.
        let rom_set_id = |version_id: i64, game_id: i64| -> Result<i64> {
            self.conn.query_row(
                "SELECT grs.id FROM game_rom_sets grs
                 WHERE grs.version_id = ?1 AND grs.game_id = ?2",
                params![version_id, game_id],
                |r| r.get(0),
            ).map_err(Into::into)
        };

        // Closure: get game name for a game_id.
        let game_name = |game_id: i64| -> Result<String> {
            self.conn.query_row(
                "SELECT name FROM games WHERE id = ?1",
                params![game_id],
                |r| r.get(0),
            ).map_err(Into::into)
        };

        // Closure: collect all non-null SHA1s for a rom_set into a sorted set.
        let collect_hashes = |rom_set_id: i64| -> Result<std::collections::BTreeSet<String>> {
            let mut stmt = self.conn.prepare(
                "SELECT sha1 FROM game_rom_files WHERE rom_set_id = ?1 AND sha1 IS NOT NULL",
            )?;
            let hashes = stmt.query_map(params![rom_set_id], |r| r.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(hashes)
        };

        let games_a = list_game_ids(version_id_a)?;
        let games_b = list_game_ids(version_id_b)?;

        let added_ids: Vec<i64> = games_b.difference(&games_a).cloned().collect();
        let removed_ids: Vec<i64> = games_a.difference(&games_b).cloned().collect();
        let added: Vec<String> = added_ids.iter().filter_map(|id| game_name(*id).ok()).collect();
        let removed: Vec<String> = removed_ids.iter().filter_map(|id| game_name(*id).ok()).collect();
        let common: Vec<&i64> = games_a.intersection(&games_b).collect();

        let mut changed = Vec::new();
        for game_id in &common {
            let rs_a = rom_set_id(version_id_a, **game_id)?;
            let rs_b = rom_set_id(version_id_b, **game_id)?;
            let hashes_a = collect_hashes(rs_a)?;
            let hashes_b = collect_hashes(rs_b)?;

            if hashes_a != hashes_b {
                if let Ok(name) = game_name(**game_id) {
                    changed.push(name);
                }
            }
        }

        let unchanged = common.len() as i64 - changed.len() as i64;

        Ok(VersionDiff {
            version_a: va.version,
            version_b: vb.version,
            added,
            removed,
            changed,
            unchanged,
        })
    }

    // ── NPS-specific methods ──

    pub fn list_nps_games(&self, version_id: i64) -> Result<Vec<NpsGame>> {
        let mut stmt = self.conn.prepare(
            "SELECT g.id, g.name, g.platform,
                    GROUP_CONCAT(grf.id || '|' || grf.filename || '|' || grf.subtype || '|' || COALESCE(grf.size, 0) || '|' || COALESCE(grf.sha1, ''), ';;') as roms
             FROM games g
             JOIN game_rom_sets grs ON grs.game_id = g.id
             JOIN game_rom_files grf ON grf.rom_set_id = grs.id
             WHERE grs.version_id = ?1
             GROUP BY g.id
             ORDER BY g.name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            let roms_str: Option<String> = r.get(3)?;
            let roms = parse_nps_roms(&roms_str.unwrap_or_default());
            Ok(NpsGame {
                id: r.get(0)?,
                name: r.get(1)?,
                title_id: None,
                content_id: None,
                platform: r.get(2)?,
                roms,
            })
        })?;
        let mut games = Vec::new();
        for row in rows {
            games.push(row?);
        }
        Ok(games)
    }

    pub fn update_game_available(&self, game_id: i64, available: bool) -> Result<()> {
        let val = if available { 1 } else { 0 };
        self.conn.execute(
            "INSERT INTO game_state (game_id, available) VALUES (?1, ?2)
             ON CONFLICT(game_id) DO UPDATE SET
               available = excluded.available,
               updated_at = datetime('now')",
            params![game_id, val],
        )?;
        Ok(())
    }

    pub fn reset_all_unavailable(&self, version_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO game_state (game_id, available)
             SELECT g.id, 0 FROM games g
             JOIN game_rom_sets grs ON grs.game_id = g.id
             WHERE grs.version_id = ?1
             ON CONFLICT(game_id) DO UPDATE SET available = 0",
            params![version_id],
        )?;
        Ok(())
    }

    /// Set subtype on all ROM files for a given rom_set
    pub fn set_rom_subtype(&self, rom_set_id: i64, subtype: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE game_rom_files SET subtype = ?1 WHERE rom_set_id = ?2",
            params![subtype, rom_set_id],
        )?;
        Ok(())
    }

    /// Check if a game exists in this version and collection
    pub fn game_exists(&self, name: &str, platform: &str, version_id: i64, collection_id: i64) -> Result<bool> {
        let result = self.conn.query_row(
            "SELECT 1 FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE g.collection_id = ?1 AND g.name = ?2 AND g.platform = ?3 AND grs.version_id = ?4",
            params![collection_id, name, platform, version_id],
            |r| r.get::<_, i64>(0),
        );
        match result {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(crate::Error::Source(format!("Game lookup error: {}", e))),
        }
    }
}

fn parse_nps_roms(s: &str) -> Vec<NpsRom> {
    if s.is_empty() {
        return Vec::new();
    }
    s.split(";;")
        .filter_map(|part| {
            let fields: Vec<&str> = part.split('|').collect();
            if fields.len() >= 5 {
                Some(NpsRom {
                    id: fields[0].parse().ok()?,
                    filename: fields[1].to_string(),
                    subtype: fields[2].to_string(),
                    size: fields[3].parse().ok(),
                    sha1: if fields[4].is_empty() { None } else { Some(fields[4].to_string()) },
                })
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db() -> Database {
        Database::open_in_memory().expect("in-memory db")
    }

    fn sample_game(name: &str) -> ParsedGame {
        ParsedGame {
            name: name.to_string(),
            description: format!("desc_{}", name),
            year: Some("1990".to_string()),
            manufacturer: Some("Capcom".to_string()),
            cloneof: None,
            romof: None,
            sampleof: None,
            platform: String::new(),
            isbios: false,
            isdevice: false,
            runnable: Some(true),
            driver_status: None,
            driver_emulation: None,
            roms: Vec::new(),
        }
    }

    fn sample_rom(name: &str, sha1: &str) -> ParsedRom {
        ParsedRom {
            filename: format!("{}.bin", name),
            size: Some(1024),
            crc32: Some("ABCD1234".to_string()),
            md5: Some("d41d8cd98f00b204e9800998ecf8427e".to_string()),
            sha1: Some(sha1.to_string()),
            status: "good".to_string(),
            merge_target: None,
        }
    }

    #[test]
    fn test_open_in_memory() {
        let db = make_db();
        let versions = db.list_versions().unwrap();
        assert!(versions.is_empty());
    }

    #[test]
    fn test_import_version() {
        let db = make_db();
        let id = db.import_version(Some(0), "0.261", Some("/roms/mame261")).unwrap();
        assert!(id > 0);

        let versions = db.list_versions().unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].collection_id, 0);
        assert_eq!(versions[0].version, "0.261");
    }

    #[test]
    fn test_import_duplicate_version() {
        let db = make_db();
        let id1 = db.import_version(Some(0), "0.261", None).unwrap();
        let id2 = db.import_version(Some(0), "0.261", None).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_get_version() {
        let db = make_db();
        let id = db.import_version(Some(0), "0.261", None).unwrap();
        let v = db.get_version(id).unwrap().expect("version exists");
        assert_eq!(v.version, "0.261");
        assert_eq!(v.collection_id, 0);
    }

    #[test]
    fn test_get_version_not_found() {
        let db = make_db();
        let v = db.get_version(999).unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn test_delete_version() {
        let db = make_db();
        let id = db.import_version(Some(0), "0.261", None).unwrap();
        db.delete_version(id).unwrap();
        let v = db.get_version(id).unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn test_insert_game() {
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();
        let gid = db.insert_game(0, &sample_game("sf2")).unwrap();
        assert!(gid > 0);
        db.insert_rom_set(gid, vid, None).unwrap();

        let games = db.list_games(vid).unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].name, "sf2");
    }

    #[test]
    fn test_insert_games_batch() {
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();
        let games = vec![sample_game("game_a"), sample_game("game_b")];
        for game in &games {
            let gid = db.insert_game(0, game).unwrap();
            db.insert_rom_set(gid, vid, None).unwrap();
        }
        assert_eq!(db.get_game_count(vid).unwrap(), 2);
    }

    #[test]
    fn test_rom_crud() {
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();
        let gid = db.insert_game(0, &sample_game("sf2")).unwrap();
        let rsid = db.insert_rom_set(gid, vid, None).unwrap();

        let roms = vec![sample_rom("ic1", &"A".repeat(40))];
        db.insert_rom_files_batch(rsid, &roms).unwrap();

        let stored = db.list_roms_for_game(gid, vid).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].filename, "ic1.bin");

        let more_roms = vec![sample_rom("ic2", &"B".repeat(40))];
        db.insert_rom_files_batch(rsid, &more_roms).unwrap();
        assert_eq!(db.list_roms_for_game(gid, vid).unwrap().len(), 2);
    }

    #[test]
    fn test_get_game_count() {
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();
        let g1 = db.insert_game(0, &sample_game("sf2")).unwrap();
        let g2 = db.insert_game(0, &sample_game("sf3")).unwrap();
        db.insert_rom_set(g1, vid, None).unwrap();
        db.insert_rom_set(g2, vid, None).unwrap();
        let count = db.get_game_count(vid).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_diff_versions_add_remove() {
        let db = make_db();
        let va = db.import_version(Some(0), "0.250", None).unwrap();
        let vb = db.import_version(Some(0), "0.261", None).unwrap();

        let g_shared = db.insert_game(0, &sample_game("shared")).unwrap();
        let g_removed = db.insert_game(0, &sample_game("removed")).unwrap();
        db.insert_rom_set(g_shared, va, None).unwrap();
        db.insert_rom_set(g_removed, va, None).unwrap();

        let g_shared2 = db.insert_game(0, &sample_game("shared")).unwrap();
        let g_added = db.insert_game(0, &sample_game("added")).unwrap();
        db.insert_rom_set(g_shared2, vb, None).unwrap();
        db.insert_rom_set(g_added, vb, None).unwrap();

        let diff = db.diff_versions(va, vb).unwrap();
        assert_eq!(diff.added, vec!["added"]);
        assert_eq!(diff.removed, vec!["removed"]);
        assert_eq!(diff.unchanged, 1);
    }

    #[test]
    fn test_diff_versions_changed_roms() {
        let db = make_db();
        let va = db.import_version(Some(0), "0.250", None).unwrap();
        let vb = db.import_version(Some(0), "0.261", None).unwrap();

        let ga_id = db.insert_game(0, &sample_game("sf2")).unwrap();
        let gb_id = db.insert_game(0, &sample_game("sf2")).unwrap();

        let rsa = db.insert_rom_set(ga_id, va, None).unwrap();
        let rsb = db.insert_rom_set(gb_id, vb, None).unwrap();

        db.insert_rom_files_batch(rsa, &[sample_rom("rom1", &"A".repeat(40))])
            .unwrap();
        db.insert_rom_files_batch(rsb, &[sample_rom("rom1", &"B".repeat(40))])
            .unwrap();

        let diff = db.diff_versions(va, vb).unwrap();
        assert_eq!(diff.changed, vec!["sf2"]);
        assert_eq!(diff.unchanged, 0);
    }

    // ── Performance tests ──

    fn bulk_games(prefix: &str, count: i64) -> Vec<ParsedGame> {
        (0..count).map(|i| ParsedGame {
            name: format!("{}_{}", prefix, i),
            description: format!("Game {}", i),
            year: Some("1991".into()),
            manufacturer: Some("TestCorp".into()),
            cloneof: None,
            romof: None,
            sampleof: None,
            platform: String::new(),
            isbios: false,
            isdevice: false,
            runnable: Some(true),
            driver_status: None,
            driver_emulation: None,
            roms: Vec::new(),
        }).collect()
    }

    #[test]
    fn test_db_perf_bulk_insert() {
        use std::time::Instant;
        let db = make_db();
        let vid = db.import_version(Some(0), "v1", None).unwrap();
        let games = bulk_games("g", 5_000);
        let start = Instant::now();
        for game in &games {
            let gid = db.insert_game(0, game).unwrap();
            db.insert_rom_set(gid, vid, None).unwrap();
        }
        let elapsed = start.elapsed();
        eprintln!(
            "  DB bulk insert: {} games in {:.3}s ({:.0} games/s)",
            5_000, elapsed.as_secs_f64(), 5_000_f64 / elapsed.as_secs_f64()
        );
        let count = db.get_game_count(vid).unwrap();
        assert_eq!(count, 5_000);
    }

    #[test]
    fn test_db_perf_bulk_insert_with_roms() {
        use std::time::Instant;
        let db = make_db();
        let vid = db.import_version(Some(0), "v2", None).unwrap();
        let games = bulk_games("gr", 2_000);

        for game in &games {
            db.insert_game(0, game).unwrap();
        }

        let start = Instant::now();
        for game in &games {
            let gid = db.conn.query_row(
                "SELECT id FROM games WHERE name = ?1",
                params![game.name],
                |r| r.get::<_, i64>(0),
            ).unwrap();
            let rsid = db.insert_rom_set(gid, vid, None).unwrap();
            let rom = ParsedRom {
                filename: format!("{}.bin", game.name),
                size: Some(524288),
                crc32: Some("ABCD1234".into()),
                md5: None,
                sha1: Some("A".repeat(40)),
                status: "good".into(),
                merge_target: None,
            };
            db.insert_rom_files_batch(rsid, &[rom]).unwrap();
        }
        let elapsed = start.elapsed();
        eprintln!(
            "  DB bulk insert with ROMs: {} games + ROMs in {:.3}s ({:.0} games+roms/s)",
            2_000, elapsed.as_secs_f64(), 2_000_f64 / elapsed.as_secs_f64()
        );
        let game_count = db.get_game_count(vid).unwrap();
        assert_eq!(game_count, 2_000);
    }

    #[test]
    fn test_db_perf_diff_large() {
        use std::time::Instant;
        let db = make_db();
        let va = db.import_version(Some(0), "A", None).unwrap();
        let vb = db.import_version(Some(0), "B", None).unwrap();

        let games_a = bulk_games("a", 3_000);

        for game in &games_a {
            let gid = db.insert_game(0, game).unwrap();
            db.insert_rom_set(gid, va, None).unwrap();
        }

        // same names, different instances
        let games_b = bulk_games("a", 3_000);
        for game in &games_b {
            let gid = db.insert_game(0, game).unwrap();
            db.insert_rom_set(gid, vb, None).unwrap();
        }

        let start = Instant::now();
        let diff = db.diff_versions(va, vb).unwrap();
        let elapsed = start.elapsed();
        eprintln!(
            "  DB diff (3K games, identical): {:.3}s", elapsed.as_secs_f64()
        );
        assert_eq!(diff.unchanged, 3_000);
    }

    #[test]
    fn test_resolve_parents_out_of_order() {
        // Regression test: previously, if a clone was inserted before its parent in the
        // same batch, the parent lookup would fail because the parent wasn't yet in the DB.
        // Now resolve_parents uses an in-memory map of just-inserted names.
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();

        // Insert clone FIRST, parent SECOND — alphabetical order would be parent-first,
        // but DATs aren't guaranteed to be sorted that way.
        let clone = ParsedGame {
            name: "sf2a".to_string(),
            description: "SF2 variant".into(),
            year: Some("1991".into()),
            manufacturer: Some("Capcom".into()),
            cloneof: Some("sf2".to_string()),
            romof: None,
            sampleof: None,
            platform: String::new(),
            isbios: false,
            isdevice: false,
            runnable: Some(true),
            driver_status: None,
            driver_emulation: None,
            roms: vec![],
        };
        let parent = ParsedGame {
            name: "sf2".to_string(),
            description: "SF2 parent".into(),
            year: Some("1991".into()),
            manufacturer: Some("Capcom".into()),
            cloneof: None,
            romof: None,
            sampleof: None,
            platform: String::new(),
            isbios: false,
            isdevice: false,
            runnable: Some(true),
            driver_status: None,
            driver_emulation: None,
            roms: vec![],
        };

        for g in &[&clone, &parent] {
            let gid = db.insert_game(0, g).unwrap();
            db.insert_rom_set(gid, vid, None).unwrap();
        }

        // Resolve parents — even though clone was inserted first, parent IS in the
        // in-memory slice and should be findable.
        db.resolve_parents(&[clone, parent]).unwrap();

        // Verify sf2a has sf2 as parent
        let parent_id: i64 = db.conn.query_row(
            "SELECT parent_game_id FROM games WHERE name = 'sf2a'",
            [],
            |r| r.get(0),
        ).unwrap();
        let parent_name: String = db.conn.query_row(
            "SELECT name FROM games WHERE id = ?1",
            [parent_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(parent_name, "sf2");
    }

    #[test]
    fn test_resolve_parents_unknown_parent() {
        // If the parent isn't in the same batch nor in the DB, the child should
        // simply not get a parent_game_id (no error).
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", None).unwrap();
        let child = sample_game("lonely_clone");
        let mut child = child;
        child.cloneof = Some("nonexistent_parent".to_string());

        let gid = db.insert_game(0, &child).unwrap();
        db.insert_rom_set(gid, vid, None).unwrap();

        // Should not error
        db.resolve_parents(&[child]).unwrap();

        let parent_id: Option<i64> = db.conn.query_row(
            "SELECT parent_game_id FROM games WHERE name = 'lonely_clone'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert!(parent_id.is_none());
    }

    /// Regression test: insert_game and insert_rom_set must return the rowid of the
    /// affected row even on the ON CONFLICT DO UPDATE path. Previously we relied on
    /// last_insert_rowid() which returns the most recent insert from any table on
    /// the connection, not the current statement's affected row — so a re-insert
    /// after another table's insert would return the wrong id.
    #[test]
    fn test_insert_returns_correct_id_on_upsert() {
        let db = make_db();
        let va = db.import_version(Some(0), "0.261", None).unwrap();
        let vb = db.import_version(Some(0), "0.262", None).unwrap();

        // Insert game + rom_set for version a
        let gid_a = db.insert_game(0, &sample_game("shared")).unwrap();
        let rs_a = db.insert_rom_set(gid_a, va, None).unwrap();
        let gid_b = db.insert_game(0, &sample_game("other")).unwrap();
        let rs_b = db.insert_rom_set(gid_b, vb, None).unwrap();

        // Now the critical scenario: re-insert "shared" (UPSERT path) and verify
        // the returned id is the ORIGINAL gid_a, not the most recent rowid.
        let gid_a_again = db.insert_game(0, &sample_game("shared")).unwrap();
        assert_eq!(gid_a_again, gid_a,
            "insert_game on conflict must return the original rowid, not last_insert_rowid()");

        let rs_a_again = db.insert_rom_set(gid_a, va, None).unwrap();
        assert_eq!(rs_a_again, rs_a,
            "insert_rom_set on conflict must return the original rowid, not last_insert_rowid()");

        // And verify the OTHER table inserts (game_rom_files) don't corrupt the counter.
        // Insert a rom file into rs_b to shift last_insert_rowid() to a different table.
        db.insert_rom_files_batch(rs_b, &[sample_rom("ic1", &"A".repeat(40))]).unwrap();

        // Re-insert "shared" again — should STILL return gid_a.
        let gid_a_third = db.insert_game(0, &sample_game("shared")).unwrap();
        assert_eq!(gid_a_third, gid_a,
            "insert_game must return original rowid even after other table inserts");
    }

    #[test]
    fn test_resolve_parents_cross_platform_duplicate_name() {
        // Regression: same game name across platforms should not collide in resolve_parents.
        // Set up: "btime" on arcade (collection 0), "btime" on coleco (collection 0).
        // A clone "btime_hack" on coleco has cloneof="btime" — should resolve to coleco btime.
        let db = make_db();
        let cid = 0i64;

        let mut btime_arcade = sample_game("btime");
        btime_arcade.platform = "arcade".to_string();
        let gid_btime_arcade = db.insert_game(cid, &btime_arcade).unwrap();

        let mut btime_coleco = sample_game("btime");
        btime_coleco.platform = "coleco".to_string();
        let gid_btime_coleco = db.insert_game(cid, &btime_coleco).unwrap();

        let mut clone = sample_game("btime_hack");
        clone.platform = "coleco".to_string();
        clone.cloneof = Some("btime".to_string());
        let gid_clone = db.insert_game(cid, &clone).unwrap();

        assert!(db.resolve_parents(&[clone]).is_ok());

        let parent_id = db.conn.query_row(
            "SELECT parent_game_id FROM games WHERE id = ?1",
            params![gid_clone],
            |r| r.get::<_, Option<i64>>(0),
        ).unwrap();

        assert_eq!(parent_id, Some(gid_btime_coleco),
            "clone on coleco should resolve to btime on coleco, not arcade");
    }

    #[test]
    fn test_resolve_parents_unknown_cross_platform_parent() {
        // Regression: a clone references a parent name that only exists on a DIFFERENT platform.
        // "btime_child" on coleco has cloneof="btime_parent", but btime_parent only exists on arcade.
        // Should leave parent_game_id as NULL (no match within same platform).
        let db = make_db();
        let cid = 0i64;

        let mut parent = sample_game("btime_parent");
        parent.platform = "arcade".to_string();
        db.insert_game(cid, &parent).unwrap();

        let mut clone = sample_game("btime_child");
        clone.platform = "coleco".to_string();
        clone.cloneof = Some("btime_parent".to_string());
        let gid_clone = db.insert_game(cid, &clone).unwrap();

        assert!(db.resolve_parents(&[clone]).is_ok());

        let parent_id = db.conn.query_row(
            "SELECT parent_game_id FROM games WHERE id = ?1",
            params![gid_clone],
            |r| r.get::<_, Option<i64>>(0),
        ).unwrap();

        assert_eq!(parent_id, None,
            "clone on coleco should have NULL parent when parent only exists on arcade");
    }

    #[test]
    fn test_diff_versions_cross_platform_duplicate_names() {
        // Regression: diff_versions should use game_id, not game name.
        // Version A: "btime" on arcade (sha1=X), "btime" on coleco (sha1=Y)
        // Version B: "btime" on arcade (sha1=Z, changed), "btime" on coleco (sha1=Y, unchanged)
        // diff should report 1 changed (arcade), 1 unchanged (coleco).
        let db = make_db();
        let va = db.import_version(Some(0), "1.0", None).unwrap();
        let vb = db.import_version(Some(0), "2.0", None).unwrap();

        // Version A: btime on arcade + coleco
        let mut ga1 = sample_game("btime");
        ga1.platform = "arcade".to_string();
        let gid_a_arc = db.insert_game(0, &ga1).unwrap();
        let rs_a_arc = db.insert_rom_set(gid_a_arc, va, None).unwrap();
        db.insert_rom_files_batch(rs_a_arc, &[sample_rom("rom1", &"A".repeat(40))]).unwrap();

        let mut ga2 = sample_game("btime");
        ga2.platform = "coleco".to_string();
        let gid_a_col = db.insert_game(0, &ga2).unwrap();
        let rs_a_col = db.insert_rom_set(gid_a_col, va, None).unwrap();
        db.insert_rom_files_batch(rs_a_col, &[sample_rom("rom2", &"B".repeat(40))]).unwrap();

        // Version B: same names, arcade changed sha1, coleco same
        let _gid_b_arc = db.insert_game(0, &ga1).unwrap();
        let rs_b_arc = db.insert_rom_set(gid_a_arc, vb, None).unwrap();
        db.insert_rom_files_batch(rs_b_arc, &[sample_rom("rom1", &"C".repeat(40))]).unwrap();

        let _gid_b_col = db.insert_game(0, &ga2).unwrap();
        let rs_b_col = db.insert_rom_set(gid_a_col, vb, None).unwrap();
        db.insert_rom_files_batch(rs_b_col, &[sample_rom("rom2", &"B".repeat(40))]).unwrap();

        let diff = db.diff_versions(va, vb).unwrap();

        assert_eq!(diff.added.len(), 0, "no games added");
        assert_eq!(diff.removed.len(), 0, "no games removed");
        assert_eq!(diff.changed.len(), 1, "arcade btime should be changed");
        assert_eq!(diff.unchanged, 1, "coleco btime should be unchanged");
    }
}
