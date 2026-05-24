use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{GameEntry, RomEntry, SetVersion};

const STATUS_FILENAME: &str = "_build_status.json";
const MODE_FILENAME: &str = "_build_mode.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildStatus {
    pub source: String,
    pub version: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_version: Option<String>,
    pub total_games: usize,
    pub matched: usize,
    #[serde(default)]
    pub unchanged: usize,
    pub missing: usize,
    pub missing_games: Vec<String>,
    #[serde(default)]
    pub cleaned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BuildResult {
    pub total_games: usize,
    pub matched: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub cleaned: usize,
    pub missing_games: Vec<String>,
    pub mode: String,
    pub version: String,
    pub prev_version: Option<String>,
}

struct ImportIndex {
    name_to_path: HashMap<String, PathBuf>,
}

impl ImportIndex {
    fn scan(dir: &Path) -> Result<Self> {
        let mut name_to_path = HashMap::new();
        if !dir.is_dir() {
            return Ok(Self { name_to_path });
        }
        for entry in walk_files(dir)? {
            if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                name_to_path.entry(stem).or_insert(entry);
            }
        }
        info!("Import index: {} zip files found", name_to_path.len());
        Ok(Self { name_to_path })
    }

    fn find_match(&self, game_name: &str, expected_roms: &[RomEntry]) -> Option<PathBuf> {
        let path = self.name_to_path.get(game_name)?;
        if verify_zip_contains(path, expected_roms) {
            debug!("  {game_name}: matched by filename + hash");
            Some(path.clone())
        } else {
            None
        }
    }
}

