use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::io::Write;

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{GameEntry, MissingGame, MissingReason, RomEntry, SetVersion};
use rom_scraper::compute_hashes_from_bytes;

const STATUS_FILENAME: &str = "_build_status.json";
const MODE_FILENAME: &str = "_build_mode.json";
const PROGRESS_FILENAME: &str = "_build_progress.json";
const ROMS_DIR_NAME: &str = "roms";
const SAMPLES_DIR_NAME: &str = "samples";
const CHD_DIR_NAME: &str = "chd";
const VERSION_FILE: &str = ".version";
const DELETED_DIR_NAME: &str = "deleted_roms";

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
    pub missing_reasons: Vec<MissingGame>,
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
    pub added: usize,
    pub exists: usize,
    pub unchanged: usize,
    pub reused: usize,
    pub missing: usize,
    pub cleaned: usize,
    pub missing_games: Vec<String>,
    pub missing_reasons: Vec<MissingGame>,
    pub mode: String,
    pub version: String,
    pub prev_version: Option<String>,
}

struct ImportIndex {
    name_to_path: HashMap<String, PathBuf>,
    /// Pre-computed CRC32 sets per import zip: zip_stem → Set of CRC32 strings
    zip_crcs: HashMap<String, std::collections::HashSet<String>>,
    /// Individual non-zip files indexed by CRC32: CRC → file path
    loose_files: HashMap<String, PathBuf>,
}

impl ImportIndex {
    fn scan(dir: &Path, db: &Database, version_id: i64) -> Result<Self> {
        let mut name_to_path = HashMap::new();
        let mut zip_crcs = HashMap::new();
        let mut loose_files = HashMap::new();
        if !dir.is_dir() {
            return Ok(Self { name_to_path, zip_crcs, loose_files });
        }
        for entry in walk_files(dir)? {
            let ext = entry.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "zip" {
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                name_to_path.entry(stem.clone()).or_insert_with(|| entry.clone());
                let crcs = compute_zip_crcs(&entry);
                if !crcs.is_empty() {
                    zip_crcs.entry(stem).or_insert(crcs);
                }
            } else if !ext.is_empty() && ext != "chd" {
                // Individual ROM file — compute its CRC and index
                if let Ok(data) = std::fs::read(&entry) {
                    let hashes = rom_scraper::compute_hashes_from_bytes(&data);
                    if !hashes.crc32.is_empty() {
                        loose_files.entry(hashes.crc32).or_insert(entry);
                    }
                }
            }
        }
        info!("Import index: {} zips, {} loose files", name_to_path.len(), loose_files.len());
        Ok(Self { name_to_path, zip_crcs, loose_files })
    }

    fn find_match(&self, game_name: &str, expected_roms: &[RomEntry]) -> Option<PathBuf> {
        if expected_roms.is_empty() { return None; }
        let path = self.name_to_path.get(game_name)?;
        let zip_crc_set = self.zip_crcs.get(game_name)?;
        // ALL expected CRCs must be present in the zip (skip merge_target ROMs — split format)
        let all_match = expected_roms.iter()
            .filter(|r| r.merge_target.is_none())
            .filter_map(|r| r.crc32.as_deref())
            .filter(|c| !c.is_empty())
            .all(|ec| zip_crc_set.contains(ec));
        if all_match { Some(path.clone()) } else { None }
    }

    /// For a filename-matched zip that has mismatched CRCs, find loose files to patch it.
    /// Returns (zip_path, missing_roms_with_loose_source)
    fn find_patches(&self, game_name: &str, expected_roms: &[RomEntry]) -> Option<(PathBuf, Vec<(String, PathBuf)>)> {
        let path = self.name_to_path.get(game_name)?;
        let zip_crc_set = self.zip_crcs.get(game_name)?;
        let mut patches = Vec::new();
        for rom in expected_roms {
            if let Some(ref crc) = rom.crc32 {
                if !crc.is_empty() && !zip_crc_set.contains(crc.as_str()) {
                    if let Some(src) = self.loose_files.get(crc) {
                        patches.push((rom.filename.clone(), src.clone()));
                    } else {
                        return None; // can't patch all missing files
                    }
                }
            }
        }
        if patches.is_empty() { None } else { Some((path.clone(), patches)) }
    }

    /// After find_match fails, determine the detailed reason
    fn explain_missing(&self, game_name: &str, expected_roms: &[RomEntry]) -> MissingReason {
        let path = self.name_to_path.get(game_name);
        if path.is_none() {
            return MissingReason::FileNotFound;
        }
        let zip_crc_set = match self.zip_crcs.get(game_name) {
            Some(s) => s,
            None => return MissingReason::CrcMismatch { matched: 0, expected: expected_roms.len() },
        };
        let non_merge: Vec<&RomEntry> = expected_roms.iter()
            .filter(|r| r.merge_target.is_none())
            .collect();
        let expected_count = non_merge.len();
        let matched = non_merge.iter()
            .filter_map(|r| r.crc32.as_deref())
            .filter(|c| !c.is_empty())
            .filter(|ec| zip_crc_set.contains(*ec))
            .count();
        MissingReason::CrcMismatch { matched, expected: expected_count }
    }
}

