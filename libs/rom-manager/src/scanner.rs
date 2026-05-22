use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rom_scraper::RomHashes;

use crate::db::Database;
use crate::error::Result;

pub struct ScanResult {
    pub total_files: usize,
    pub matched_games: usize,
    pub missing_games: usize,
    pub mismatches: Vec<String>,
}

pub fn scan_directory(
    db: &Database,
    version_id: i64,
    dir: &Path,
) -> Result<ScanResult> {
    let games = db.list_games(version_id)?;
    let expected_names: HashSet<String> = games.iter().map(|g| g.name.clone()).collect();

    let mut found: HashSet<String> = HashSet::new();
    let mismatches = Vec::new();

    if dir.exists() {
        for entry in walkdir(dir)? {
            if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let actual_path = entry.to_string_lossy().to_string();

                if expected_names.contains(&stem) {
                    found.insert(stem.clone());

                    let hashes = compute_zip_sha1(&entry)?;
                    let status = if hashes.crc32 == "00000000" {
                        "mismatch"
                    } else {
                        "ok"
                    };

                    db.upsert_scanned_game(
                        version_id,
                        &stem,
                        &actual_path,
                        Some(&hashes.sha1),
                        Some(hashes.size as i64),
                        status,
                    )?;
                }
            }
        }
    }

    let missing: Vec<&String> = expected_names.difference(&found).collect();
    let matched = found.len();

    for name in &missing {
        db.upsert_scanned_game(version_id, name, "", None, None, "missing")?;
    }

    Ok(ScanResult {
        total_files: found.len() + missing.len(),
        matched_games: matched,
        missing_games: missing.len(),
        mismatches,
    })
}

fn walkdir(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    if !dir.is_dir() {
        return Ok(entries);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            entries.extend(walkdir(&path)?);
        } else {
            entries.push(path);
        }
    }
    entries.sort();
    Ok(entries)
}

fn compute_zip_sha1(path: &Path) -> Result<RomHashes> {
    let hashes = rom_scraper::compute_hashes(path)?;
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::GameEntry;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_test_zip(path: &Path, content: &[u8]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("rom.bin", zip::write::FileOptions::<()>::default()).unwrap();
        zip.write_all(content).unwrap();
        zip.finish().unwrap();
    }

    fn make_db_with_games(names: &[&str]) -> (Database, i64) {
        let db = Database::open_in_memory().unwrap();
        let vid = db.import_version("mame", "0.261", None).unwrap();
        for name in names {
            db.insert_game(
                vid,
                &GameEntry {
                    id: 0,
                    version_id: 0,
                    name: name.to_string(),
                    description: String::new(),
                    year: None,
                    manufacturer: None,
                    cloneof: None,
                },
            )
            .unwrap();
        }
        (db, vid)
    }

    #[test]
    fn test_scanner_matches_all() {
        let tmp = TempDir::new().unwrap();
        let (db, vid) = make_db_with_games(&["game_a", "game_b"]);

        create_test_zip(&tmp.path().join("game_a.zip"), b"data_a");
        create_test_zip(&tmp.path().join("game_b.zip"), b"data_b");

        let result = scan_directory(&db, vid, tmp.path()).unwrap();
        assert_eq!(result.matched_games, 2);
        assert_eq!(result.missing_games, 0);
        assert_eq!(result.total_files, 2);
    }

    #[test]
    fn test_scanner_missing_games() {
        let tmp = TempDir::new().unwrap();
        let (db, vid) = make_db_with_games(&["present", "missing"]);

        create_test_zip(&tmp.path().join("present.zip"), b"data");

        let result = scan_directory(&db, vid, tmp.path()).unwrap();
        assert_eq!(result.matched_games, 1);
        assert_eq!(result.missing_games, 1);
    }

    #[test]
    fn test_scanner_empty_directory() {
        let tmp = TempDir::new().unwrap();
        let (db, vid) = make_db_with_games(&["game"]);
        let result = scan_directory(&db, vid, tmp.path()).unwrap();
        assert_eq!(result.matched_games, 0);
        assert_eq!(result.missing_games, 1);
    }

    #[test]
    fn test_scanner_nonexistent_dir() {
        let (db, vid) = make_db_with_games(&["game"]);
        let result = scan_directory(&db, vid, Path::new("/nonexistent/path")).unwrap();
        assert_eq!(result.matched_games, 0);
        assert_eq!(result.missing_games, 1);
    }

    #[test]
    fn test_scanner_populates_db() {
        let tmp = TempDir::new().unwrap();
        let (db, vid) = make_db_with_games(&["test_game"]);

        create_test_zip(&tmp.path().join("test_game.zip"), b"hello_rom");

        scan_directory(&db, vid, tmp.path()).unwrap();

        let scanned = db.list_scanned_games(vid).unwrap();
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].name, "test_game");
        assert_eq!(scanned[0].status, "ok");
        assert!(scanned[0].sha1.is_some());
        assert!(scanned[0].size.unwrap() > 0);
    }

    #[test]
    fn test_scanner_ignores_non_zip() {
        let tmp = TempDir::new().unwrap();
        let (db, vid) = make_db_with_games(&["game"]);

        std::fs::write(tmp.path().join("game.txt"), b"text").unwrap();

        let result = scan_directory(&db, vid, tmp.path()).unwrap();
        assert_eq!(result.matched_games, 0);
        assert_eq!(result.missing_games, 1);
    }

    #[test]
    fn test_scanner_subdirectories() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("subdir");
        std::fs::create_dir_all(&sub).unwrap();
        let (db, vid) = make_db_with_games(&["deep"]);

        create_test_zip(&sub.join("deep.zip"), b"deep_data");

        let result = scan_directory(&db, vid, tmp.path()).unwrap();
        assert_eq!(result.matched_games, 1);
    }
}