pub fn build_version(
    db: &Database,
    source: &str,
    import_dir: &Path,
    base_dir: &Path,
    force_update: bool,
) -> Result<BuildResult> {
    // ── Phase 0: Load versions ──
    let latest = db.latest_version(source)?.ok_or_else(|| {
        Error::Source(format!("No version found for source '{}'", source))
    })?;

    let older = db.find_older_versions(source, &latest.version)?;
    let prev = older.first();

    let collection_dir = base_dir.join(source).join(&latest.version);
    let deleted_dir = base_dir.join("deleted_roms");
    let status_path = collection_dir.join(STATUS_FILENAME);
    let mode_path = base_dir.join(source).join(MODE_FILENAME);

    // Check mode consistency at source level
    let requested_mode = if force_update { "update" } else { "collect" };
    if let Some(existing) = read_mode(&mode_path) {
        if existing != requested_mode {
            return Err(Error::Source(format!(
                "Mode mismatch: previous build used '{}' mode, but '{}' was requested.\n\
                 All builds for source '{}' must use the same mode.",
                existing, requested_mode, source
            )));
        }
    } else {
        write_mode(&mode_path, requested_mode)?;
    }

    let mut status = match read_status(&status_path) {
        Some(s) => {
            info!("Resuming build for {} v{} (mode: {})", source, latest.version, s.mode);
            s
        }
        None => BuildStatus {
            source: source.to_string(),
            version: latest.version.clone(),
            mode: if force_update { "update" } else { "collect" }.to_string(),
            prev_version: prev.map(|p| p.version.clone()),
            total_games: latest.total_games as usize,
            matched: 0,
            unchanged: 0,
            missing: 0,
            missing_games: Vec::new(),
            cleaned: 0,
            last_run: None,
        },
    };

    // ── Phase 1: Compute diff ──
    let (need_copy, unchanged, _removed) = if let Some(p) = prev {
        let diff = db.diff_versions(p.id, latest.id)?;
        let unchanged = diff.unchanged as usize;
        let need_copy: Vec<String> = diff.added.iter().chain(diff.changed.iter()).cloned().collect();
        let removed = diff.removed;
        info!("Diff {}/{} → {}/{}: +{} ~{} -{} ({}u)",
            source, p.version, source, latest.version,
            diff.added.len(), diff.changed.len(), removed.len(), unchanged);
        (need_copy, unchanged, removed)
    } else {
        info!("First build for {} — all {} games need copying", source, latest.total_games);
        let all: Vec<String> = db.list_games(latest.id)?
            .iter()
            .map(|g| g.name.clone())
            .collect();
        (all, 0, Vec::new())
    };

    // ── Phase 2: Folder setup ──
    if force_update {
        if let Some(ref p) = prev {
            let old_dir = base_dir.join(source).join(&p.version);
            if old_dir.exists() && !collection_dir.exists() {
                info!("Renaming {} → {}", old_dir.display(), collection_dir.display());
                std::fs::create_dir_all(collection_dir.parent().unwrap())?;
                std::fs::rename(&old_dir, &collection_dir)?;
            }
        }
    }
    std::fs::create_dir_all(&collection_dir)?;
    std::fs::create_dir_all(&deleted_dir)?;

    // ── Phase 3: Cleanup ──
    let all_games = db.list_games(latest.id)?;
    if collection_dir.exists() {
        let keep: std::collections::HashSet<String> = if force_update {
            all_games.iter().map(|g| g.name.clone()).collect()
        } else {
            need_copy.iter().cloned().collect()
        };
        for entry in walk_files(&collection_dir)? {
            if entry.extension().and_then(|e| e.to_str()) != Some("zip") {
                continue;
            }
            let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if stem == "_build_status" {
                continue;
            }
            if !keep.contains(&stem) {
                move_to_deleted(&entry, &deleted_dir, &latest, prev)?;
                status.cleaned += 1;
            }
        }
    }

    // For update mode: remove old versions of changed games from collection
    if force_update && prev.is_some() {
        let prev_version = prev.unwrap();
        let changed: std::collections::HashSet<String> = db.diff_versions(prev_version.id, latest.id)?
            .changed.into_iter().collect();
        for game_name in &changed {
            let zip_path = collection_dir.join(format!("{}.zip", game_name));
            if zip_path.exists() && !verify_game_zip(db, latest.id, game_name, &zip_path)? {
                move_to_deleted(&zip_path, &deleted_dir, &latest, Some(prev_version))?;
                status.cleaned += 1;
            }
        }
    }

    // ── Phase 4: Build import index ──
    let index = ImportIndex::scan(import_dir)?;

    // ── Phase 5: Copy matching ROMs ──
    let game_map: HashMap<String, &GameEntry> = all_games.iter().map(|g| (g.name.clone(), g)).collect();

    let mut matched = 0usize;
    let mut missing = Vec::new();

    for game_name in &need_copy {
        let dest = collection_dir.join(format!("{}.zip", game_name));

        // Skip if already correctly in place
        if dest.exists() && verify_game_zip(db, latest.id, game_name, &dest)? {
            matched += 1;
            continue;
        }

        // Get expected ROMs for this game
        let ge = game_map.get(game_name);
        let expected_roms = if let Some(g) = ge {
            db.list_roms_for_game(g.id)?
        } else {
            Vec::new()
        };

        // Try to find matching ROM in import folder
        if let Some(src_path) = index.find_match(game_name, &expected_roms) {
            info!("  Copying {} → {}", src_path.display(), dest.display());
            std::fs::copy(&src_path, &dest)?;
            matched += 1;
        } else {
            missing.push(game_name.clone());
        }
    }

    // ── Phase 6: Replace old version (update mode) ──
    if force_update {
        if let Some(p) = prev {
            info!("Removing old version: {} {}", source, p.version);
            db.delete_version(p.id)?;
        }
    }

    // ── Phase 7: Save status + report ──
    status.matched = matched + status.matched;
    status.missing = missing.len();
    status.missing_games = missing.clone();
    status.unchanged = unchanged;
    status.last_run = Some(chrono_now());
    write_status(&status_path, &status)?;

    Ok(BuildResult {
        total_games: need_copy.len() + unchanged,
        matched,
        unchanged,
        missing: missing.len(),
        cleaned: status.cleaned,
        missing_games: missing,
        mode: status.mode.clone(),
        version: latest.version.clone(),
        prev_version: prev.map(|p| p.version.clone()),
    })
}