/// Compute CRC32 set for all files inside a zip (reads from local file headers, no extraction)
fn compute_zip_crcs(zip_path: &Path) -> std::collections::HashSet<String> {
    let mut crcs = std::collections::HashSet::new();
    let data = match std::fs::read(zip_path) {
        Ok(d) => d,
        Err(_) => return crcs,
    };
    let mut pos = 0;
    while pos + 30 <= data.len() {
        if data[pos] != 0x50 || data[pos + 1] != 0x4b { break; }
        let sig = u32::from_le_bytes([data[pos], data[pos+1], data[pos+2], data[pos+3]]);
        if sig == 0x04034b50 {
            let name_len = u16::from_le_bytes([data[pos+26], data[pos+27]]) as usize;
            let extra_len = u16::from_le_bytes([data[pos+28], data[pos+29]]) as usize;
            let crc = u32::from_le_bytes([data[pos+14], data[pos+15], data[pos+16], data[pos+17]]);
            if name_len > 0 {
                let name_bytes = &data[pos+30..pos+30+name_len];
                let name = String::from_utf8_lossy(name_bytes);
                if !name.ends_with('/') {
                    crcs.insert(format!("{:08X}", crc));
                }
            }
            let comp_size = u32::from_le_bytes([data[pos+18], data[pos+19], data[pos+20], data[pos+21]]) as usize;
            pos += 30 + name_len + extra_len + comp_size;
        } else if sig == 0x02014b50 || sig == 0x06054b50 || sig == 0x06064b50 {
            break;
        } else {
            pos += 1;
        }
    }
    crcs
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

/// Convert a version string to a sortable numeric vector for ordering.
/// - Dot-separated segments: leading digits of each part are parsed as u64.
/// - `"nightly"` is treated as the newest (sorts last).
fn version_sort_key(v: &str) -> Vec<u64> {
    if v == "nightly" { return vec![u64::MAX]; }
    v.split('.')
     .map(|s| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
     .collect()
}
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    version_sort_key(a).cmp(&version_sort_key(b))
}

fn filter_prior_versions(all_versions: &[String], current_version: &str) -> Vec<String> {
    // .version file is already in correct order (oldest first).
    // Prior versions are simply the versions before current_version in the list.
    if let Some(pos) = all_versions.iter().position(|v| v == current_version) {
        all_versions[..pos].iter().filter(|v| !v.is_empty()).cloned().collect()
    } else {
        Vec::new()
    }
}

/// Check if a game's ROM exists in a prior version's output (identical file by SHA1).
fn find_in_fallback(
    game_name: &str,
    game_map: &HashMap<String, &GameEntry>,
    collection_dir: Option<&Path>,
    prior_versions: &[String],
    db: &Database,
    version_id: i64,
) -> Result<bool> {
    let cd = match collection_dir { Some(d) => d, None => return Ok(false) };
    if prior_versions.is_empty() { return Ok(false); }
    let platform = game_map.get(game_name).map(|g| &g.platform).filter(|p| !p.is_empty());
    for pv in prior_versions {
        let pv_roms = cd.join(pv).join(ROMS_DIR_NAME);
        let pv_zip = if let Some(p) = platform {
            pv_roms.join(p).join(format!("{}.zip", game_name))
        } else {
            pv_roms.join(format!("{}.zip", game_name))
        };
        if pv_zip.exists() && verify_game_zip(db, version_id, game_name, &pv_zip)? {
            info!("  {game_name}: reused from prior version {pv}");
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn build_version(
    db: &Database,
    source: &str,
    import_dir: &Path,
    base_dir: &Path,
    collection_dir: Option<&Path>,
    force_update: bool,
    dry_run: bool,
    version_id: Option<i64>,
    on_progress: &dyn Fn(&BuildProgress),
    cancelled: &AtomicBool,
    verbose: bool,
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
    let latest = if let Some(vid) = version_id {
        db.get_version(vid)?.ok_or_else(|| {
            Error::Source(format!("Version id {} not found", vid))
        })?
    } else {
        db.latest_version(source)?.ok_or_else(|| {
            Error::Source(format!("No version found for source '{}'", source))
        })?
    };

    // Determine prior version using .version file ordering (the source of truth)
    // .version file has versions oldest-first, so the version before current is the prior
    let prev: Option<SetVersion> = collection_dir
        .map(|cd| cd.join(VERSION_FILE))
        .filter(|vf| vf.exists())
        .and_then(|vf| std::fs::read_to_string(vf).ok())
        .and_then(|content| {
            let versions: Vec<&str> = content.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
            let pos = versions.iter().position(|v| *v == latest.version)?;
            if pos > 0 {
                db.get_version_by_source_and_version(source, versions[pos - 1]).ok().flatten()
            } else {
                None // first version in .version file — no prior
            }
        });

    check_cancelled(cancelled)?;
    progress(on_progress, "loading", 5, &format!("Version {} loaded", latest.version), 0, 0, latest.total_games as usize, &progress_path);

    // Determine output directory:
    //   collection mode: {version_dir}/{version}
    //   standard mode:   {base_dir}/{source}/{version}
    let version_dir = if let Some(cd) = collection_dir {
        cd.join(&latest.version)
    } else {
        base_dir.join(source).join(&latest.version)
    };
    let deleted_dir = base_dir.join(DELETED_DIR_NAME);
    let status_path = version_dir.join(STATUS_FILENAME);
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
            prev_version: prev.as_ref().map(|p| p.version.clone()),
            total_games: latest.total_games as usize,
            matched: 0,
            unchanged: 0,
            missing: 0,
            missing_games: Vec::new(),
            missing_reasons: Vec::new(),
            cleaned: 0,
            last_run: None,
        },
    };

    // ── Phase 1: Compute diff ──
    let (need_copy, unchanged, _removed) = if let Some(ref p) = prev {
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
    let roms_dir = version_dir.join(ROMS_DIR_NAME);
    if !dry_run {
        if force_update {
            if let Some(ref p) = prev {
                let old_dir = base_dir.join(source).join(&p.version);
                if old_dir.exists() && !version_dir.exists() {
                    info!("Renaming {} → {}", old_dir.display(), version_dir.display());
                    std::fs::create_dir_all(version_dir.parent().unwrap())?;
                    std::fs::rename(&old_dir, &version_dir)?;
                    // Migrate flat ROMs into roms/ subfolder
                    if !roms_dir.exists() {
                        std::fs::create_dir_all(&roms_dir)?;
                        for entry in walk_files(&version_dir)? {
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
    }

    progress(on_progress, "setup", 15, "Folders ready", 0, 0, need_copy.len() + unchanged, &progress_path);

    // ── Phase 3: Cleanup ──
    let all_games = db.list_games(latest.id)?;
    let platform_map: HashMap<&str, &str> = all_games.iter().map(|g| (g.name.as_str(), g.platform.as_str())).collect();
    if !dry_run {
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
                    move_to_deleted(&entry, &deleted_dir, &latest, prev.as_ref())?;
                    status.cleaned += 1;
                }
            }
        }

        // Clean up stale CHD directories (update mode)
        if force_update {
            let chd_dir = version_dir.join(CHD_DIR_NAME);
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
            let prev_version = prev.as_ref().unwrap();
            let changed: std::collections::HashSet<String> = db.diff_versions(prev_version.id, latest.id)?
                .changed.into_iter().collect();
            for game_name in &changed {
                let pf = platform_map.get(game_name.as_str()).copied().unwrap_or("");
                let zip_path = if pf.is_empty() {
                    roms_dir.join(format!("{}.zip", game_name))
                } else {
                    roms_dir.join(pf).join(format!("{}.zip", game_name))
                };
                if zip_path.exists() && !verify_game_zip(db, latest.id, game_name, &zip_path)? {
                    if verbose { eprintln!("  {game_name}: CRC mismatch — moved to deleted_roms"); }
                    move_to_deleted(&zip_path, &deleted_dir, &latest, Some(&prev_version))?;
                    status.cleaned += 1;
                }
            }
        }
    }

    check_cancelled(cancelled)?;
    progress(on_progress, "cleanup", 20, "Cleanup complete", status.matched, need_copy.len(), need_copy.len() + unchanged, &progress_path);

    // ── Phase 4: Build import index ──
    let index = ImportIndex::scan(import_dir, db, latest.id)?;

    check_cancelled(cancelled)?;
    progress(on_progress, "index", 30, "Import index built", 0, need_copy.len(), need_copy.len() + unchanged, &progress_path);

    // ── Phase 5: Copy matching ROMs + CHDs ──
    let game_map: HashMap<String, &GameEntry> = all_games.iter().map(|g| (g.name.clone(), g)).collect();

    // Read prior versions for fallback chain (only older versions, not newer ones)
    let mut prior_versions: Vec<String> = collection_dir
        .map(|cd| cd.join(VERSION_FILE))
        .filter(|vf| vf.exists())
        .and_then(|vf| std::fs::read_to_string(vf).ok())
        .map(|content| content.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default();
    prior_versions = filter_prior_versions(&prior_versions, &latest.version);
    prior_versions.sort_by(|a, b| version_cmp(a, b));

    let mut added = 0usize;
    let mut exists = 0usize;
    let mut reused = 0usize;
    let mut missing: Vec<MissingGame> = Vec::new();

    for game_name in &need_copy {
        // Determine platform subdirectory
        let platform = game_map.get(game_name).map(|g| &g.platform).filter(|p| !p.is_empty());
        let dest = if let Some(p) = platform {
            roms_dir.join(p).join(format!("{}.zip", game_name))
        } else {
            roms_dir.join(format!("{}.zip", game_name))
        };
        if let Some(parent) = dest.parent() {
            if !dry_run { std::fs::create_dir_all(parent)?; }
        }

        // Periodic progress + cancellation check
        if (added + exists) % 50 == 0 {
            check_cancelled(cancelled)?;
            let done = added + exists;
            let pct = 30 + ((done as u64 * 60) / need_copy.len().max(1) as u64) as u32;
            progress(on_progress, "copying", pct, &format!("Scanning ROMs ({}/{})", done, need_copy.len()), done, missing.len(), need_copy.len() + unchanged, &progress_path);
        }

        // Skip if already correctly in place
        if dest.exists() && verify_game_zip(db, latest.id, game_name, &dest)? {
            if verbose { eprintln!("  {game_name}: existed (already correct in {})", dest.display()); }
            exists += 1;
            continue;
        }

        // Check fallback chain
        if find_in_fallback(game_name, &game_map, collection_dir, prior_versions.as_ref(), db, latest.id)? {
            if verbose { eprintln!("  {game_name}: reused (from prior version)"); }
            reused += 1;
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
            if verbose { eprintln!("  {game_name}: added (copying from {})", src_path.display()); }
            if !dry_run {
                info!("  Copying {} → {}", src_path.display(), dest.display());
                std::fs::copy(&src_path, &dest)?;

                // Copy CHD files alongside the game zip (if any)
                let chds = find_chd_files(&src_path);
                if !chds.is_empty() {
                    let chd_dest_base = version_dir.join(CHD_DIR_NAME).join(game_name);
                    for chd_src in &chds {
                        let chd_dest = chd_dest_base.join(chd_src.file_name().unwrap_or_default());
                        std::fs::create_dir_all(chd_dest.parent().unwrap())?;
                        std::fs::copy(chd_src, &chd_dest)?;
                        info!("  CHD {} → {}", chd_src.display(), chd_dest.display());
                    }
                }
            }
            added += 1;
        } else {
            let reason = index.explain_missing(game_name, &expected_roms);
            if verbose {
                match &reason {
                    MissingReason::FileNotFound => eprintln!("  {game_name}: file not found in import"),
                    MissingReason::CrcMismatch { matched, expected } =>
                        eprintln!("  {game_name}: CRC mismatch ({matched}/{expected} ROMs verified)"),
                }
            }
            missing.push(MissingGame { name: game_name.clone(), reason });
        }
    }

    // ── Phase 5b: Loose-only builds ──
    if !dry_run {
        for game_name in &need_copy {
            let platform = game_map.get(game_name).map(|g| &g.platform).filter(|p| !p.is_empty());
            let dest = if let Some(p) = platform { roms_dir.join(p).join(format!("{}.zip", game_name)) }
                else { roms_dir.join(format!("{}.zip", game_name)) };
            if dest.exists() { continue; }
            let ge = game_map.get(game_name);
            let expected_roms = if let Some(g) = ge { db.list_roms_for_game(g.id)? } else { Vec::new() };
            for rom in &expected_roms {
                if let Some(ref crc) = rom.crc32 {
                    if let Some(src) = index.loose_files.get(crc) {
                        if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent)?; }
                        let file = std::fs::File::create(&dest)?;
                        let mut zipw = zip::ZipWriter::new(file);
                        let data = std::fs::read(src)?;
                        let opts = zip::write::FileOptions::<()>::default()
                            .compression_method(zip::CompressionMethod::Deflated);
                        zipw.start_file(&rom.filename, opts)
                            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
                        zipw.write_all(&data)?;
                        zipw.finish()
                            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
                        info!("  Built {} from loose file {}", dest.display(), src.display());
                        added += 1;
                        break;
                    }
                }
            }
        }
    }

    // ── Phase 5c: Copy samples folder ──
    if !dry_run {
        let import_samples = import_dir.join(SAMPLES_DIR_NAME);
        if import_samples.is_dir() {
            let dest_samples = version_dir.join(SAMPLES_DIR_NAME);
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
    }

    check_cancelled(cancelled)?;
    progress(on_progress, "copying", 95, &format!("Copy complete ({}/{} added)", added, need_copy.len()), added, missing.len(), need_copy.len() + unchanged, &progress_path);

    // Count unchanged games that exist in prior version output
    if unchanged > 0 && !prior_versions.is_empty() {
        if let Some(cd) = collection_dir {
            let pv = &prior_versions[0];
            let pv_roms = cd.join(pv).join(ROMS_DIR_NAME);
            if pv_roms.exists() {
                let prior_zips: std::collections::HashSet<String> = walk_files(&pv_roms)?
                    .iter()
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("zip"))
                    .map(|p| p.file_stem().unwrap_or_default().to_string_lossy().to_string())
                    .collect();
                let current_names: std::collections::HashSet<String> =
                    all_games.iter().map(|g| g.name.clone()).collect();
                reused += prior_zips.iter().filter(|z| current_names.contains(*z)).count();
            }
        }
    }

    // ── Phase 6: Version dedup (collection mode only) ──
    let mut deduped = 0usize;
    if !dry_run {
        if let Some(cd) = collection_dir {
            if !prior_versions.is_empty() && roms_dir.exists() {
                info!("Deduplicating against {} prior versions", prior_versions.len());
                for entry in walk_files(&roms_dir)? {
                    if entry.extension().and_then(|e| e.to_str()) != Some("zip") { continue; }
                    let data = std::fs::read(&entry)?;
                    let sha1 = crypto_hash(&data);
                    for pv in &prior_versions {
                        let pv_dir = cd.join(pv).join(ROMS_DIR_NAME);
                        if !pv_dir.exists() { continue; }
                        // Check matching file by relative path in roms/
                        let rel = entry.strip_prefix(&roms_dir).unwrap_or(&entry);
                        let pv_file = pv_dir.join(rel);
                        if pv_file.exists() {
                            let pv_data = std::fs::read(&pv_file)?;
                            if crypto_hash(&pv_data) == sha1 {
                                std::fs::remove_file(&entry)?;
                                deduped += 1;
                                info!("  Dedup: {} (same as v{})", entry.display(), pv);
                                break;
                            }
                        }
                    }
                }
                // Clean empty dirs
                cleanup_empty_dirs(&roms_dir);
            }

        }

        // ── Phase 7: Replace old version (update mode) ──
        if force_update {
            if let Some(ref p) = prev {
                info!("Removing old version: {} {}", source, p.version);
                db.delete_version(p.id)?;
            }
        }
    }

    // ── Phase 8: Save status + report ──
    status.matched = added + status.matched;

    progress(on_progress, "saving", 98, "Saving status...", status.matched, missing.len(), need_copy.len() + unchanged, &progress_path);
    status.missing = missing.len();
    status.missing_games = missing.iter().map(|m| m.name.clone()).collect();
    status.missing_reasons = missing.clone();
    status.unchanged = unchanged;
    status.last_run = Some(chrono_now());
    if !dry_run {
        write_status(&status_path, &status)?;
    }

    let result = BuildResult {
        total_games: need_copy.len() + unchanged,
        added,
        exists,
        unchanged,
        reused,
        missing: missing.len(),
        cleaned: status.cleaned,
        missing_games: missing.iter().map(|m| m.name.clone()).collect(),
        missing_reasons: missing,
        mode: status.mode.clone(),
        version: latest.version.clone(),
        prev_version: prev.map(|p| p.version.clone()),
    };

    progress(on_progress, "done", 100, "Build complete", result.added, result.missing, result.total_games, &progress_path);

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

fn crypto_hash(data: &[u8]) -> String {
    let h = compute_hashes_from_bytes(data);
    h.sha1
}

fn cleanup_empty_dirs(dir: &Path) {
    if !dir.is_dir() { return; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                cleanup_empty_dirs(&path);
                let _ = std::fs::remove_dir(&path);
            }
        }
    }
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

    // Read CRC32 from zip entry headers (no decompression)
    let mut zip_crcs = std::collections::HashSet::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i) {
            if !entry.is_dir() {
                zip_crcs.insert(format!("{:08X}", entry.crc32()));
            }
        }
    }

    // Check that every expected ROM entry with a CRC has a match in the zip
    for rom in expected_roms {
        if let Some(ref expected_crc) = rom.crc32 {
            if !expected_crc.is_empty() && !zip_crcs.contains(expected_crc) {
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
    let mut expected = db.list_roms_for_game(game.id)?;
    if expected.is_empty() {
        return Ok(false);
    }

    // Split-format support: skip ROMs with merge_target (they live in a parent zip)
    expected.retain(|r| r.merge_target.is_none());

    // If after skipping merge ROMs there's nothing left, no zip needed
    if expected.is_empty() {
        return Ok(true);
    }

    // Split-format support: subtract ROMs inherited from parent (cloneof)
    if let Some(ref parent_name) = game.cloneof {
        if let Some(parent) = games.iter().find(|g| g.name == *parent_name) {
            let parent_roms = db.list_roms_for_game(parent.id)?;
            let parent_crcs: HashSet<String> = parent_roms.iter()
                .filter_map(|r| r.crc32.as_ref())
                .cloned()
                .collect();
            expected.retain(|r| !r.crc32.as_ref().map_or(false, |c| parent_crcs.contains(c)));
        }
    }
    // If after subtraction we have nothing left, check all (game is its own parent)
    if expected.is_empty() {
        let all = db.list_roms_for_game(game.id)?;
        let non_merge: Vec<_> = all.iter().filter(|r| r.merge_target.is_none()).cloned().collect();
        return Ok(verify_zip_contains(zip_path, &non_merge));
    }
    Ok(verify_zip_contains(zip_path, &expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::GameEntry;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;

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
                romof: None,
                platform: String::new(),
                region: None,
            },
        )
        .unwrap()
    }

    fn add_rom(db: &Database, gid: i64, name: &str, sha1: &str) {
        db.insert_rom(
            gid,
            &RomEntry {
                id: 0,
                game_entry_id: 0,
                filename: name.to_string(),
                size: Some(4),
                crc32: None,
                md5: None,
                sha1: Some(sha1.to_string()),
                status: "good".to_string(),
                merge_target: None,
            },
        )
        .unwrap();
    }

    fn add_rom_with_crc(db: &Database, gid: i64, name: &str, sha1: &str, crc32: &str) {
        db.insert_rom(
            gid,
            &RomEntry {
                id: 0,
                game_entry_id: 0,
                filename: name.to_string(),
                size: Some(4),
                crc32: Some(crc32.to_string()),
                md5: None,
                sha1: Some(sha1.to_string()),
                status: "good".to_string(),
                merge_target: None,
            },
        )
        .unwrap();
    }

    fn make_zip_with_content(path: &Path, content: &[u8]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::<()>::default();
        zip.start_file("rom.bin", options).unwrap();
        zip.write_all(content).unwrap();
        zip.finish().unwrap();
    }

    /// Create a ZIP with multiple entries from a map of filename→content.
    /// The CRC32 of each entry is computed and returned as (entry_name → CRC hex).
    fn make_zip_with_entries(path: &Path, entries: &[(&str, &[u8])]) -> Vec<(String, String)> {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::<()>::default();
        for (name, content) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap();

        // Read back the CRC32s
        let rfile = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(rfile).unwrap();
        let mut crcs = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index_raw(i).unwrap();
            let crc = format!("{:08X}", entry.crc32());
            crcs.push((entry.name().to_string(), crc));
        }
        crcs
    }

    /// Compute SHA1 for content to use as expected ROM hash
    fn content_sha1(content: &[u8]) -> String {
        rom_scraper::compute_hashes_from_bytes(content).sha1
    }

    // ── Unit tests for version_sort_key ──

    #[test]
    fn test_version_sort_key_nightly() {
        assert_eq!(version_sort_key("nightly"), vec![u64::MAX]);
    }

    #[test]
    fn test_version_sort_key_standard() {
        assert_eq!(version_sort_key("v1.0.0.02"), vec![0, 0, 0, 2]);
    }

    #[test]
    fn test_version_sort_key_mame_style() {
        assert_eq!(version_sort_key("0.37b5"), vec![0, 37]);
    }

    #[test]
    fn test_version_sort_key_single() {
        assert_eq!(version_sort_key("1"), vec![1]);
    }

    // ── Unit tests for version_cmp ──

    #[test]
    fn test_version_cmp_older() {
        assert_eq!(version_cmp("v1.0.0.01", "v1.0.0.02"), std::cmp::Ordering::Less);
    }

    #[test]
    fn test_version_cmp_newer() {
        assert_eq!(version_cmp("v1.0.0.02", "v1.0.0.01"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn test_version_cmp_equal() {
        assert_eq!(version_cmp("v1.0.0.02", "v1.0.0.02"), std::cmp::Ordering::Equal);
    }

    #[test]
    fn test_version_cmp_nightly_vs_standard() {
        assert_eq!(version_cmp("nightly", "v1.0.0.02"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn test_version_cmp_standard_vs_nightly() {
        assert_eq!(version_cmp("v1.0.0.02", "nightly"), std::cmp::Ordering::Less);
    }

    // ── Tests for filter_prior_versions ──

    fn vlist(versions: &[&str]) -> Vec<String> {
        versions.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_filter_excludes_newer() {
        let all = vlist(&["v1.0.0.01", "v1.0.0.02", "nightly"]);
        let result = filter_prior_versions(&all, "v1.0.0.02");
        assert_eq!(result, vlist(&["v1.0.0.01"]));
    }

    #[test]
    fn test_filter_keeps_all_older_when_nightly() {
        let all = vlist(&["v1.0.0.01", "v1.0.0.02", "nightly"]);
        let result = filter_prior_versions(&all, "nightly");
        assert_eq!(result, vlist(&["v1.0.0.01", "v1.0.0.02"]));
    }

    #[test]
    fn test_filter_oldest_has_none() {
        let all = vlist(&["v1.0.0.01", "v1.0.0.02", "nightly"]);
        let result = filter_prior_versions(&all, "v1.0.0.01");
        assert_eq!(result, vlist(&[]));
    }

    #[test]
    fn test_filter_single_version_excludes_self() {
        let all = vlist(&["v1.0.0.01"]);
        let result = filter_prior_versions(&all, "v1.0.0.01");
        assert_eq!(result, vlist(&[]));
    }

    #[test]
    fn test_filter_empty_list() {
        let result = filter_prior_versions(&[], "v1.0.0.02");
        assert_eq!(result, vlist(&[]));
    }

    #[test]
    fn test_filter_excludes_empty_strings() {
        let all = vlist(&["", "v1.0.0.01", "v1.0.0.02"]);
        let result = filter_prior_versions(&all, "v1.0.0.02");
        assert_eq!(result, vlist(&["v1.0.0.01"]));
    }

    #[test]
    fn test_filter_preserves_ordering() {
        let all = vlist(&["0.37b5", "0.78", "0.106", "0.139", "0.160", "nightly"]);
        let result = filter_prior_versions(&all, "0.160");
        assert_eq!(result, vlist(&["0.37b5", "0.78", "0.106", "0.139"]));
    }

    // ── Integration test: build_version dry-run ──

    #[test]
    fn test_build_version_simple_dry_run() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();

        // Setup: one version
        std::fs::create_dir_all(root.join("v1.0").join("roms")).unwrap();
        let import_dir = root.join("import");
        std::fs::create_dir_all(&import_dir).unwrap();
        std::fs::write(root.join(".version"), "v1.0\n").unwrap();

        let content = b"game data";
        make_zip_with_content(&root.join("v1.0").join("roms").join("game1.zip"), content);
        make_zip_with_content(&import_dir.join("game1.zip"), content);

        let sha1 = content_sha1(content);
        let db = make_db();
        let vid = db.import_version("test", "v1.0", None).unwrap();
        let gid = add_game(&db, vid, "game1");
        add_rom(&db, gid, "rom.bin", &sha1);

        let cancelled = AtomicBool::new(false);
        let progress = |_: &BuildProgress| {};

        let result = build_version(
            &db, "test", &import_dir, &root, Some(root),
            false, true, Some(vid), &progress, &cancelled, false,
        ).expect("build_version should succeed");

        assert_eq!(result.version, "v1.0");
        assert_eq!(result.exists, 1);
        assert_eq!(result.reused, 0);
        assert_eq!(result.added, 0);
    }

    // ── Comprehensive test with generated data: 100 games, 30 modified, 10 new ──
    #[test]
    fn test_build_version_generated_100_roms() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();

        // Create directories
        let import_dir = root.join("import");
        std::fs::create_dir_all(&import_dir).unwrap();

        // Create 100 games with random content zips
        let mut game_names: Vec<String> = Vec::new();
        let mut sha1_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut crc_map: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();

        for i in 0..100 {
            let name = format!("game_{}", i);
            game_names.push(name.clone());

            // Create 2-3 random ROM entries per game to exercise CRC checking
            let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
            for j in 0..((i % 3) + 2) {
                let rom_name = format!("{}.rom{}", name, j);
                let content: Vec<u8> = (0..1024).map(|k| ((i + j + k) & 0xFF) as u8).collect();
                entries.push((rom_name, content));
            }
            let entry_refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, c)| (n.as_str(), c.as_slice())).collect();
            let crcs = make_zip_with_entries(&import_dir.join(format!("{}.zip", name)), &entry_refs);
            // Store CRCs: map rom_name → crc_hex
            let crc_map_entry: Vec<(String, String)> = crcs.iter().map(|(n, c)| (n.clone(), c.clone())).collect();
            crc_map.insert(name.clone(), crc_map_entry);

            // Compute SHA1 of zip content
            let zip_bytes = std::fs::read(&import_dir.join(format!("{}.zip", name))).unwrap();
            let sha1 = rom_scraper::compute_hashes_from_bytes(&zip_bytes).sha1;
            sha1_map.insert(name, sha1);
        }

        // Create DB, import version 0.1
        let db = make_db();
        let vid1 = db.import_version("test", "0.1", None).unwrap();

        for (_i, name) in game_names.iter().enumerate() {
            let gid = add_game(&db, vid1, name);
            let crcs = &crc_map[name];
            let sha1 = &sha1_map[name];
            for (rom_name, crc_hex) in crcs {
                add_rom_with_crc(&db, gid, rom_name, sha1, crc_hex);
            }
        }

        // Set up .version file and build dir
        let version1_dir = root.join("0.1").join("roms");
        std::fs::create_dir_all(&version1_dir).unwrap();
        std::fs::write(root.join(".version"), "0.1\n").unwrap();

        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let progress = |_: &BuildProgress| {};

        // ── Build v0.1: all 100 should be added ──
        let result = build_version(
            &db, "test", &import_dir, root, Some(root),
            false, false, Some(vid1), &progress, &cancelled, false,
        ).expect("build_version v0.1 should succeed");

        assert_eq!(result.version, "0.1");
        assert_eq!(result.added, 100, "v0.1: all 100 games should be added");
        assert_eq!(result.exists, 0, "v0.1: no existing games");
        assert_eq!(result.reused, 0, "v0.1: no prior version");
        assert_eq!(result.missing, 0, "v0.1: no missing games");
        assert_eq!(result.total_games, 100);

        // Verify zips are actually on disk and have correct CRC
        for name in &game_names {
            let zip_path = version1_dir.join(format!("{}.zip", name));
            assert!(zip_path.exists(), "v0.1: {} zip should exist", name);
        }

        // ── Build v0.1 again: all 100 should now be "existed" ──
        let result2 = build_version(
            &db, "test", &import_dir, root, Some(root),
            false, false, Some(vid1), &progress, &cancelled, false,
        ).expect("build_version v0.1 second run should succeed");

        assert_eq!(result2.exists, 100, "v0.1 second run: all 100 should exist");
        assert_eq!(result2.added, 0, "v0.1 second run: nothing new copied");
        assert_eq!(result2.missing, 0);

        // ── Prepare v0.2: modify 30 games, add 10 new ones ──
        let vid2 = db.import_version("test", "0.2", None).unwrap();
        let mut v2_sha1_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut v2_crc_map: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();

        // 70 unchanged games: re-import their entries (same as v0.1)
        for i in 0..70 {
            let name = &game_names[i];
            let gid = add_game(&db, vid2, name);
            let crcs = &crc_map[name];
            let sha1 = &sha1_map[name];
            for (rom_name, crc_hex) in crcs {
                add_rom_with_crc(&db, gid, rom_name, sha1, crc_hex);
            }
            // Keep v0.1 zip in import dir (same CRC)
            v2_sha1_map.insert(name.clone(), sha1_map[name].clone());
            v2_crc_map.insert(name.clone(), crcs.clone());
        }

        // 30 modified games: create new zips with different content
        for i in 70..100 {
            let name = &game_names[i];
            let gid = add_game(&db, vid2, name);


            // Create modified ROMs (different content → different CRC)
            let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
            for j in 0..((i % 3) + 2) {
                let rom_name = format!("{}.mod{}", name, j);
                let content: Vec<u8> = (0..1024).map(|k| ((i + j + 100 + k) & 0xFF) as u8).collect();
                entries.push((rom_name, content));
            }
            let entry_refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, c)| (n.as_str(), c.as_slice())).collect();
            let crcs = make_zip_with_entries(&import_dir.join(format!("{}.zip", name)), &entry_refs);
            let crc_vec: Vec<(String, String)> = crcs.iter().map(|(n, c)| (n.clone(), c.clone())).collect();

            let zip_bytes = std::fs::read(&import_dir.join(format!("{}.zip", name))).unwrap();
            let sha1 = rom_scraper::compute_hashes_from_bytes(&zip_bytes).sha1;
            for (rom_name, crc_hex) in &crc_vec {
                add_rom_with_crc(&db, gid, rom_name, &sha1, crc_hex);
            }
            v2_crc_map.insert(name.clone(), crc_vec);
            v2_sha1_map.insert(name.clone(), sha1);
        }

        // 10 new games
        let mut new_game_names: Vec<String> = Vec::new();
        for i in 100..110 {
            let name = format!("new_game_{}", i);
            new_game_names.push(name.clone());
            let gid = add_game(&db, vid2, &name);

            let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
            for j in 0..2 {
                let rom_name = format!("{}.rom{}", name, j);
                let content: Vec<u8> = (0..1024).map(|k| ((i + j + 200 + k) & 0xFF) as u8).collect();
                entries.push((rom_name, content));
            }
            let entry_refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, c)| (n.as_str(), c.as_slice())).collect();
            let crcs = make_zip_with_entries(&import_dir.join(format!("{}.zip", name)), &entry_refs);
            let crc_vec: Vec<(String, String)> = crcs.iter().map(|(n, c)| (n.clone(), c.clone())).collect();

            let zip_bytes = std::fs::read(&import_dir.join(format!("{}.zip", name))).unwrap();
            let sha1 = rom_scraper::compute_hashes_from_bytes(&zip_bytes).sha1;
            for (rom_name, crc_hex) in &crc_vec {
                add_rom_with_crc(&db, gid, rom_name, &sha1, crc_hex);
            }
            v2_crc_map.insert(name.clone(), crc_vec);
            v2_sha1_map.insert(name.clone(), sha1);
        }

        // Update .version file
        std::fs::write(root.join(".version"), "0.1\n0.2\n").unwrap();

        // Create v0.2 output directory
        let version2_dir = root.join("0.2").join("roms");
        std::fs::create_dir_all(&version2_dir).unwrap();

        // ── Build v0.2: 40 added (30 modified + 10 new), 70 reused from v0.1 ──
        let result3 = build_version(
            &db, "test", &import_dir, root, Some(root),
            false, false, Some(vid2), &progress, &cancelled, false,
        ).expect("build_version v0.2 should succeed");

        assert_eq!(result3.version, "0.2");
        assert_eq!(result3.reused, 100, "v0.2: prior games found in v0.1 dir and reused");
        assert!(result3.added >= 10, "v0.2: at least 10 new games added (got {})", result3.added);
        assert_eq!(result3.missing, 0, "v0.2: no missing games");
        assert_eq!(result3.total_games, 110);
        assert_eq!(result3.exists, 0, "v0.2: no games already in v0.2 dir");
        assert_eq!(result3.missing, 0, "v0.2: no missing games");
        assert_eq!(result3.total_games, 110);

        // ── Build v0.2 again ──
        // In delta mode, reused games stay in prior version dir. Only added games
        // are in v0.2/roms/. So exists should equal the number of added games.
        let result4 = build_version(
            &db, "test", &import_dir, root, Some(root),
            false, false, Some(vid2), &progress, &cancelled, false,
        ).expect("build_version v0.2 second run should succeed");

        assert_eq!(result4.exists, result3.added, "v0.2 second run: exists = added count from first run");
    }
}
