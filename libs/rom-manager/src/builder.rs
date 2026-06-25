use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Game, MergeMode, MissingGame, MissingReason, RomDetail, RomFile, SampleResult, SetVersion};
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
    #[serde(default)]
    pub samples_added: usize,
    #[serde(default)]
    pub samples_existed: usize,
    #[serde(default)]
    pub samples_reused: usize,
    #[serde(default)]
    pub samples_missing: usize,
    #[serde(default)]
    pub missing_samples: Vec<String>,
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
    pub reused: usize,
    pub missing: usize,
    pub cleaned: usize,
    pub matched_by_hash: usize,
    pub missing_games: Vec<String>,
    pub missing_reasons: Vec<MissingGame>,
    pub mode: String,
    pub version: String,
    pub prev_version: Option<String>,
    pub samples_added: usize,
    pub samples_existed: usize,
    pub samples_reused: usize,
    pub samples_missing: usize,
    pub missing_samples: Vec<String>,
}

struct ImportIndex {
    name_to_path: HashMap<String, PathBuf>,
    /// Platform-aware map: (game_name, platform) → path (more specific than name_to_path)
    name_plat_path: HashMap<(String, String), PathBuf>,
    /// Pre-computed CRC32 sets per import zip: zip_stem → Set of CRC32 strings
    zip_crcs: HashMap<String, std::collections::HashSet<String>>,
    /// Individual non-zip files indexed by CRC32: CRC → file path
    loose_files: HashMap<String, PathBuf>,
    /// Reverse index: CRC32 → set of import zip stems that contain a file with that CRC
    crc_to_zips: HashMap<String, Vec<String>>,
}

/// Known platform folder names that the builder recognizes in the import directory.
/// When a zip sits under one of these subdirectories, it's indexed by both name and platform.
const KNOWN_PLATFORMS: &[&str] = &[
    "arcade", "coleco", "fds", "gamegear", "megadriv", "msx", "neogeo", "nes",
    "ngp", "pce", "sg1000", "sgx", "sms", "tg16", "zxspectrum",
];

