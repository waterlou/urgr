use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{GameEntry, RomEntry, SetVersion};

const STATUS_FILENAME: &str = "_build_status.json";
const MODE_FILENAME: &str = "_build_mode.json";
const PROGRESS_FILENAME: &str = "_build_progress.json";
const ROMS_DIR_NAME: &str = "roms";
const SAMPLES_DIR_NAME: &str = "samples";
const CHD_DIR_NAME: &str = "chd";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildProgress {
    pub phase: String,
    pub pct: u32,
    pub msg: String,
    pub matched: usize,
    pub missing: usize,
    pub total: usize,
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

    /// For a given source zip path, discover CHD files in a same-named sibling directory.
    /// e.g. `arcade/game1.zip` → check `arcade/game1/*.chd`
    fn find_chd_files(zip_path: &Path) -> Vec<PathBuf> {
        let chd_dir = zip_path.with_extension("");
        if !chd_dir.is_dir() {
            return Vec::new();
        }
        let mut chds = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&chd_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("chd") {
                    chds.push(path);
                }
            }
        }
        chds.sort();
        chds
    }
}

pub fn build_version(
    db: &Database,
    source: &str,
    import_dir: &Path,
    base_dir: &Path,
    force_update: bool,
    on_progress: &dyn Fn(&BuildProgress),
    cancelled: &AtomicBool,
) -> Result<BuildResult> {
    fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
        if cancelled.load(Ordering::Relaxed) {
            Err(Error::Source("Build cancelled".into()))
        } else {
            Ok(())
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn progress(
        on: &dyn Fn(&BuildProgress),
        phase: &str,
        pct: u32,
        msg: &str,
        matched: usize,
        missing: usize,
        total: usize,
        progress_path: &Path,
    ) {
        let p = BuildProgress { phase: phase.to_string(), pct, msg: msg.to_string(), matched, missing, total };
        on(&p);
        let _ = write_progress(progress_path, &p);
    }

    let progress_path = base_dir.join(source).join(PROGRESS_FILENAME);

    // ── Phase 0: Load versions ──
    progress(on_progress, "loading", 0, "Loading versions...", 0, 0, 0, &progress_path);
    let latest = db.latest_version(source)?.ok_or_else(|| {
        Error::Source(format!("No version found for source '{}'", source))
    })?;

    let older = db.find_older_versions(source, &latest.version)?;
    let prev = older.first();

    check_cancelled(cancelled)?;
    progress(on_progress, "loading", 5, &format!("Version {} loaded", latest.version), 0, 0, latest.total_games as usize, &progress_path);

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

    check_cancelled(cancelled)?;
    progress(on_progress, "diff", 10, "Diff computed", 0, 0, need_copy.len() + unchanged, &progress_path);

    // ── Phase 2: Folder setup ──
    let roms_dir = collection_dir.join(ROMS_DIR_NAME);
    if force_update {
        if let Some(ref p) = prev {
            let old_dir = base_dir.join(source).join(&p.version);
            if old_dir.exists() && !collection_dir.exists() {
                info!("Renaming {} → {}", old_dir.display(), collection_dir.display());
                std::fs::create_dir_all(collection_dir.parent().unwrap())?;
                std::fs::rename(&old_dir, &collection_dir)?;
                // Migrate flat ROMs into roms/ subfolder
                if !roms_dir.exists() {
                    std::fs::create_dir_all(&roms_dir)?;
                    for entry in walk_files(&collection_dir)? {
                        if entry.extension().and_then(|e| e.to_str()) == Some("zip")
                            && entry.file_stem().map(|s| s != "_build_status").unwrap_or(false)
                        {
                            let dest = roms_dir.join(entry.file_name().unwrap());
                            std::fs::rename(&entry, &dest)?;
                        }
                    }
                }
            }
        }
    }
    std::fs::create_dir_all(&roms_dir)?;
    std::fs::create_dir_all(&deleted_dir)?;

    progress(on_progress, "setup", 15, "Folders ready", 0, 0, need_copy.len() + unchanged, &progress_path);

    // ── Phase 3: Cleanup ──
    let all_games = db.list_games(latest.id)?;
    if roms_dir.exists() {
        let keep: std::collections::HashSet<String> = if force_update {
            all_games.iter().map(|g| g.name.clone()).collect()
        } else {
            need_copy.iter().cloned().collect()
        };
        for entry in walk_files(&roms_dir)? {
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

    // Clean up stale CHD directories (update mode)
    if force_update {
        let chd_dir = collection_dir.join(CHD_DIR_NAME);
        if chd_dir.exists() {
            let game_names: std::collections::HashSet<String> =
                all_games.iter().map(|g| g.name.clone()).collect();
            for entry in std::fs::read_dir(&chd_dir)? {
                let entry = entry?;
                if entry.path().is_dir() {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    if !game_names.contains(&dir_name) {
                        std::fs::remove_dir_all(entry.path())?;
                        status.cleaned += 1;
                    }
                }
            }
        }
    }

    // For update mode: remove old versions of changed games from collection
    if force_update && prev.is_some() {
        let prev_version = prev.unwrap();
        let changed: std::collections::HashSet<String> = db.diff_versions(prev_version.id, latest.id)?
            .changed.into_iter().collect();
        let platform_map: HashMap<&str, &str> = all_games.iter().map(|g| (g.name.as_str(), g.platform.as_str())).collect();
        for game_name in &changed {
            let pf = platform_map.get(game_name.as_str()).copied().unwrap_or("");
            let zip_path = if pf.is_empty() {
                roms_dir.join(format!("{}.zip", game_name))
            } else {
                roms_dir.join(pf).join(format!("{}.zip", game_name))
            };
            if zip_path.exists() && !verify_game_zip(db, latest.id, game_name, &zip_path)? {
                move_to_deleted(&zip_path, &deleted_dir, &latest, Some(prev_version))?;
                status.cleaned += 1;
            }
        }
    }

    check_cancelled(cancelled)?;
    progress(on_progress, "cleanup", 20, "Cleanup complete", status.matched, need_copy.len(), need_copy.len() + unchanged, &progress_path);

    // ── Phase 4: Build import index ──
    let index = ImportIndex::scan(import_dir)?;

    check_cancelled(cancelled)?;
    progress(on_progress, "index", 30, "Import index built", 0, need_copy.len(), need_copy.len() + unchanged, &progress_path);

    // ── Phase 5: Copy matching ROMs + CHDs ──
    let game_map: HashMap<String, &GameEntry> = all_games.iter().map(|g| (g.name.clone(), g)).collect();

    let mut matched = 0usize;
    let mut missing = Vec::new();

    for game_name in &need_copy {
        // Determine platform subdirectory
        let platform = game_map.get(game_name).map(|g| &g.platform).filter(|p| !p.is_empty());
        let dest = if let Some(p) = platform {
            roms_dir.join(p).join(format!("{}.zip", game_name))
        } else {
            roms_dir.join(format!("{}.zip", game_name))
        };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Periodic progress + cancellation check
        if matched % 50 == 0 {
            check_cancelled(cancelled)?;
            let pct = 30 + ((matched as u64 * 60) / need_copy.len().max(1) as u64) as u32;
            progress(on_progress, "copying", pct, &format!("Copying ROMs ({}/{})", matched, need_copy.len()), matched, missing.len(), need_copy.len() + unchanged, &progress_path);
        }

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

            // Copy CHD files alongside the game zip (if any)
            let chds = ImportIndex::find_chd_files(&src_path);
            if !chds.is_empty() {
                let chd_dest_base = collection_dir.join(CHD_DIR_NAME).join(game_name);
                for chd_src in &chds {
                    let chd_dest = chd_dest_base.join(
                        chd_src.file_name().unwrap_or_default(),
                    );
                    std::fs::create_dir_all(chd_dest.parent().unwrap())?;
                    std::fs::copy(chd_src, &chd_dest)?;
                    info!("  CHD {} → {}", chd_src.display(), chd_dest.display());
                }
            }
        } else {
            missing.push(game_name.clone());
        }
    }

    // ── Phase 5b: Copy samples folder ──
    let import_samples = import_dir.join(SAMPLES_DIR_NAME);
    if import_samples.is_dir() {
        let dest_samples = collection_dir.join(SAMPLES_DIR_NAME);
        std::fs::create_dir_all(&dest_samples)?;
        for entry in walk_files(&import_samples)? {
            if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
                let rel = entry.strip_prefix(&import_samples).unwrap_or(&entry);
                let dst = dest_samples.join(rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if !dst.exists() {
                    std::fs::copy(&entry, &dst)?;
                    info!("  Sample {} → {}", entry.display(), dst.display());
                }
            }
        }
    }

    check_cancelled(cancelled)?;
    progress(on_progress, "copying", 95, &format!("Copy complete ({}/{})", matched, need_copy.len()), matched, missing.len(), need_copy.len() + unchanged, &progress_path);

    // ── Phase 6: Replace old version (update mode) ──
    if force_update {
        if let Some(p) = prev {
            info!("Removing old version: {} {}", source, p.version);
            db.delete_version(p.id)?;
        }
    }

    // ── Phase 7: Save status + report ──
    status.matched = matched + status.matched;

    progress(on_progress, "saving", 98, "Saving status...", status.matched, missing.len(), need_copy.len() + unchanged, &progress_path);
    status.missing = missing.len();
    status.missing_games = missing.clone();
    status.unchanged = unchanged;
    status.last_run = Some(chrono_now());
    write_status(&status_path, &status)?;

    let result = BuildResult {
        total_games: need_copy.len() + unchanged,
        matched,
        unchanged,
        missing: missing.len(),
        cleaned: status.cleaned,
        missing_games: missing,
        mode: status.mode.clone(),
        version: latest.version.clone(),
        prev_version: prev.map(|p| p.version.clone()),
    };

    progress(on_progress, "done", 100, "Build complete", result.matched, result.missing, result.total_games, &progress_path);

    Ok(result)
}

// ── Helpers ──

fn read_status(path: &Path) -> Option<BuildStatus> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_progress(path: &Path, progress: &BuildProgress) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(progress)
        .map_err(|e| Error::Parse(format!("Failed to serialize progress: {}", e)))?;
    std::fs::write(path, json)?;
    Ok(())
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
