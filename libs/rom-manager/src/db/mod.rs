mod schema;

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::models::*;

pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(schema::CREATE_TABLES)?;
        conn.execute_batch(schema::INDEXES)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(schema::CREATE_TABLES)?;
        conn.execute_batch(schema::INDEXES)?;
        Ok(Self { conn })
    }

    // ── Set Versions ──

    pub fn import_version(
        &self,
        source: &str,
        version: &str,
        dir: Option<&str>,
    ) -> Result<i64> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO set_versions (source, version, dir) VALUES (?1, ?2, ?3)",
            params![source, version, dir],
        )?;
        let id: i64 = tx.query_row(
            "SELECT id FROM set_versions WHERE source = ?1 AND version = ?2",
            params![source, version],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn list_versions(&self) -> Result<Vec<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.source, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM rom_entries re
                     JOIN game_entries ge ON re.game_entry_id = ge.id
                     WHERE ge.version_id = sv.id) as total_roms
             FROM set_versions sv
             ORDER BY sv.source, sv.version",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                source: r.get(1)?,
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

    pub fn get_version_by_source_and_version(&self, source: &str, version: &str) -> Result<Option<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.source, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM rom_entries re
                     JOIN game_entries ge ON re.game_entry_id = ge.id
                     WHERE ge.version_id = sv.id) as total_roms
             FROM set_versions sv WHERE sv.source = ?1 AND sv.version = ?2",
        )?;
        let mut rows = stmt.query_map(params![source, version], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                source: r.get(1)?,
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
            "SELECT sv.id, sv.source, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM rom_entries re
                     JOIN game_entries ge ON re.game_entry_id = ge.id
                     WHERE ge.version_id = sv.id) as total_roms
             FROM set_versions sv WHERE sv.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                source: r.get(1)?,
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

    pub fn latest_version(&self, source: &str) -> Result<Option<SetVersion>> {
        let mut stmt = self.conn.prepare(
            "SELECT sv.id, sv.source, sv.version, sv.dir,
                    (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games,
                    (SELECT COUNT(*) FROM rom_entries re
                     JOIN game_entries ge ON re.game_entry_id = ge.id
                     WHERE ge.version_id = sv.id) as total_roms
             FROM set_versions sv
             WHERE sv.source = ?1
             ORDER BY sv.version DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![source], |r| {
            Ok(SetVersion {
                id: r.get(0)?,
                source: r.get(1)?,
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

    // ── Game Entries ──

    pub fn insert_game(&self, version_id: i64, game: &GameEntry) -> Result<i64> {
        let region = game.region.as_deref().unwrap_or("");
        self.conn.execute(
            "INSERT INTO game_entries (version_id, name, description, year, manufacturer, cloneof, romof, platform, region)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(version_id, name, region) DO UPDATE SET
               description = excluded.description,
               year = excluded.year,
               manufacturer = excluded.manufacturer,
               cloneof = excluded.cloneof,
               romof = excluded.romof,
               platform = excluded.platform",
            params![
                version_id,
                game.name,
                game.description,
                game.year,
                game.manufacturer,
                game.cloneof,
                game.romof,
                game.platform,
                region,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_game_platform(&self, game_id: i64, platform: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE game_entries SET platform = ?1 WHERE id = ?2",
            params![platform, game_id],
        )?;
        Ok(())
    }

    pub fn insert_games_batch(&self, version_id: i64, games: &[GameEntry]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for game in games {
            let region = game.region.as_deref().unwrap_or("");
            tx.execute(
                "INSERT INTO game_entries (version_id, name, description, year, manufacturer, cloneof, romof, platform, region)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(version_id, name, region) DO UPDATE SET
                   description = excluded.description,
                   year = excluded.year,
                   manufacturer = excluded.manufacturer,
                   cloneof = excluded.cloneof,
                   romof = excluded.romof,
                   platform = excluded.platform",
                params![
                    version_id,
                    game.name,
                    game.description,
                    game.year,
                    game.manufacturer,
                    game.cloneof,
                    game.romof,
                    game.platform,
                    region,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_games(&self, version_id: i64) -> Result<Vec<GameEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, version_id, name, description, year, manufacturer, cloneof, romof, platform, region
             FROM game_entries WHERE version_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            Ok(GameEntry {
                id: r.get(0)?,
                version_id: r.get(1)?,
                name: r.get(2)?,
                description: r.get(3)?,
                year: r.get(4)?,
                manufacturer: r.get(5)?,
                cloneof: r.get(6)?,
                romof: r.get(7)?,
                platform: r.get(8)?,
                region: r.get(9)?,
            })
        })?;
        let mut games = Vec::new();
        for row in rows {
            games.push(row?);
        }
        Ok(games)
    }

    pub fn get_game_count(&self, version_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM game_entries WHERE version_id = ?1",
            params![version_id],
            |r| r.get(0),
        )?)
    }

    // ── ROM Entries ──

    pub fn insert_rom(&self, game_entry_id: i64, rom: &RomEntry) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO rom_entries (game_entry_id, filename, size, crc32, md5, sha1, status, merge_target)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(game_entry_id, filename) DO UPDATE SET
               size = excluded.size, crc32 = excluded.crc32,
               md5 = excluded.md5, sha1 = excluded.sha1,
               status = excluded.status, merge_target = excluded.merge_target",
            params![
                game_entry_id,
                rom.filename,
                rom.size,
                rom.crc32,
                rom.md5,
                rom.sha1,
                rom.status,
                rom.merge_target,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn insert_roms_batch(&self, game_entry_id: i64, roms: &[RomEntry]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for rom in roms {
            tx.execute(
                "INSERT INTO rom_entries (game_entry_id, filename, size, crc32, md5, sha1, status, merge_target)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(game_entry_id, filename) DO UPDATE SET
                   size = excluded.size, crc32 = excluded.crc32,
                   md5 = excluded.md5, sha1 = excluded.sha1,
                   status = excluded.status, merge_target = excluded.merge_target",
                params![
                    game_entry_id,
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

    pub fn list_roms_for_game(&self, game_entry_id: i64) -> Result<Vec<RomEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, game_entry_id, filename, size, crc32, md5, sha1, status, merge_target
             FROM rom_entries WHERE game_entry_id = ?1 ORDER BY filename",
        )?;
        let rows = stmt.query_map(params![game_entry_id], |r| {
            Ok(RomEntry {
                id: r.get(0)?,
                game_entry_id: r.get(1)?,
                filename: r.get(2)?,
                size: r.get(3)?,
                crc32: r.get(4)?,
                md5: r.get(5)?,
                sha1: r.get(6)?,
                status: r.get(7)?,
                merge_target: r.get(8)?,
            })
        })?;
        let mut roms = Vec::new();
        for row in rows {
            roms.push(row?);
        }
        Ok(roms)
    }

    // ── Queries ──

    pub fn get_version_game_count(&self, version_id: i64) -> Result<(i64, i64)> {
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM game_entries WHERE version_id = ?1",
            params![version_id],
            |r| r.get(0),
        )?;
        Ok((total, total))
    }

    pub fn diff_versions(
        &self,
        version_id_a: i64,
        version_id_b: i64,
    ) -> Result<VersionDiff> {
        let va = self.get_version(version_id_a)?.unwrap();
        let vb = self.get_version(version_id_b)?.unwrap();

        let mut stmt = self.conn.prepare(
            "SELECT name FROM game_entries WHERE version_id = ?1 ORDER BY name",
        )?;

        let games_a: std::collections::BTreeSet<String> = stmt
            .query_map(params![version_id_a], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        let games_b: std::collections::BTreeSet<String> = stmt
            .query_map(params![version_id_b], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        let added: Vec<String> = games_b.difference(&games_a).cloned().collect();
        let removed: Vec<String> = games_a.difference(&games_b).cloned().collect();
        let common: Vec<&String> = games_a.intersection(&games_b).collect();

        let mut changed = Vec::new();
        for name in &common {
            let ge_a: i64 = self.conn.query_row(
                "SELECT id FROM game_entries WHERE version_id = ?1 AND name = ?2",
                params![version_id_a, name],
                |r| r.get(0),
            )?;
            let ge_b: i64 = self.conn.query_row(
                "SELECT id FROM game_entries WHERE version_id = ?1 AND name = ?2",
                params![version_id_b, name],
                |r| r.get(0),
            )?;

            let hashes_a: std::collections::BTreeSet<String> = {
                let mut s = self.conn.prepare(
                    "SELECT sha1 FROM rom_entries WHERE game_entry_id = ?1 AND sha1 IS NOT NULL",
                )?;
                let rows: std::collections::BTreeSet<String> = s
                    .query_map(params![ge_a], |r| r.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                rows
            };
            let hashes_b: std::collections::BTreeSet<String> = {
                let mut s = self.conn.prepare(
                    "SELECT sha1 FROM rom_entries WHERE game_entry_id = ?1 AND sha1 IS NOT NULL",
                )?;
                let rows: std::collections::BTreeSet<String> = s
                    .query_map(params![ge_b], |r| r.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                rows
            };

            if hashes_a != hashes_b {
                changed.push(name.to_string());
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
            "SELECT g.id, g.name, g.title_id, g.content_id, g.platform,
                    GROUP_CONCAT(r.id || '|' || r.filename || '|' || r.subtype || '|' || COALESCE(r.size, 0) || '|' || COALESCE(r.sha1, ''), ';;') as roms
             FROM game_entries g
             LEFT JOIN rom_entries r ON r.game_entry_id = g.id
             WHERE g.version_id = ?1
             GROUP BY g.id
             ORDER BY g.name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            let roms_str: Option<String> = r.get(5)?;
            let roms = parse_nps_roms(&roms_str.unwrap_or_default());
            Ok(NpsGame {
                id: r.get(0)?,
                name: r.get(1)?,
                title_id: r.get(2)?,
                content_id: r.get(3)?,
                platform: r.get(4)?,
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
            "INSERT INTO game_state (game_entry_id, available, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(game_entry_id) DO UPDATE SET
               available = excluded.available,
               updated_at = datetime('now')",
            params![game_id, val],
        )?;
        Ok(())
    }

    pub fn reset_all_unavailable(&self, version_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO game_state (game_entry_id, available, updated_at)
             SELECT ge.id, 0, datetime('now')
             FROM game_entries ge
             WHERE ge.version_id = ?1
             ON CONFLICT(game_entry_id) DO UPDATE SET
               available = 0,
               updated_at = datetime('now')",
            params![version_id],
        )?;
        Ok(())
    }

    pub fn list_games_needing_screenshots(&self, version_id: i64) -> Result<Vec<NpsGame>> {
        let mut stmt = self.conn.prepare(
            "SELECT g.id, g.name, g.title_id, g.content_id, g.platform
             FROM game_entries g
             WHERE g.version_id = ?1
               AND (g.screenshots IS NULL OR g.screenshots = '[]')
               AND g.content_id IS NOT NULL
               AND g.content_id != ''
             ORDER BY g.name",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            Ok(NpsGame {
                id: r.get(0)?,
                name: r.get(1)?,
                title_id: r.get(2)?,
                content_id: r.get(3)?,
                platform: r.get(4)?,
                roms: Vec::new(),
            })
        })?;
        let mut games = Vec::new();
        for row in rows {
            games.push(row?);
        }
        Ok(games)
    }

    pub fn update_game_screenshots(&self, game_id: i64, screenshots: &[String]) -> Result<()> {
        let json = serde_json::to_string(screenshots).unwrap_or_else(|_| "[]".to_string());
        self.conn.execute(
            "UPDATE game_entries SET screenshots = ?1 WHERE id = ?2",
            params![json, game_id],
        )?;
        Ok(())
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct NpsGame {
    pub id: i64,
    pub name: String,
    pub title_id: Option<String>,
    pub content_id: Option<String>,
    pub platform: Option<String>,
    pub roms: Vec<NpsRom>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NpsRom {
    pub id: i64,
    pub filename: String,
    pub subtype: String,
    pub size: Option<i64>,
    pub sha1: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db() -> Database {
        Database::open_in_memory().expect("in-memory db")
    }

    fn sample_game(name: &str) -> GameEntry {
        GameEntry {
            id: 0,
            version_id: 0,
            name: name.to_string(),
            description: format!("desc_{}", name),
            year: Some("1990".to_string()),
            manufacturer: Some("Capcom".to_string()),
            cloneof: None,
            romof: None,
            platform: String::new(),
            region: None,
        }
    }

    fn sample_rom(name: &str, sha1: &str) -> RomEntry {
        RomEntry {
            id: 0,
            game_entry_id: 0,
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
        let id = db.import_version("mame", "0.261", Some("/roms/mame261")).unwrap();
        assert!(id > 0);

        let versions = db.list_versions().unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].source, "mame");
        assert_eq!(versions[0].version, "0.261");
    }

    #[test]
    fn test_import_duplicate_version() {
        let db = make_db();
        let id1 = db.import_version("mame", "0.261", None).unwrap();
        let id2 = db.import_version("mame", "0.261", None).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_get_version() {
        let db = make_db();
        let id = db.import_version("mame", "0.261", None).unwrap();
        let v = db.get_version(id).unwrap().expect("version exists");
        assert_eq!(v.version, "0.261");
        assert_eq!(v.source, "mame");
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
        let id = db.import_version("mame", "0.261", None).unwrap();
        db.delete_version(id).unwrap();
        let v = db.get_version(id).unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn test_insert_game() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", None).unwrap();
        let gid = db.insert_game(vid, &sample_game("sf2")).unwrap();
        assert!(gid > 0);

        let games = db.list_games(vid).unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].name, "sf2");
    }

    #[test]
    fn test_insert_games_batch() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", None).unwrap();
        let games = vec![sample_game("game_a"), sample_game("game_b")];
        db.insert_games_batch(vid, &games).unwrap();
        assert_eq!(db.get_game_count(vid).unwrap(), 2);
    }

    #[test]
    fn test_rom_crud() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", None).unwrap();
        let gid = db.insert_game(vid, &sample_game("sf2")).unwrap();

        let roms = vec![sample_rom("ic1", &"A".repeat(40))];
        db.insert_roms_batch(gid, &roms).unwrap();

        let stored = db.list_roms_for_game(gid).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].filename, "ic1.bin");

        let rid = db.insert_rom(gid, &sample_rom("ic2", &"B".repeat(40))).unwrap();
        assert!(rid > 0);
        assert_eq!(db.list_roms_for_game(gid).unwrap().len(), 2);
    }

    #[test]
    fn test_get_version_game_count() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", None).unwrap();
        db.insert_game(vid, &sample_game("sf2")).unwrap();
        db.insert_game(vid, &sample_game("sf3")).unwrap();
        let (total, _) = db.get_version_game_count(vid).unwrap();
        assert_eq!(total, 2);
    }

    #[test]
    fn test_diff_versions_add_remove() {
        let db = make_db();
        let va = db.import_version("mame", "0.250", None).unwrap();
        let vb = db.import_version("mame", "0.261", None).unwrap();

        db.insert_game(va, &sample_game("shared")).unwrap();
        db.insert_game(va, &sample_game("removed")).unwrap();

        db.insert_game(vb, &sample_game("shared")).unwrap();
        db.insert_game(vb, &sample_game("added")).unwrap();

        let diff = db.diff_versions(va, vb).unwrap();
        assert_eq!(diff.added, vec!["added"]);
        assert_eq!(diff.removed, vec!["removed"]);
        assert_eq!(diff.unchanged, 1);
    }

    #[test]
    fn test_diff_versions_changed_roms() {
        let db = make_db();
        let va = db.import_version("mame", "0.250", None).unwrap();
        let vb = db.import_version("mame", "0.261", None).unwrap();

        let ga_id = db.insert_game(va, &sample_game("sf2")).unwrap();
        let gb_id = db.insert_game(vb, &sample_game("sf2")).unwrap();

        db.insert_rom(ga_id, &sample_rom("rom1", &"A".repeat(40))).unwrap();
        db.insert_rom(gb_id, &sample_rom("rom1", &"B".repeat(40))).unwrap();

        let diff = db.diff_versions(va, vb).unwrap();
        assert_eq!(diff.changed, vec!["sf2"]);
        assert_eq!(diff.unchanged, 0);
    }

    // ── Performance tests ──

    fn bulk_games(prefix: &str, count: i64) -> Vec<GameEntry> {
        (0..count).map(|i| GameEntry {
            id: 0,
            version_id: 0,
            name: format!("{}_{}", prefix, i),
            description: format!("Game {}", i),
            year: Some("1991".into()),
            manufacturer: Some("TestCorp".into()),
            cloneof: None,
            romof: None,
            platform: String::new(),
            region: None,
        }).collect()
    }

    #[test]
    fn test_db_perf_bulk_insert() {
        use std::time::Instant;
        let db = make_db();
        let vid = db.import_version("perf", "v1", None).unwrap();
        let games = bulk_games("g", 5_000);
        let start = Instant::now();
        db.insert_games_batch(vid, &games).unwrap();
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
        let vid = db.import_version("perf", "v2", None).unwrap();
        let games = bulk_games("gr", 2_000);
        db.insert_games_batch(vid, &games).unwrap();

        let start = Instant::now();
        for game in &games {
            let ge_id = db.conn.query_row(
                "SELECT id FROM game_entries WHERE version_id = ?1 AND name = ?2",
                rusqlite::params![vid, game.name],
                |r| r.get::<_, i64>(0),
            ).unwrap();
            let rom = RomEntry {
                id: 0,
                game_entry_id: 0,
                filename: format!("{}.bin", game.name),
                size: Some(524288),
                crc32: Some("ABCD1234".into()),
                md5: None,
                sha1: Some("A".repeat(40)),
                status: "good".into(),
                merge_target: None,
            };
            db.insert_rom(ge_id, &rom).unwrap();
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
        let va = db.import_version("perf", "A", None).unwrap();
        let vb = db.import_version("perf", "B", None).unwrap();

        let games_a = bulk_games("a", 3_000);
        let games_b = bulk_games("a", 3_000); // same names
        db.insert_games_batch(va, &games_a).unwrap();
        db.insert_games_batch(vb, &games_b).unwrap();

        let start = Instant::now();
        let diff = db.diff_versions(va, vb).unwrap();
        let elapsed = start.elapsed();
        eprintln!(
            "  DB diff (3K games, identical): {:.3}s", elapsed.as_secs_f64()
        );
        assert_eq!(diff.unchanged, 3_000);
    }
}