// ── Helpers ──

fn read_status(path: &Path) -> Option<BuildStatus> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_status(path: &Path, status: &BuildStatus) -> Result<()> {
    let json = serde_json::to_string_pretty(status)
        .map_err(|e| Error::Parse(format!("Failed to serialize build status: {}", e)))?;
    std::fs::write(path, json)?;
    Ok(())
}

fn read_mode(path: &Path) -> Option<String> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&data)
        .ok()
        .and_then(|v| v.get("mode")?.as_str().map(|s| s.to_string()))
}

fn write_mode(path: &Path, mode: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::json!({"mode": mode});
    std::fs::write(path, serde_json::to_string_pretty(&json)
        .map_err(|e| Error::Parse(format!("Failed to write mode: {}", e)))?)?;
    Ok(())
}

fn chrono_now() -> String {
    // Simple UTC timestamp without chrono crate dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Format as ISO-like: YYYY-MM-DD HH:MM:SS
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let mins = (time_secs % 3600) / 60;
    let secs = time_secs % 60;
    // Convert days since epoch to date (simplified)
    let (y, m, d) = days_to_date(days as i64);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, hours, mins, secs)
}

fn days_to_date(mut days: i64) -> (i64, u32, u32) {
    let mut y = 1970i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        y += 1;
    }
    let months = [
        31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30,
        31, 31, 30, 31, 30, 31,
    ];
    let mut m = 0;
    for (i, &dim) in months.iter().enumerate() {
        if days < dim {
            m = i + 1;
            break;
        }
        days -= dim;
    }
    if m == 0 {
        m = 12;
    }
    (y, m as u32, (days + 1) as u32)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn walk_files(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut entries = Vec::new();
    if !dir.is_dir() {
        return Ok(entries);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            entries.extend(walk_files(&path)?);
        } else {
            entries.push(path);
        }
    }
    entries.sort();
    Ok(entries)
}

fn move_to_deleted(
    src: &Path,
    deleted_dir: &Path,
    version: &SetVersion,
    prev_version: Option<&SetVersion>,
) -> Result<()> {
    let v_label = prev_version.map(|p| p.version.as_str()).unwrap_or(&version.version);
    let stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("zip");
    let mut dest = deleted_dir.join(format!("{}_v{}.{}", stem, v_label, ext));

    // If destination already exists, try with source+version
    if dest.exists() {
        let v = &version.version;
        dest = deleted_dir.join(format!("{}_{}_v{}.{}", stem, version.source, v, ext));
    }

    info!("  Moving to deleted: {} → {}", src.display(), dest.display());
    std::fs::rename(src, &dest).map_err(|e| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("Failed to move {} to {}: {}", src.display(), dest.display(), e),
        ))
    })?;
    Ok(())
}

fn verify_zip_contains(zip_path: &Path, expected_roms: &[RomEntry]) -> bool {
    if expected_roms.is_empty() {
        return false;
    }
    let file = match std::fs::File::open(zip_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return false,
    };

    let mut found_hashes: HashMap<String, String> = HashMap::new();
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else { continue };
        if entry.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        if std::io::copy(&mut entry, &mut bytes).is_err() {
            continue;
        }
        let hashes = rom_scraper::compute_hashes_from_bytes(&bytes);
        let name = entry.name().to_string();
        found_hashes.insert(name, hashes.sha1);
    }

    for rom in expected_roms {
        if let Some(ref expected_sha1) = rom.sha1 {
            if !found_hashes.values().any(|h| h == expected_sha1) {
                return false;
            }
        }
    }
    true
}

fn verify_game_zip(db: &Database, version_id: i64, game_name: &str, zip_path: &Path) -> Result<bool> {
    let games = db.list_games(version_id)?;
    let game = match games.iter().find(|g| g.name == game_name) {
        Some(g) => g,
        None => return Ok(false),
    };
    let expected = db.list_roms_for_game(game.id)?;
    if expected.is_empty() {
        return Ok(false);
    }
    Ok(verify_zip_contains(zip_path, &expected))
}