impl ImportIndex {
    fn scan(dir: &Path, db: &Database, version_id: i64) -> Result<Self> {
        let mut name_to_path = HashMap::new();
        let mut name_plat_path = HashMap::new();
        let mut zip_crcs = HashMap::new();
        let mut loose_files = HashMap::new();
        let mut crc_to_zips: HashMap<String, Vec<String>> = HashMap::new();
        if !dir.is_dir() {
            return Ok(Self { name_to_path, name_plat_path, zip_crcs, loose_files, crc_to_zips });
        }
        for entry in walk_files(dir)? {
            // Skip files in deleted_roms directory (stale build artifacts)
            if entry.components().any(|c| c.as_os_str() == DELETED_DIR_NAME) {
                continue;
            }
            let ext = entry.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "zip" {
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                name_to_path.entry(stem.clone()).or_insert_with(|| entry.clone());
                // Also index by platform if the zip sits under a known platform subdirectory
                if let Some(parent_name) = entry.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
                    if KNOWN_PLATFORMS.contains(&parent_name) {
                        name_plat_path.entry((stem.clone(), parent_name.to_string())).or_insert_with(|| entry.clone());
                    }
                }
                let crcs = compute_zip_crcs(&entry);
                if !crcs.is_empty() {
                    for crc in &crcs {
                        crc_to_zips.entry(crc.clone()).or_default().push(stem.clone());
                    }
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
        Ok(Self { name_to_path, name_plat_path, zip_crcs, loose_files, crc_to_zips })
    }

    fn find_match(&self, game_name: &str, platform: Option<&str>, expected_roms: &[RomFile]) -> Option<PathBuf> {
        if expected_roms.is_empty() { return None; }
        // Try platform-specific path first (e.g. import_dir/arcade/zoom909.zip)
        if let Some(plat) = platform {
            if let Some(path) = self.name_plat_path.get(&(game_name.to_string(), plat.to_string())) {
                if let Some(zip_crc_set) = self.zip_crcs.get(game_name) {
                    let all_match = expected_roms.iter()
                        .filter(|r| r.merge_target.is_none())
                        .filter_map(|r| r.crc32.as_deref())
                        .filter(|c| !c.is_empty())
                        .all(|ec| zip_crc_set.contains(ec));
                    if all_match { return Some(path.clone()); }
                }
            }
        }
        // Fallback: flat lookup by name
        let path = self.name_to_path.get(game_name)?;
        let zip_crc_set = self.zip_crcs.get(game_name)?;
        let all_match = expected_roms.iter()
            .filter(|r| r.merge_target.is_none())
            .filter_map(|r| r.crc32.as_deref())
            .filter(|c| !c.is_empty())
            .all(|ec| zip_crc_set.contains(ec));
        if all_match { Some(path.clone()) } else { None }
    }

    /// For a filename-matched zip that has mismatched CRCs, find loose files to patch it.
    /// Returns (zip_path, missing_roms_with_loose_source)
    fn find_patches(&self, game_name: &str, expected_roms: &[RomFile]) -> Option<(PathBuf, Vec<(String, PathBuf)>)> {
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

    /// After find_match fails, determine the detailed reason and per-ROM details.
    fn explain_missing(&self, game_name: &str, expected_roms: &[RomFile]) -> (MissingReason, Vec<RomDetail>) {
        let non_merge: Vec<&RomFile> = expected_roms.iter()
            .filter(|r| r.merge_target.is_none())
            .collect();
        let expected_count = non_merge.len();
        let missing_details = || non_merge.iter().map(|r| RomDetail {
            filename: r.filename.clone(),
            expected_crc: r.crc32.clone().unwrap_or_default(),
            actual_crc: None,
            status: "missing".to_string(),
        }).collect();

        let path = match self.name_to_path.get(game_name) {
            Some(p) => p,
            None => return (MissingReason::FileNotFound, missing_details()),
        };

        let zip_crc_set = match self.zip_crcs.get(game_name) {
            Some(s) => s,
            None => return (MissingReason::CrcMismatch { matched: 0, expected: expected_count }, missing_details()),
        };

        let zip_file_crcs = read_zip_crc_by_filename(path);
        let non_merge_owned: Vec<RomFile> = non_merge.into_iter().cloned().collect();
        let (matched, details) = build_rom_details(&non_merge_owned, zip_crc_set, &zip_file_crcs);
        (MissingReason::CrcMismatch { matched, expected: expected_count }, details)
    }

    /// Try to find a matching import zip by content (CRC32 hashes).
    /// Falls back when name-based match fails — looks up expected CRCs in the
    /// reverse CRC index, finds the zip stem that contains all expected CRCs,
    /// then renames the import zip to `<game_name>.zip` so future runs find it.
    fn find_by_content(&self, game_name: &str, platform: Option<&str>, expected_roms: &[RomFile]) -> Option<PathBuf> {
        let expected_crcs: Vec<&str> = expected_roms.iter()
            .filter(|r| r.merge_target.is_none())
            .filter_map(|r| r.crc32.as_deref())
            .filter(|c| !c.is_empty())
            .collect();
        if expected_crcs.is_empty() {
            return None;
        }

        // Start with candidates that contain the first expected CRC
        let first_crc = expected_crcs[0];
        let candidates = self.crc_to_zips.get(first_crc)?;

        // Filter: find a zip stem that contains ALL expected CRCs
        let matched_stem = candidates.iter().find(|stem| {
            self.zip_crcs.get(*stem).map_or(false, |zip_set| {
                expected_crcs.iter().all(|c| zip_set.contains(*c))
            })
        })?;

        let src_path = self.name_to_path.get(matched_stem)?;

        // Rename the import zip to the expected game name so future runs
        // find it by name. If rename fails (e.g. cross-device), fall through
        // with the original path — the build still succeeds.
        let new_path = src_path.with_file_name(format!("{game_name}.zip"));
        if new_path != *src_path {
            let _ = std::fs::rename(src_path, &new_path);
            Some(new_path)
        } else {
            Some(src_path.clone())
        }
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

/// Compute filename→CRC32 mapping for all files inside a zip (no extraction).
pub fn read_zip_crc_by_filename(zip_path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let data = match std::fs::read(zip_path) {
        Ok(d) => d,
        Err(_) => return map,
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
                let name = String::from_utf8_lossy(name_bytes).to_string();
                if !name.ends_with('/') {
                    map.insert(name, format!("{:08X}", crc));
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
    map
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
    game_id: i64,
    game_map: &HashMap<i64, &Game>,
    collection_dir: Option<&Path>,
    prior_versions: &[String],
    db: &Database,
    version_id: i64,
) -> Result<bool> {
    let cd = match collection_dir { Some(d) => d, None => return Ok(false) };
    if prior_versions.is_empty() { return Ok(false); }
    let game = match game_map.get(&game_id) {
        Some(g) => g,
        None => return Ok(false),
    };
    let platform = if game.platform.is_empty() { None } else { Some(game.platform.as_str()) };
    let game_name = game.name.as_str();
    for pv in prior_versions {
        let pv_roms = cd.join(pv).join(ROMS_DIR_NAME);
        let pv_zip = if let Some(p) = platform {
            pv_roms.join(p).join(format!("{}.zip", game_name))
        } else {
            pv_roms.join(format!("{}.zip", game_name))
        };
        if pv_zip.exists() && verify_game_zip(db, version_id, game_id, &pv_zip)? {
            info!("  {game_name}: reused from prior version {pv}");
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn build_version(
    db: &Database,
    collection_id: i64,
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

    let source_dir = format!("collection_{}", collection_id);
    let progress_path = base_dir.join(&source_dir).join(PROGRESS_FILENAME);

    // ── Phase 0: Load versions ──
    progress(on_progress, "loading", 0, "Loading versions...", 0, 0, 0, &progress_path);
    let latest = if let Some(vid) = version_id {
        db.get_version(vid)?.ok_or_else(|| {
            Error::Source(format!("Version id {} not found", vid))
        })?
    } else {
        db.latest_version(collection_id)?.ok_or_else(|| {
            Error::Source(format!("No version found for collection_id '{}'", collection_id))
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
                db.get_version_by_collection_and_version(collection_id, versions[pos - 1]).ok().flatten()
            } else {
                None // first version in .version file — no prior
            }
        });

    check_cancelled(cancelled)?;
    progress(on_progress, "loading", 5, &format!("Version {} loaded", latest.version), 0, 0, latest.total_games as usize, &progress_path);

    // Load all games for this version (used by diff, cleanup, and main loop)
    let all_games = db.list_games(latest.id)?;
    let game_map: HashMap<i64, &Game> = all_games.iter().map(|g| (g.id, g)).collect();

    // Determine output directory:
    //   collection mode: {version_dir}/{version}
    //   standard mode:   {base_dir}/{source}/{version}
    let version_dir = if let Some(cd) = collection_dir {
        cd.join(&latest.version)
    } else {
        base_dir.join(&source_dir).join(&latest.version)
    };
    let deleted_dir = base_dir.join(DELETED_DIR_NAME);
    let status_path = version_dir.join(STATUS_FILENAME);
    let mode_path = base_dir.join(&source_dir).join(MODE_FILENAME);

    // Check mode consistency at source level
    let requested_mode = if force_update { "update" } else { "collect" };
    if let Some(existing) = read_mode(&mode_path) {
        if existing != requested_mode {
            return Err(Error::Source(format!(
                "Mode mismatch: previous build used '{}' mode, but '{}' was requested.\n\
                 All builds for collection '{}' must use the same mode.",
                existing, requested_mode, collection_id
            )));
        }
    } else {
        write_mode(&mode_path, requested_mode)?;
    }

    let mut status = BuildStatus {
        source: source_dir.clone(),
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
        samples_added: 0,
        samples_existed: 0,
        samples_reused: 0,
        samples_missing: 0,
        missing_samples: Vec::new(),
    };

    // ── Phase 1: Compute diff ──
    // need_copy uses game_ids, not names — names are not unique across platforms
    let (need_copy, unchanged, _removed) = if let Some(ref p) = prev {
        let diff = db.diff_versions(p.id, latest.id)?;
        let unchanged = diff.unchanged as usize;
        let diff_set: std::collections::HashSet<&str> =
            diff.added.iter().chain(diff.changed.iter()).map(|s| s.as_str()).collect();
        let need_copy: Vec<i64> = all_games.iter()
            .filter(|g| diff_set.contains(g.name.as_str()))
            .map(|g| g.id)
            .collect();
        let removed = diff.removed;
        info!("Diff collection {}/{} → collection {}/{}: +{} ~{} -{} ({}u)",
            collection_id, p.version, collection_id, latest.version,
            diff.added.len(), diff.changed.len(), removed.len(), unchanged);
        (need_copy, unchanged, removed)
    } else {
        info!("First build for collection {} — all {} games need copying", collection_id, latest.total_games);
        let need_copy: Vec<i64> = all_games.iter().map(|g| g.id).collect();
        (need_copy, 0, Vec::new())
    };

    check_cancelled(cancelled)?;
    progress(on_progress, "diff", 10, "Diff computed", 0, 0, need_copy.len() + unchanged, &progress_path);

    // ── Phase 2: Folder setup ──
    let roms_dir = version_dir.join(ROMS_DIR_NAME);
    if !dry_run {
        if force_update {
            if let Some(ref p) = prev {
                let old_dir = base_dir.join(&source_dir).join(&p.version);
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
    if !dry_run {
        if roms_dir.exists() {
            // In collect mode, keep ALL games' zips — don't delete existing correct files.
            // In update mode, keep all current games to clean stale zips.
            let keep: HashSet<i64> = all_games.iter().map(|g| g.id).collect();
            for entry in walk_files(&roms_dir)? {
                if entry.extension().and_then(|e| e.to_str()) != Some("zip") {
                    continue;
                }
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                if stem == "_build_status" {
                    continue;
                }
                let stem_id = all_games.iter().find(|g| g.name == stem).map(|g| g.id);
                if stem_id.map_or(true, |id| !keep.contains(&id)) {
                    move_to_deleted(&entry, &deleted_dir, &latest, prev.as_ref())?;
                    status.cleaned += 1;
                }
            }
        }

        // Clean up stale CHD directories (update mode)
        if force_update {
            let chd_dir = version_dir.join(CHD_DIR_NAME);
            if chd_dir.exists() {
                let game_ids: HashSet<i64> =
                    all_games.iter().map(|g| g.id).collect();
                for entry in std::fs::read_dir(&chd_dir)? {
                    let entry = entry?;
                    if entry.path().is_dir() {
                        let dir_name = entry.file_name().to_string_lossy().to_string();
                        let dir_game_id = all_games.iter().find(|g| g.name == dir_name).map(|g| g.id);
                        if dir_game_id.map_or(true, |id| !game_ids.contains(&id)) {
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
            let changed_names: std::collections::HashSet<String> = db.diff_versions(prev_version.id, latest.id)?
                .changed.into_iter().collect();
            let changed_ids: Vec<i64> = all_games.iter()
                .filter(|g| changed_names.contains(g.name.as_str()))
                .map(|g| g.id)
                .collect();
            for &gid in &changed_ids {
                let ge = game_map.get(&gid);
                let game_name = ge.map(|g| g.name.as_str()).unwrap_or("?");
                let pf = ge.map(|g| g.platform.as_str()).unwrap_or("");
                let zip_path = if pf.is_empty() {
                    roms_dir.join(format!("{}.zip", game_name))
                } else {
                    roms_dir.join(pf).join(format!("{}.zip", game_name))
                };
                if zip_path.exists() && !verify_game_zip(db, latest.id, gid, &zip_path)? {
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
    let mut matched_by_hash = 0usize;
    let mut processed_count = 0usize;
    let mut missing: Vec<MissingGame> = Vec::new();

    for &gid in &need_copy {
        processed_count += 1;

        let ge = game_map.get(&gid).copied();
        let game_name = ge.map(|g| g.name.as_str()).unwrap_or("?");
        let game_id = Some(gid);

        // Determine platform subdirectory
        let platform = ge.map(|g| &g.platform).filter(|p| !p.is_empty());

        // If this game links to a source game (rom_source_id), skip building
        // — the source game's ROM handles both. Count as existed if source exists.
        if let Some(src_id) = ge.and_then(|g| g.rom_source_id) {
            if let Some(src_game) = game_map.get(&src_id) {
                let src_plat = if src_game.platform.is_empty() { None } else { Some(src_game.platform.as_str()) };
                let src_dest = if let Some(p) = src_plat {
                    roms_dir.join(p).join(format!("{}.zip", game_name))
                } else {
                    roms_dir.join(format!("{}.zip", game_name))
                };
                if src_dest.exists() {
                    if verbose { eprintln!("  {game_name}: existed (via rom_source_id)"); }
                    exists += 1;
                } else {
                    missing.push(MissingGame {
                        name: game_name.to_string(), game_id: gid,
                        platform: platform.map(|s| s.to_string()).unwrap_or_default(),
                        reason: MissingReason::FileNotFound, rom_details: vec![],
                        sampleof: None, sample_details: vec![],
                    });
                }
            }
            continue;
        }

        let dest = if let Some(p) = platform {
            roms_dir.join(p).join(format!("{}.zip", game_name))
        } else {
            roms_dir.join(format!("{}.zip", game_name))
        };
        if let Some(parent) = dest.parent() {
            if !dry_run { std::fs::create_dir_all(parent)?; }
        }

        // Periodic progress + cancellation check
        let progress_interval = (need_copy.len() / 100).max(1);
        if processed_count % progress_interval == 0 {
            check_cancelled(cancelled)?;
            let pct = 30 + ((processed_count as u64 * 60) / need_copy.len().max(1) as u64) as u32;
            progress(on_progress, "copying", pct, &format!("Scanning ROMs ({}/{})", processed_count, need_copy.len()), processed_count, missing.len(), need_copy.len() + unchanged, &progress_path);
        }

        // Skip if already correctly in place
        if dest.exists() && game_id.map_or(Ok(false), |id| verify_game_zip(db, latest.id, id, &dest))? {
            if verbose { eprintln!("  {game_name}: existed (already correct in {})", dest.display()); }
            exists += 1;
            continue;
        }

        // Check fallback chain
        if game_id.map_or(Ok(false), |id| find_in_fallback(id, &game_map, collection_dir, prior_versions.as_ref(), db, latest.id))? {
            if verbose { eprintln!("  {game_name}: reused (from prior version)"); }
            reused += 1;
            continue;
        }

        // Get expected ROMs for this game
        let expected_roms: Vec<RomFile> = if let Some(g) = ge {
            db.list_roms_for_game(g.id, latest.id)?
        } else {
            Vec::new()
        };

        // Split-format support: compute game's own ROMs (merge_target & parent-inherited excluded)
        // mirrors verify_game_zip's logic to avoid flagging inherited parent ROMs as errors
        let check_roms = compute_game_roms(&expected_roms, ge, &all_games, db, latest.id)?;

        // Try to find matching ROM in import folder
        let plat_str = platform.map(|s| s.as_str());
        if let Some(src_path) = index.find_match(game_name, plat_str, &check_roms) {
            if verbose { eprintln!("  {game_name}: added (copying from {})", src_path.display()); }
            if !dry_run {
                if !src_path.exists() {
                    info!("  {game_name}: source {} missing, skipping", src_path.display());
                    let (reason, rom_details) = index.explain_missing(game_name, &check_roms);
                    let miss_plat = ge.map(|g| g.platform.clone()).unwrap_or_default();
                    missing.push(MissingGame { name: game_name.to_string(), game_id: game_id.unwrap_or(0), platform: miss_plat, reason, rom_details, sampleof: None, sample_details: vec![] });
                    continue;
                }
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
        } else if let Some(src_path) = index.find_by_content(game_name, plat_str, &check_roms) {
            // Found by content hash (not by name) — rename already done by find_by_content
            if verbose { eprintln!("  {game_name}: matched by content hash (renamed from {})", src_path.display()); }
            if !dry_run {
                std::fs::copy(&src_path, &dest)?;
                let chds = find_chd_files(&src_path);
                if !chds.is_empty() {
                    let chd_dest_base = version_dir.join(CHD_DIR_NAME).join(game_name);
                    for chd_src in &chds {
                        let chd_dest = chd_dest_base.join(chd_src.file_name().unwrap_or_default());
                        std::fs::create_dir_all(chd_dest.parent().unwrap())?;
                        std::fs::copy(chd_src, &chd_dest)?;
                    }
                }
            }
            matched_by_hash += 1;
        } else {
            let (reason, rom_details) = index.explain_missing(game_name, &check_roms);
            if verbose {
                match &reason {
                    MissingReason::FileNotFound => eprintln!("  {game_name}: file not found in import"),
                    MissingReason::CrcMismatch { matched, expected } =>
                        eprintln!("  {game_name}: CRC mismatch ({matched}/{expected} ROMs verified)"),
                }
            }
            let sampleof = ge.and_then(|g| g.sampleof.as_deref());
            let sample_set_id = sampleof.and_then(|name| all_games.iter().find(|g| g.name == name)).map(|g| g.id);
            let sample_details = compute_sample_details(sampleof, sample_set_id, &all_games, db, latest.id, &import_dir.join(SAMPLES_DIR_NAME)).unwrap_or_default();
            let miss_plat = ge.map(|g| g.platform.clone()).unwrap_or_default();
            missing.push(MissingGame { name: game_name.to_string(), game_id: game_id.unwrap_or(0), platform: miss_plat, reason, rom_details, sampleof: sampleof.map(|s| s.to_string()), sample_details });
        }
    }

    // ── Phase 5b: Loose-only builds ──
    if !dry_run {
        for &gid in &need_copy {
            let ge = game_map.get(&gid).copied();
            let game_name = ge.map(|g| g.name.as_str()).unwrap_or("?");
            let platform = ge.map(|g| &g.platform).filter(|p| !p.is_empty());
            let dest = if let Some(p) = platform { roms_dir.join(p).join(format!("{}.zip", game_name)) }
                else { roms_dir.join(format!("{}.zip", game_name)) };
            if dest.exists() { continue; }
            let expected_roms = if let Some(g) = ge { db.list_roms_for_game(g.id, latest.id)? } else { Vec::new() };
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

    // ── Phase 5c: Copy samples with verification (same pipeline as ROMs) ──
    let sample_names: std::collections::BTreeSet<String> = all_games.iter()
        .filter_map(|g| g.sampleof.as_ref().filter(|s| !s.is_empty()))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .chain(
            all_games.iter().filter_map(|g| {
                db.list_roms_for_game(g.id, latest.id).ok().and_then(|roms| {
                    if roms.iter().any(|r| r.subtype == "sample") { Some(g.name.clone()) } else { None }
                })
            })
        )
        .collect::<std::collections::BTreeSet<_>>();

    let mut samples_added = 0usize;
    let mut samples_existed = 0usize;
    let mut samples_reused = 0usize;
    let mut samples_missing = 0usize;
    let mut missing_samples: Vec<String> = Vec::new();

    if !dry_run && !sample_names.is_empty() {
        let dest_samples = version_dir.join(SAMPLES_DIR_NAME);
        let dest_existed: std::collections::HashSet<String> = if dest_samples.is_dir() {
            walk_files(&dest_samples)?.iter()
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("zip"))
                .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
                .collect()
        } else {
            std::collections::HashSet::new()
        };
        let mut prior_samples: std::collections::HashMap<String, std::path::PathBuf> = std::collections::HashMap::new();
        if let Some(cd) = collection_dir {
            for pv in &prior_versions {
                let pv_samples = cd.join(pv).join(SAMPLES_DIR_NAME);
                if pv_samples.is_dir() {
                    for entry in walk_files(&pv_samples)? {
                        if entry.extension().and_then(|e| e.to_str()) != Some("zip") { continue; }
                        let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                        prior_samples.entry(stem).or_insert_with(|| entry.clone());
                    }
                }
            }
        }

        for sample_name in &sample_names {
            let dst = dest_samples.join(format!("{}.zip", sample_name));
            if dest_existed.contains(sample_name.as_str()) {
                samples_existed += 1;
            } else if let Some(src) = prior_samples.get(sample_name.as_str()) {
                if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
                std::fs::copy(src, &dst)?;
                samples_reused += 1;
            } else if let Some(import_path) = index.name_to_path.get(sample_name.as_str()) {
                let expected_roms = match all_games.iter().find(|g| g.name == *sample_name) {
                    Some(g) => db.list_roms_for_game(g.id, latest.id).unwrap_or_default(),
                    None => Vec::new(),
                };
                let sample_roms: Vec<&RomFile> = expected_roms.iter()
                    .filter(|r| r.subtype == "sample" && r.merge_target.is_none())
                    .collect();
                if !sample_roms.is_empty() {
                    let zip_crcs = read_zip_crc_by_filename(import_path);
                    let zip_crc_set: std::collections::HashSet<String> = zip_crcs.values().cloned().collect();
                    let all_ok = sample_roms.iter().all(|r| {
                        r.crc32.as_ref().map_or(true, |c| c.is_empty() || zip_crc_set.contains(c))
                    });
                    if !all_ok {
                        missing_samples.push(sample_name.clone());
                        samples_missing += 1;
                        continue;
                    }
                }
                if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
                std::fs::copy(import_path, &dst)?;
                samples_added += 1;
            } else {
                missing_samples.push(sample_name.clone());
                samples_missing += 1;
            }
        }
    }

    check_cancelled(cancelled)?;
    progress(on_progress, "copying", 95, &format!("Copy complete ({}/{} added)", added, need_copy.len()), added, missing.len(), need_copy.len() + unchanged, &progress_path);

    // Count unchanged games from any prior version's output
    if unchanged > 0 && !prior_versions.is_empty() {
        if let Some(cd) = collection_dir {
            let mut prior_zips: std::collections::HashSet<String> = std::collections::HashSet::new();
            for pv in &prior_versions {
                let pv_roms = cd.join(pv).join(ROMS_DIR_NAME);
                if !pv_roms.exists() { continue; }
                for entry in walk_files(&pv_roms)? {
                    if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
                        prior_zips.insert(
                            entry.file_stem().unwrap_or_default().to_string_lossy().to_string()
                        );
                    }
                }
            }
            let current_ids: HashSet<i64> =
                all_games.iter().map(|g| g.id).collect();
            reused += prior_zips.iter()
                .filter_map(|z| all_games.iter().find(|g| g.name == *z))
                .filter(|g| current_ids.contains(&g.id))
                .count();
        }
    }

    // ── Phase 6: Version dedup (collection mode only) ──
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
                info!("Removing old version: {} {}", source_dir, p.version);
                db.delete_version(p.id)?;
            }
        }
    }

    // ── Phase 7b: Re-evaluate previously-missing games not in current diff ──
    {
        let processed_ids: std::collections::HashSet<i64> = need_copy.iter().copied().collect();
        let missing_ids: std::collections::HashSet<i64> = missing.iter().map(|m| m.game_id).collect();
        for old_mg in &status.missing_reasons {
            if processed_ids.contains(&old_mg.game_id) || missing_ids.contains(&old_mg.game_id) {
                continue;
            }
            let ge = game_map.get(&old_mg.game_id).copied();
            let expected = ge.map(|g| db.list_roms_for_game(g.id, latest.id)).transpose()?.unwrap_or_default();
            let check = compute_game_roms(&expected, ge, &all_games, db, latest.id)?;
            if check.is_empty() {
                info!("  {}: no own ROMs to check, removing from missing", old_mg.name);
                continue;
            }
            let plat = ge.map(|g| g.platform.as_str()).filter(|p| !p.is_empty());
            if index.find_match(&old_mg.name, plat, &check).is_some() {
                info!("  {}: no longer missing (matched by re-evaluation)", old_mg.name);
                continue;
            }
            let (reason, rom_details) = index.explain_missing(&old_mg.name, &check);
            info!("  {}: still missing ({})", old_mg.name,
                match &reason { MissingReason::FileNotFound => "FileNotFound", _ => "CrcMismatch" });
            let sampleof = ge.and_then(|g| g.sampleof.as_deref());
            let sample_set_id = sampleof.and_then(|name| all_games.iter().find(|g| g.name == name)).map(|g| g.id);
            let sample_details = compute_sample_details(sampleof, sample_set_id, &all_games, db, latest.id, &import_dir.join(SAMPLES_DIR_NAME)).unwrap_or_default();
            let miss_plat = ge.map(|g| g.platform.clone()).unwrap_or_default();
            missing.push(MissingGame { name: old_mg.name.clone(), game_id: old_mg.game_id, platform: miss_plat, reason, rom_details, sampleof: sampleof.map(|s| s.to_string()), sample_details });
        }
    }

    // ── Phase 8: Save status + report ──
    status.matched = added + status.matched;

    missing.sort_by(|a, b| a.name.cmp(&b.name));

    progress(on_progress, "saving", 98, "Saving status...", status.matched, missing.len(), need_copy.len() + unchanged, &progress_path);
    status.missing = missing.len();
    status.missing_games = missing.iter().map(|m| m.name.clone()).collect();
    status.missing_reasons = missing.clone();
    status.samples_added = samples_added;
    status.samples_existed = samples_existed;
    status.samples_reused = samples_reused;
    status.samples_missing = samples_missing;
    status.missing_samples = missing_samples.clone();
    status.last_run = Some(chrono_now());
    if !dry_run {
        write_status(&status_path, &status)?;
    }

    // total_games: count of unique game names (matches scan output)
    let unique_game_count = db.list_games(latest.id)?.iter()
        .map(|g| g.name.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    let result = BuildResult {
        total_games: unique_game_count,
        added,
        exists,
        reused,
        missing: missing.len(),
        cleaned: status.cleaned,
        matched_by_hash,
        missing_games: missing.iter().map(|m| m.name.clone()).collect(),
        missing_reasons: missing,
        mode: status.mode.clone(),
        version: latest.version.clone(),
        prev_version: prev.map(|p| p.version.clone()),
        samples_added,
        samples_existed,
        samples_reused,
        samples_missing,
        missing_samples,
    };

    progress(on_progress, "done", 100, "Build complete", result.added, result.missing, result.total_games, &progress_path);

    Ok(result)
}

// ── Helpers ──

/// Scan a samples directory and verify sample zips against DB entries.
/// Collects sample set names from sampleof references, games with sample-subtype ROMs,
/// and any zips present in the samples directory. Returns found/missing counts.
pub fn scan_samples(
    all_games: &[Game],
    db: &Database,
    version_id: i64,
    samples_dir: &std::path::Path,
) -> Result<SampleResult> {
    let mut sample_set_names: std::collections::BTreeSet<String> = all_games.iter()
        .filter_map(|g| g.sampleof.as_ref().filter(|s| !s.is_empty()))
        .cloned()
        .collect();
    for game in all_games {
        if let Ok(roms) = db.list_roms_for_game(game.id, version_id) {
            if roms.iter().any(|r| r.subtype == "sample") {
                sample_set_names.insert(game.name.clone());
            }
        }
    }

    let mut samples_found = 0usize;
    let mut samples_missing = 0usize;
    let mut missing_samples = Vec::new();

    for sample_name in &sample_set_names {
        let sample_zip_path = samples_dir.join(format!("{}.zip", sample_name));
        if !sample_zip_path.exists() {
            missing_samples.push(sample_name.clone());
            samples_missing += 1;
            continue;
        }
        let sample_game = all_games.iter().find(|g| g.name == *sample_name);
        let expected_sample_roms = match sample_game {
            Some(g) => db.list_roms_for_game(g.id, version_id).unwrap_or_default(),
            None => Vec::new(),
        };
        let sample_roms: Vec<&RomFile> = expected_sample_roms.iter()
            .filter(|r| r.subtype == "sample" && r.merge_target.is_none())
            .collect();
        if !sample_roms.is_empty() {
            let zip_crcs = read_zip_crc_by_filename(&sample_zip_path);
            let zip_crc_set: std::collections::HashSet<String> = zip_crcs.values().cloned().collect();
            let all_ok = sample_roms.iter().all(|r| {
                r.crc32.as_ref().map_or(true, |c| c.is_empty() || zip_crc_set.contains(c))
            });
            if !all_ok {
                missing_samples.push(sample_name.clone());
                samples_missing += 1;
                continue;
            }
        }
        samples_found += 1;
    }

    Ok(SampleResult { samples_found, samples_missing, missing_samples })
}

/// Compute the set of ROMs that belong to a game (excluding merge_target and parent-inherited).
/// Mirrors verify_game_zip logic for split-format support.
pub fn compute_game_roms(
    expected_roms: &[RomFile],
    game: Option<&Game>,
    all_games: &[Game],
    db: &Database,
    version_id: i64,
) -> Result<Vec<RomFile>> {
    let mut roms: Vec<&RomFile> = expected_roms.iter()
        .filter(|r| r.merge_target.is_none() && r.subtype != "sample").collect();
    if let Some(g) = game {
        let mut parent_ids: Vec<i64> = Vec::new();
        if let Some(pid) = g.parent_game_id {
            parent_ids.push(pid);
        }
        if let Ok(Some(romof_name)) = db.get_romof(g.id, version_id) {
            if !romof_name.is_empty() {
                if let Some(romof_game) = all_games.iter().find(|pg| pg.name == romof_name) {
                    if !parent_ids.contains(&romof_game.id) {
                        parent_ids.push(romof_game.id);
                    }
                }
            }
        }
        let mut parent_crcs: std::collections::HashSet<String> = std::collections::HashSet::new();
        for &pid in &parent_ids {
            if let Some(parent) = all_games.iter().find(|pg| pg.id == pid) {
                if let Ok(parent_roms) = db.list_roms_for_game(parent.id, version_id) {
                    for r in &parent_roms {
                        if let Some(crc) = &r.crc32 {
                            if !crc.is_empty() {
                                parent_crcs.insert(crc.to_uppercase());
                            }
                        }
                    }
                }
            }
        }
        if !parent_crcs.is_empty() {
            roms.retain(|r| !r.crc32.as_deref().map_or(false, |c| parent_crcs.contains(c)));
        }
    }
    if roms.is_empty() {
        Ok(expected_roms.iter().filter(|r| r.merge_target.is_none() && r.subtype != "sample").cloned().collect())
    } else {
        Ok(roms.into_iter().cloned().collect())
    }
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(status)
        .map_err(|e| Error::Parse(format!("Failed to serialize status: {}", e)))?;
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
        dest = deleted_dir.join(format!("{}_{}_v{}.{}", stem, version.collection_id, v, ext));
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

fn verify_zip_contains(zip_path: &Path, expected_roms: &[RomFile]) -> bool {
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

fn verify_game_zip(db: &Database, version_id: i64, game_id: i64, zip_path: &Path) -> Result<bool> {
    let games = db.list_games(version_id)?;
    let game = games.iter().find(|g| g.id == game_id);
    let expected = match game {
        Some(g) => db.list_roms_for_game(g.id, version_id)?,
        None => return Ok(false),
    };
    if expected.is_empty() {
        return Ok(false);
    }
    let check = compute_game_roms(&expected, game, &games, db, version_id)?;
    if check.is_empty() {
        return Ok(true);
    }
    Ok(verify_zip_contains(zip_path, &check))
}

/// Shared per-ROM comparison: given expected ROMs and actual zip CRCs,
/// build per-ROM details and count matches.
fn build_rom_details(roms: &[RomFile], zip_crc_set: &std::collections::HashSet<String>, zip_file_crcs: &std::collections::HashMap<String, String>) -> (usize, Vec<RomDetail>) {
    let mut matched = 0usize;
    let mut details = Vec::with_capacity(roms.len());
    for r in roms {
        let exp = r.crc32.clone().unwrap_or_default();
        let found = !exp.is_empty() && zip_crc_set.contains(&exp);
        if found { matched += 1; }
        let actual = if found { Some(exp.clone()) } else { zip_file_crcs.get(&r.filename).cloned() };
        let status = if found { "match" } else { "mismatch" };
        details.push(RomDetail { filename: r.filename.clone(), expected_crc: exp, actual_crc: actual, status: status.to_string() });
    }
    (matched, details)
}

fn compute_sample_details(
    sampleof: Option<&str>,
    _sample_set_id: Option<i64>,
    all_games: &[Game],
    db: &Database,
    version_id: i64,
    samples_dir: &std::path::Path,
) -> Result<Vec<RomDetail>> {
    let sample_set_name = match sampleof {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(Vec::new()),
    };
    let sample_game = match all_games.iter().find(|g| g.name == sample_set_name) {
        Some(g) => g,
        None => return Ok(Vec::new()),
    };
    let roms = db.list_roms_for_game(sample_game.id, version_id)?;
    let sample_roms: Vec<&RomFile> = roms.iter()
        .filter(|r| r.subtype == "sample" && r.merge_target.is_none())
        .collect();
    if sample_roms.is_empty() {
        return Ok(Vec::new());
    }

    let zip_path = samples_dir.join(format!("{}.zip", sample_set_name));
    if !zip_path.exists() {
        return Ok(sample_roms.iter().map(|r| RomDetail {
            filename: r.filename.clone(),
            expected_crc: r.crc32.clone().unwrap_or_default(),
            actual_crc: None,
            status: "missing".to_string(),
        }).collect());
    }

    let zip_file_crcs = read_zip_crc_by_filename(&zip_path);
    let zip_crc_set: std::collections::HashSet<String> = zip_file_crcs.values().cloned().collect();

    let mut details = Vec::with_capacity(sample_roms.len());
    for r in &sample_roms {
        let exp = r.crc32.clone().unwrap_or_default();
        let found = !exp.is_empty() && zip_crc_set.contains(&exp);
        let actual = if found { Some(exp.clone()) } else { zip_file_crcs.get(&r.filename).cloned() };
        let status = if found { "match" } else { "mismatch" };
        details.push(RomDetail {
            filename: r.filename.clone(),
            expected_crc: exp,
            actual_crc: actual,
            status: status.to_string(),
        });
    }
    Ok(details)
}

/// Determine missing reason and per-ROM + per-sample details for a game by checking a directory.
/// Searches recursively for `<game_name>.zip` in the given directory.
/// The game's sample files are checked in `dir/samples/<sampleof>.zip` when applicable.
pub fn explain_missing_from_dir(
    game_name: &str,
    expected_roms: &[RomFile],
    game: Option<&Game>,
    all_games: &[Game],
    db: &Database,
    version_id: i64,
    dir: &Path,
) -> Result<(MissingReason, Vec<RomDetail>, Vec<RomDetail>)> {
    let non_merge: Vec<&RomFile> = expected_roms.iter().filter(|r| r.merge_target.is_none()).collect();
    let check = compute_game_roms(expected_roms, game, all_games, db, version_id)?;
    let check_refs: Vec<&RomFile> = check.iter().collect();
    let use_roms = if check_refs.is_empty() { non_merge } else { check_refs };

    let zip_path = walk_files(dir)?.iter()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("zip") &&
              p.file_stem().and_then(|s| s.to_str()) == Some(game_name))
        .cloned();

    let sample_details = compute_sample_details(
        game.and_then(|g| g.sampleof.as_deref()),
        None, all_games, db, version_id, &dir.join(SAMPLES_DIR_NAME),
    ).unwrap_or_default();

    let path = match zip_path {
        Some(p) => p,
        None => {
            let details = use_roms.iter().map(|r| RomDetail {
                filename: r.filename.clone(),
                expected_crc: r.crc32.clone().unwrap_or_default(),
                actual_crc: None,
                status: "missing".to_string(),
            }).collect();
            return Ok((MissingReason::FileNotFound, details, sample_details));
        }
    };

    let zip_file_crcs = read_zip_crc_by_filename(&path);
    let zip_crc_set: std::collections::HashSet<String> = zip_file_crcs.values().cloned().collect();

    if zip_crc_set.is_empty() {
        let details = use_roms.iter().map(|r| RomDetail {
            filename: r.filename.clone(),
            expected_crc: r.crc32.clone().unwrap_or_default(),
            actual_crc: None,
            status: "missing".to_string(),
        }).collect();
        return Ok((MissingReason::CrcMismatch { matched: 0, expected: use_roms.len() }, details, sample_details));
    }

    let (matched, details) = build_rom_details(&check, &zip_crc_set, &zip_file_crcs);
    Ok((MissingReason::CrcMismatch { matched, expected: check.len() }, details, sample_details))
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub version: String,
    pub format: String,
    pub total_games: usize,
    pub exported: usize,
    pub skipped: usize,
    pub merged: usize,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(Error::Source("Build cancelled".into()))
    } else {
        Ok(())
    }
}

/// Export a built version (split format) to the requested format.
///
/// `input_dir` is the split build output (e.g. `<collection>/<version>/roms/`).
/// `output_dir` receives the exported zips in the requested layout.
pub fn export_version(
    db: &Database,
    version_id: i64,
    input_dir: &Path,
    output_dir: &Path,
    format: MergeMode,
    on_progress: &dyn Fn(&BuildProgress),
    cancelled: &AtomicBool,
) -> Result<ExportResult> {
    let version = db.get_version(version_id)?
        .ok_or_else(|| Error::Source(format!("Version {version_id} not found")))?;

    let games = db.list_games(version_id)?;
    // Index available zips in the input directory
    let mut input_zips: HashMap<String, PathBuf> = HashMap::new();
    if input_dir.is_dir() {
        for entry in walk_files(input_dir)? {
            if entry.extension().and_then(|e| e.to_str()) == Some("zip") {
                let stem = entry.file_stem().unwrap_or_default().to_string_lossy().to_string();
                input_zips.entry(stem).or_insert(entry);
            }
        }
    }

    let total = games.len();
    let mut exported = 0usize;
    let mut skipped = 0usize;
    let mut merged = 0usize;

    match format {
        MergeMode::Split => {
            // Passthrough: copy all zips preserving directory structure
            if input_dir.is_dir() {
                for entry in walk_files(input_dir)? {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(Error::Source("Export cancelled".into()));
                    }
                    let rel = entry.strip_prefix(input_dir).unwrap_or(&entry);
                    let dest = output_dir.join(rel);
                    std::fs::create_dir_all(dest.parent().unwrap())?;
                    std::fs::copy(&entry, &dest)?;
                    exported += 1;
                }
            }
        }

        MergeMode::NonMerged => {
            for game in &games {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(Error::Source("Export cancelled".into()));
                }
                // Walk parent chain: game → parent → grandparent → ... → root
                let mut ancestors = Vec::new();
                let mut current = Some(game);
                while let Some(g) = current {
                    ancestors.push(g);
                    current = g.parent_game_id
                        .and_then(|pid| games.iter().find(|c| c.id == pid));
                }

                let zips: Vec<PathBuf> = ancestors.iter()
                    .filter_map(|g| input_zips.get(&g.name))
                    .cloned()
                    .collect();

                if zips.is_empty() {
                    skipped += 1;
                    continue;
                }

                let platform = if game.platform.is_empty() { None } else { Some(game.platform.as_str()) };
                let dest_dir = platform.map_or_else(|| output_dir.to_path_buf(), |p| output_dir.join(p));
                let dest = dest_dir.join(format!("{}.zip", game.name));
                std::fs::create_dir_all(&dest_dir)?;

                if zips.len() == 1 {
                    std::fs::copy(&zips[0], &dest)?;
                } else {
                    merge_zips(&zips, &dest)?;
                    merged += 1;
                }
                exported += 1;

                let pct = (exported * 100 / total.max(1)) as u32;
                on_progress(&BuildProgress {
                    phase: "exporting".into(),
                    pct,
                    msg: format!("Exporting {exported}/{total}"),
                    matched: exported,
                    missing: skipped,
                    total,
                });
            }
        }

        MergeMode::Merged => {
            // Build children map
            let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
            for game in &games {
                if let Some(pid) = game.parent_game_id {
                    if games.iter().any(|g| g.id == pid) {
                        children.entry(pid).or_default().push(game.id);
                    }
                }
            }

            // Root parents: games whose parent is None or not in this version
            let roots: Vec<&Game> = games.iter()
                .filter(|g| g.parent_game_id.map_or(true, |pid| !games.iter().any(|c| c.id == pid)))
                .collect();

            let mut processed: HashSet<i64> = HashSet::new();
            for root in &roots {
                check_cancelled(cancelled)?;

                // DFS to collect all family members
                let mut family = Vec::new();
                let mut stack = vec![root.id];
                while let Some(gid) = stack.pop() {
                    if !processed.insert(gid) { continue; }
                    family.push(gid);
                    if let Some(kids) = children.get(&gid) {
                        stack.extend(kids);
                    }
                }

                let zips: Vec<PathBuf> = family.iter()
                    .filter_map(|&gid| {
                        let name = games.iter().find(|g| g.id == gid)?.name.as_str();
                        input_zips.get(name)
                    })
                    .cloned()
                    .collect();

                if zips.is_empty() {
                    skipped += family.len();
                    continue;
                }

                let platform = if root.platform.is_empty() { None } else { Some(root.platform.as_str()) };
                let dest_dir = platform.map_or_else(|| output_dir.to_path_buf(), |p| output_dir.join(p));
                let dest = dest_dir.join(format!("{}.zip", root.name));
                std::fs::create_dir_all(&dest_dir)?;

                merge_zips(&zips, &dest)?;
                merged += 1;
                exported += family.len();

                let pct = (exported * 100 / total.max(1)) as u32;
                on_progress(&BuildProgress {
                    phase: "exporting".into(),
                    pct,
                    msg: format!("Exporting {exported}/{total}"),
                    matched: exported,
                    missing: skipped,
                    total,
                });
            }

            // Handle orphans not reached by DFS (no parent, no children)
            for game in &games {
                if processed.contains(&game.id) { continue; }
                processed.insert(game.id);

                let zip = match input_zips.get(&game.name) {
                    Some(z) => z,
                    None => { skipped += 1; continue; }
                };

                let platform = if game.platform.is_empty() { None } else { Some(game.platform.as_str()) };
                let dest_dir = platform.map_or_else(|| output_dir.to_path_buf(), |p| output_dir.join(p));
                let dest = dest_dir.join(format!("{}.zip", game.name));
                std::fs::create_dir_all(&dest_dir)?;
                std::fs::copy(zip, &dest)?;
                exported += 1;
            }
        }
    }

    Ok(ExportResult {
        version: version.version,
        format: format.to_string(),
        total_games: total,
        exported,
        skipped,
        merged,
    })
}

/// Merge multiple zip files into one destination zip.
/// Entries from later sources override earlier ones when filenames collide.
fn merge_zips(sources: &[PathBuf], dest: &Path) -> Result<()> {
    let mut all_entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for src in sources {
        let file = std::fs::File::open(src)
            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, format!("{src:?}: {e}"))))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)
                .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
            let name = entry.name().to_string();
            if name.ends_with('/') || seen.contains(&name) { continue; }
            seen.insert(name.clone());
            let mut data = Vec::new();
            entry.read_to_end(&mut data)
                .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
            all_entries.push((name, data));
        }
    }

    let out_file = std::fs::File::create(dest)?;
    let mut zipw = zip::ZipWriter::new(out_file);
    let opts = zip::write::FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (name, data) in &all_entries {
        zipw.start_file(name, opts.clone())
            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
        zipw.write_all(data)?;
    }

    zipw.finish()
        .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;
    use crate::models::{ParsedGame, ParsedRom};

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

    fn add_rom(db: &Database, gid: i64, vid: i64, name: &str, sha1: &str) {
        let rsid = db.insert_rom_set(gid, vid, None).unwrap();
        let parsed = ParsedRom {
            filename: name.to_string(),
            size: Some(4),
            crc32: None,
            md5: None,
            sha1: Some(sha1.to_string()),
            status: "good".to_string(),
            merge_target: None,
        };
        db.insert_rom_files_batch(rsid, &[parsed]).unwrap();
    }

    fn add_rom_with_crc(db: &Database, gid: i64, vid: i64, name: &str, sha1: &str, crc32: &str) {
        let rsid = db.insert_rom_set(gid, vid, None).unwrap();
        let parsed = ParsedRom {
            filename: name.to_string(),
            size: Some(4),
            crc32: Some(crc32.to_string()),
            md5: None,
            sha1: Some(sha1.to_string()),
            status: "good".to_string(),
            merge_target: None,
        };
        db.insert_rom_files_batch(rsid, &[parsed]).unwrap();
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
        let vid = db.import_version(Some(0), "v1.0", None).unwrap();
        let gid = add_game(&db, vid, "game1");
        add_rom(&db, gid, vid, "rom.bin", &sha1);

        let cancelled = AtomicBool::new(false);
        let progress = |_: &BuildProgress| {};

        let result = build_version(
            &db, 0, &import_dir, &root, Some(root),
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
        let vid1 = db.import_version(Some(0), "0.1", None).unwrap();

        for (_i, name) in game_names.iter().enumerate() {
            let gid = add_game(&db, vid1, name);
            let crcs = &crc_map[name];
            let sha1 = &sha1_map[name];
            for (rom_name, crc_hex) in crcs {
                add_rom_with_crc(&db, gid, vid1, rom_name, sha1, crc_hex);
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
            &db, 0, &import_dir, root, Some(root),
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
            &db, 0, &import_dir, root, Some(root),
            false, false, Some(vid1), &progress, &cancelled, false,
        ).expect("build_version v0.1 second run should succeed");

        assert_eq!(result2.exists, 100, "v0.1 second run: all 100 should exist");
        assert_eq!(result2.added, 0, "v0.1 second run: nothing new copied");
        assert_eq!(result2.missing, 0);

        // ── Prepare v0.2: modify 30 games, add 10 new ones ──
        let vid2 = db.import_version(Some(0), "0.2", None).unwrap();
        let mut v2_sha1_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut v2_crc_map: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();

        // 70 unchanged games: re-import their entries (same as v0.1)
        for i in 0..70 {
            let name = &game_names[i];
            let gid = add_game(&db, vid2, name);
            let crcs = &crc_map[name];
            let sha1 = &sha1_map[name];
            for (rom_name, crc_hex) in crcs {
                add_rom_with_crc(&db, gid, vid2, rom_name, sha1, crc_hex);
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
                add_rom_with_crc(&db, gid, vid2, rom_name, &sha1, crc_hex);
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
                add_rom_with_crc(&db, gid, vid2, rom_name, &sha1, crc_hex);
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
            &db, 0, &import_dir, root, Some(root),
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
            &db, 0, &import_dir, root, Some(root),
            false, false, Some(vid2), &progress, &cancelled, false,
        ).expect("build_version v0.2 second run should succeed");

        assert_eq!(result4.exists, result3.added, "v0.2 second run: exists = added count from first run");
    }

    #[test]
    fn test_import_index_skips_deleted_roms() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "v1.0", None).unwrap();

        // Create a normal zip in the scan dir
        make_zip_with_content(&tmp.path().join("game1.zip"), b"data1");

        // Create deleted_roms/ with a zip that should be excluded
        let deleted_dir = tmp.path().join("deleted_roms");
        std::fs::create_dir_all(&deleted_dir).unwrap();
        make_zip_with_content(&deleted_dir.join("game2.zip"), b"data2");

        let index = ImportIndex::scan(tmp.path(), &db, vid).unwrap();
        assert_eq!(index.name_to_path.len(), 1,
            "should only index game1.zip, not deleted_roms/game2.zip");
        assert!(index.name_to_path.contains_key("game1"),
            "game1 should be in the index");
        assert!(!index.name_to_path.contains_key("game2"),
            "game2 from deleted_roms should NOT be in the index");
    }

    #[test]
    fn test_verify_game_zip_uses_game_id() {
        // Regression: verify_game_zip should accept game_id, not game name.
        let tmp = tempfile::TempDir::new().unwrap();
        let db = make_db();
        let vid = db.import_version(Some(0), "v1.0", None).unwrap();

        // Create a game with a known ROM CRC
        let content: &[u8] = b"content_a";
        let entries: &[(&str, &[u8])] = &[("rom1.bin", content)];
        let crcs = make_zip_with_entries(&tmp.path().join("game1.zip"), entries);
        let crc_val = &crcs[0].1;

        let parsed = ParsedGame {
            name: "game1".to_string(),
            description: String::new(),
            year: None, manufacturer: None,
            cloneof: None, romof: None, sampleof: None,
            platform: String::new(),
            isbios: false, isdevice: false,
            runnable: Some(true),
            driver_status: None, driver_emulation: None,
            roms: vec![ParsedRom {
                filename: "rom1.bin".to_string(),
                size: Some(9),
                crc32: Some(crc_val.clone()),
                md5: None, sha1: None,
                status: "good".to_string(),
                merge_target: None,
            }],
        };
        let gid = db.insert_game(0, &parsed).unwrap();
        let rsid = db.insert_rom_set(gid, vid, None).unwrap();
        db.insert_rom_files_batch(rsid, &[ParsedRom {
            filename: "rom1.bin".to_string(),
            size: Some(9),
            crc32: Some(crc_val.clone()),
            md5: None, sha1: None,
            status: "good".to_string(),
            merge_target: None,
        }]).unwrap();

        let result = verify_game_zip(&db, vid, gid, &tmp.path().join("game1.zip")).unwrap();
        assert!(result, "verify_game_zip should verify by game_id correctly");
    }
}
