use std::collections::HashSet;
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
    _version_dir: &Path,
    fallback_dirs: &[(i64, String, PathBuf)],
) -> Result<VerifyResult> {
    let games = db.list_games(version_id)?;
    let scanned = db.list_scanned_games(version_id)?;

    let scanned_map: std::collections::HashMap<String, &crate::models::ScannedGame> = scanned
        .iter()
        .map(|s| (s.name.clone(), s))
        .collect();

    let expected_names: HashSet<String> = games.iter().map(|g| g.name.clone()).collect();
    let mut details = Vec::new();
    let mut present = 0i64;
    let mut missing = 0i64;
    let mut inherited = 0i64;
    let mut mismatched = 0i64;

    for name in &expected_names {
        if let Some(scanned) = scanned_map.get(name) {
            match scanned.status.as_str() {
                "ok" => {
                    present += 1;
                    details.push(GameStatus::Present {
                        name: name.clone(),
                        path: scanned.filename.clone(),
                    });
                }
                "missing" => {
                    // Try fallback directories
                    let mut found_in_fallback = false;
                    for (fb_id, fb_ver, fb_dir) in fallback_dirs {
                        let fb_path = fb_dir.join(format!("{}.zip", name));
                        if fb_path.exists() {
                            inherited += 1;
                            found_in_fallback = true;
                            details.push(GameStatus::Inherited {
                                name: name.clone(),
                                from_version: fb_ver.clone(),
                                path: fb_path.to_string_lossy().to_string(),
                            });
                            break;
                        }
                        // Also check scanned_games for the fallback
                        let fb_scanned = db.list_scanned_games(*fb_id)?;
                        if let Some(fb_s) = fb_scanned.iter().find(|s| s.name == *name) {
                            if fb_s.status == "ok" {
                                let fb_path = Path::new(&fb_s.filename);
                                if fb_path.exists() {
                                    inherited += 1;
                                    found_in_fallback = true;
                                    details.push(GameStatus::Inherited {
                                        name: name.clone(),
                                        from_version: fb_ver.clone(),
                                        path: fb_s.filename.clone(),
                                    });
                                    break;
                                }
                            }
                        }
                    }
                    if !found_in_fallback {
                        missing += 1;
                        details.push(GameStatus::Missing { name: name.clone() });
                    }
                }
                "mismatch" => {
                    // Try fallback directories for this specific game
                    let mut found_in_fallback = false;
                    for (_fb_id, fb_ver, fb_dir) in fallback_dirs {
                        let fb_path = fb_dir.join(format!("{}.zip", name));
                        if fb_path.exists() {
                            inherited += 1;
                            found_in_fallback = true;
                            details.push(GameStatus::Inherited {
                                name: name.clone(),
                                from_version: fb_ver.clone(),
                                path: fb_path.to_string_lossy().to_string(),
                            });
                            break;
                        }
                    }
                    if !found_in_fallback {
                        mismatched += 1;
                        details.push(GameStatus::Mismatch {
                            name: name.clone(),
                            path: scanned.filename.clone(),
                            detail: "ZIP hash mismatch or internal ROMs incorrect".to_string(),
                        });
                    }
                }
                _ => {
                    missing += 1;
                    details.push(GameStatus::Missing { name: name.clone() });
                }
            }
        } else {
            // Not scanned at all — try fallback
            let mut found_in_fallback = false;
            for (fb_id, fb_ver, fb_dir) in fallback_dirs {
                let fb_path = fb_dir.join(format!("{}.zip", name));
                if fb_path.exists() {
                    inherited += 1;
                    found_in_fallback = true;
                    details.push(GameStatus::Inherited {
                        name: name.clone(),
                        from_version: fb_ver.clone(),
                        path: fb_path.to_string_lossy().to_string(),
                    });
                    break;
                }
                let fb_scanned = db.list_scanned_games(*fb_id)?;
                if let Some(fb_s) = fb_scanned.iter().find(|s| s.name == *name) {
                    if fb_s.status == "ok" {
                        inherited += 1;
                        found_in_fallback = true;
                        details.push(GameStatus::Inherited {
                            name: name.clone(),
                            from_version: fb_ver.clone(),
                            path: fb_s.filename.clone(),
                        });
                        break;
                    }
                }
            }
            if !found_in_fallback {
                missing += 1;
                details.push(GameStatus::Missing { name: name.clone() });
            }
        }
    }

    Ok(VerifyResult {
        total_games: expected_names.len() as i64,
        present,
        missing,
        inherited,
        mismatched,
        details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::GameEntry;

    fn make_db() -> Database {
        Database::open_in_memory().expect("in-memory db")
    }

    fn add_game(db: &Database, vid: i64, name: &str) -> i64 {
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
        .unwrap()
    }

    #[test]
    fn test_verify_all_present() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "game_a");
        add_game(&db, vid, "game_b");

        db.upsert_scanned_game(vid, "game_a", "/roms/v261/game_a.zip", Some("A"), Some(100), "ok")
            .unwrap();
        db.upsert_scanned_game(vid, "game_b", "/roms/v261/game_b.zip", Some("B"), Some(200), "ok")
            .unwrap();

        let result =
            verify_version(&db, vid, Path::new("/roms/v261"), &[]).unwrap();
        assert_eq!(result.total_games, 2);
        assert_eq!(result.present, 2);
        assert_eq!(result.missing, 0);
        assert_eq!(result.inherited, 0);
        assert_eq!(result.mismatched, 0);
    }

    #[test]
    fn test_verify_missing_games() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "present");
        add_game(&db, vid, "missing");

        db.upsert_scanned_game(vid, "present", "/roms/v261/present.zip", Some("A"), Some(100), "ok")
            .unwrap();
        db.upsert_scanned_game(vid, "missing", "", None, None, "missing")
            .unwrap();

        let result = verify_version(&db, vid, Path::new("/roms/v261"), &[]).unwrap();
        assert_eq!(result.present, 1);
        assert_eq!(result.missing, 1);
    }

    #[test]
    fn test_verify_unscanned_game() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "game");

        // No scanned entry at all
        let result = verify_version(&db, vid, Path::new("/roms/v261"), &[]).unwrap();
        assert_eq!(result.missing, 1);
        assert_eq!(result.present, 0);
    }

    #[test]
    fn test_verify_inherited_from_fallback() {
        let tmp = tempfile::TempDir::new().unwrap();
        let v250_dir = tmp.path().join("v250");
        std::fs::create_dir_all(&v250_dir).unwrap();
        let game_zip = v250_dir.join("game.zip");
        std::fs::write(&game_zip, b"fake zip content").unwrap();

        let db = make_db();
        let new_id = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        let old_id = db.import_version("mame", "0.250", Some("/roms/v250")).unwrap();
        add_game(&db, new_id, "game");

        db.upsert_scanned_game(new_id, "game", "", None, None, "missing")
            .unwrap();
        db.upsert_scanned_game(
            old_id,
            "game",
            &game_zip.to_string_lossy(),
            Some("A"),
            Some(100),
            "ok",
        )
        .unwrap();

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
    fn test_verify_mismatched_game() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "game");

        db.upsert_scanned_game(vid, "game", "/roms/v261/game.zip", Some("BAD"), Some(100), "mismatch")
            .unwrap();

        let result = verify_version(&db, vid, Path::new("/roms/v261"), &[]).unwrap();
        assert_eq!(result.mismatched, 1);
        assert_eq!(result.present, 0);
    }

    #[test]
    fn test_verify_mixed_results() {
        let db = make_db();
        let vid = db.import_version("mame", "0.261", Some("/roms/v261")).unwrap();
        add_game(&db, vid, "p");
        add_game(&db, vid, "m");
        add_game(&db, vid, "x");

        db.upsert_scanned_game(vid, "p", "/roms/v261/p.zip", Some("A"), Some(1), "ok").unwrap();
        db.upsert_scanned_game(vid, "m", "", None, None, "missing").unwrap();
        db.upsert_scanned_game(vid, "x", "/roms/v261/x.zip", Some("X"), Some(2), "mismatch").unwrap();

        let result = verify_version(&db, vid, Path::new("/roms/v261"), &[]).unwrap();
        assert_eq!(result.present, 1);
        assert_eq!(result.missing, 1);
        assert_eq!(result.mismatched, 1);
    }
}
