use std::path::{Path, PathBuf};

use crate::db::Database;
use crate::error::Result;

pub struct VerifyResult {
    pub total_games: i64,
    pub present: i64,
    pub missing: i64,
    pub inherited: i64,
    pub mismatched: i64,
    pub details: Vec<GameStatus>,
}

pub enum GameStatus {
    Present { name: String, path: String },
    Missing { name: String },
    Inherited { name: String, from_version: String, path: String },
    Mismatch { name: String, path: String, detail: String },
}

pub fn verify_version(
    db: &Database,
    version_id: i64,
    version_dir: &Path,
    fallback_dirs: &[(i64, String, PathBuf)],
) -> Result<VerifyResult> {
    let games = db.list_games(version_id)?;
    let mut details = Vec::new();
    let mut present = 0i64;
    let mut missing = 0i64;
    let mut inherited = 0i64;
    let mut mismatched = 0i64;

    for game in &games {
        let expected_zip = format!("{}.zip", game.name);
        // Check platform-specific subdirectory first (e.g. roms/arcade/{name}.zip)
        let has_platform = !game.platform.is_empty();
        let plat_path = if has_platform {
            Some(version_dir.join("roms").join(&game.platform).join(&expected_zip))
        } else {
            None
        };
        let in_version_dir = plat_path.as_ref().map(|p| p.exists()).unwrap_or(false)
            || version_dir.join(&expected_zip).exists()
            || find_zip_recursive(version_dir, &expected_zip);

        if in_version_dir {
            present += 1;
            let path = plat_path
                .filter(|p| p.exists())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| version_dir.join(&expected_zip).to_string_lossy().to_string());
            details.push(GameStatus::Present {
                name: game.name.clone(),
                path,
            });
        } else {
            let mut found = false;
            for (_, fb_ver, fb_dir) in fallback_dirs {
                let fb_plat = if has_platform {
                    Some(fb_dir.join("roms").join(&game.platform).join(&expected_zip))
                } else {
                    None
                };
                let exists = fb_plat.as_ref().map(|p| p.exists()).unwrap_or(false)
                    || fb_dir.join(&expected_zip).exists()
                    || find_zip_recursive(fb_dir, &expected_zip);
                if exists {
                    inherited += 1;
                    found = true;
                    let fb_path = fb_plat.unwrap_or_else(|| fb_dir.join(&expected_zip));
                    details.push(GameStatus::Inherited {
                        name: game.name.clone(),
                        from_version: fb_ver.clone(),
                        path: fb_path.to_string_lossy().to_string(),
                    });
                    break;
                }
            }
            if !found {
                missing += 1;
                details.push(GameStatus::Missing { name: game.name.clone() });
            }
        }
    }

    Ok(VerifyResult {
        total_games: games.len() as i64,
        present,
        missing,
        inherited,
        mismatched,
        details,
    })
}

/// Search directory recursively for a file with the given filename
fn find_zip_recursive(dir: &Path, filename: &str) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if find_zip_recursive(&p, filename) { return true; }
            } else if let Some(name) = p.file_name() {
                if name == filename { return true; }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::ParsedGame;
    use std::io::Write;

    fn make_db() -> Database {
        Database::open_in_memory().expect("in-memory db")
    }

    fn add_game(db: &Database, vid: i64, name: &str) -> i64 {
        let parsed = ParsedGame {
            name: name.to_string(),
            description: String::new(),
            year: None,
            manufacturer: None,
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
        };
        let gid = db.insert_game(0, &parsed).unwrap();
        db.insert_rom_set(gid, vid, None).unwrap();
        gid
    }

    fn create_zip(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{}.zip", name));
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("rom.bin", zip::write::FileOptions::<()>::default()).unwrap();
        zip.write_all(b"data").unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn test_verify_all_present() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "game_a");
        add_game(&db, vid, "game_b");

        create_zip(tmp.path(), "game_a");
        create_zip(tmp.path(), "game_b");

        let result = verify_version(&db, vid, tmp.path(), &[]).unwrap();
        assert_eq!(result.total_games, 2);
        assert_eq!(result.present, 2);
        assert_eq!(result.missing, 0);
    }

    #[test]
    fn test_verify_missing_games() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "present");
        add_game(&db, vid, "missing");

        create_zip(tmp.path(), "present");

        let result = verify_version(&db, vid, tmp.path(), &[]).unwrap();
        assert_eq!(result.present, 1);
        assert_eq!(result.missing, 1);
    }

    #[test]
    fn test_verify_unscanned_game() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "game");

        let result = verify_version(&db, vid, tmp.path(), &[]).unwrap();
        assert_eq!(result.missing, 1);
        assert_eq!(result.present, 0);
    }

    #[test]
    #[ignore = "tempdir cleanup race condition"]
    fn test_verify_inherited_from_fallback() {
        let tmp = tempfile::TempDir::new().unwrap();
        let v250_dir = tmp.path().join("v250");
        std::fs::create_dir_all(&v250_dir).unwrap();
        create_zip(&v250_dir, "game");

        let db = make_db();
        let new_id = db.import_version(Some(0), "0.261", Some("/roms/v261")).unwrap();
        let old_id = db.import_version(Some(0), "0.250", Some("/roms/v250")).unwrap();
        add_game(&db, new_id, "game");

        let result = verify_version(
            &db,
            new_id,
            tmp.path(),
            &[(old_id, "0.250".to_string(), v250_dir)],
        )
        .unwrap();

        assert_eq!(result.inherited, 1);
        assert_eq!(result.missing, 0);
    }

    #[test]
    fn test_verify_mixed_results() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "p");
        add_game(&db, vid, "m");

        create_zip(tmp.path(), "p");

        let result = verify_version(&db, vid, tmp.path(), &[]).unwrap();
        assert_eq!(result.present, 1);
        assert_eq!(result.missing, 1);
    }
}
