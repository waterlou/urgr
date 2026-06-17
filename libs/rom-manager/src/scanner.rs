use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::Result;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanMatch {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Scan a directory for .zip files, matching against expected game names and CRC32 values.
/// `expected_crcs` maps game name → list of expected CRC32 strings (uppercase hex).
/// If a game has no CRC list (empty or missing), filename-only matching is used.
pub fn scan_directory(
    expected_crcs: &HashMap<String, Vec<String>>,
    dir: &Path,
) -> Result<Vec<ScanMatch>> {
    let mut matches = Vec::new();

    if !dir.exists() {
        return Ok(matches);
    }

    for entry in walkdir(dir)? {
        if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
            let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if !expected_crcs.contains_key(&stem) {
                continue;
            }
            let expected = &expected_crcs[&stem];
            // If no expected CRCs, match by name only
            if expected.is_empty() {
                matches.push(ScanMatch {
                    name: stem,
                    filename: Some(entry.to_string_lossy().to_string()),
                });
                continue;
            }
            // Verify CRC from zip entry headers (no decompression)
            if let Ok(file) = std::fs::File::open(&entry) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    let mut zip_crcs = HashSet::new();
                    for i in 0..archive.len() {
                        if let Ok(e) = archive.by_index_raw(i) {
                            if !e.is_dir() {
                                zip_crcs.insert(format!("{:08X}", e.crc32()));
                            }
                        }
                    }
                    if expected.iter().all(|crc| zip_crcs.contains(crc)) {
                        matches.push(ScanMatch {
                            name: stem,
                            filename: Some(entry.to_string_lossy().to_string()),
                        });
                    }
                }
            }
        }
    }

    Ok(matches)
}

fn walkdir(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
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

pub fn scan_nps_directory(
    title_to_game: &HashMap<String, String>,
    dir: &Path,
) -> Result<Vec<ScanMatch>> {
    let mut matches = Vec::new();
    if !dir.exists() {
        return Ok(matches);
    }
    for entry in walkdir(dir)? {
        if entry.extension().and_then(|e| e.to_str()) == Some("pkg") {
            let filename = entry.file_name().unwrap_or_default().to_string_lossy().to_string();
            let full_path = entry.to_string_lossy().to_string();
            if let Some(tid) = extract_title_id(&filename) {
                if let Some(game_name) = title_to_game.get(&tid) {
                    matches.push(ScanMatch {
                        name: game_name.clone(),
                        filename: Some(full_path),
                    });
                }
            }
        }
    }
    Ok(matches)
}

/// Extract title_id from NPS PKG filename.
/// Format: {prefix}-{title_id}_{num}-{name}_bg_{n}_{hash}.pkg
pub fn extract_title_id(filename: &str) -> Option<String> {
    let base = filename.strip_suffix(".pkg")?;
    if let Some(dash_pos) = base.find('-') {
        let after_dash = &base[dash_pos + 1..];
        if let Some(us_pos) = after_dash.find('_') {
            return Some(after_dash[..us_pos].to_string());
        }
    }
    if let Some(pos) = base.find('_') {
        Some(base[..pos].to_string())
    } else {
        Some(base.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_test_zip(path: &std::path::Path, content: &[u8]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("rom.bin", zip::write::FileOptions::<()>::default()).unwrap();
        zip.write_all(content).unwrap();
        zip.finish().unwrap();
    }

    fn make_crc_map(names: &[&str]) -> HashMap<String, Vec<String>> {
        names.iter().map(|s| (s.to_string(), Vec::new())).collect()
    }

    #[test]
    fn test_scanner_matches_all() {
        let tmp = TempDir::new().unwrap();
        let crcs = make_crc_map(&["game_a", "game_b"]);
        create_test_zip(&tmp.path().join("game_a.zip"), b"data_a");
        create_test_zip(&tmp.path().join("game_b.zip"), b"data_b");

        let result = scan_directory(&crcs, tmp.path()).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_scanner_partial_match() {
        let tmp = TempDir::new().unwrap();
        let crcs = make_crc_map(&["present", "missing"]);
        create_test_zip(&tmp.path().join("present.zip"), b"data");

        let result = scan_directory(&crcs, tmp.path()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "present");
    }

    #[test]
    fn test_scanner_empty_directory() {
        let tmp = TempDir::new().unwrap();
        let crcs = make_crc_map(&["game"]);
        let result = scan_directory(&crcs, tmp.path()).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_scanner_nonexistent_dir() {
        let crcs = make_crc_map(&["game"]);
        let result = scan_directory(&crcs, std::path::Path::new("/nonexistent/path")).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_scanner_ignores_non_zip() {
        let tmp = TempDir::new().unwrap();
        let crcs = make_crc_map(&["game"]);
        std::fs::write(tmp.path().join("game.txt"), b"text").unwrap();

        let result = scan_directory(&crcs, tmp.path()).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_scanner_subdirectories() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("subdir");
        std::fs::create_dir_all(&sub).unwrap();
        let crcs = make_crc_map(&["deep"]);
        create_test_zip(&sub.join("deep.zip"), b"deep_data");

        let result = scan_directory(&crcs, tmp.path()).unwrap();
        assert_eq!(result.len(), 1);
    }
}
