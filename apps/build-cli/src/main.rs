use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};

use rom_manager::builder::{build_version, check_game_availability, export_version, scan_samples, Availability};
use rom_manager::dat::write::{write_logiqx_dat, ExportGame, ExportRom};
use rom_manager::models::{MergeMode, MissingGame, SampleResult};
use rom_manager::scanner::ScanMatch;
use rom_manager::verifier::{verify_version, GameStatus};
use rom_manager::Database;
use serde::Serialize;

static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
unsafe extern "C" fn handle_signal(_sig: libc::c_int) {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

#[cfg(windows)]
fn install_signal_handlers() {}
#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        libc::signal(libc::SIGTERM, handle_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, handle_signal as *const () as libc::sighandler_t);
    }
}

#[derive(Serialize)]
struct VersionEntry {
    id: i64,
    collection_id: i64,
    version: String,
    directory: Option<String>,
    total_games: i64,
    total_roms: i64,
}

#[derive(Serialize)]
struct ScanOutput {
    total: usize,
    matched: usize,
    missing: usize,
    matches: Vec<ScanMatch>,
    missing_names: Vec<String>,
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty", default)]
    missing_by_platform: std::collections::HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    missing_reasons: Vec<MissingGame>,
    #[serde(default)]
    samples_found: usize,
    #[serde(default)]
    samples_missing: usize,
    #[serde(default)]
    missing_samples: Vec<String>,
}

#[derive(Serialize)]
struct VerifyOutput {
    total_games: i64,
    present: i64,
    missing: i64,
    inherited: i64,
    mismatched: i64,
    details: Vec<VerifyDetail>,
}

#[derive(Serialize)]
struct VerifyDetail {
    status: String,
    name: String,
    detail: Option<String>,
}

#[derive(Serialize)]
struct DiffOutput {
    version_a: String,
    version_b: String,
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<String>,
    unchanged: i64,
}

#[derive(Serialize)]
struct BuildOutput {
    source: String,
    version: String,
    mode: String,
    prev_version: Option<String>,
    total_games: usize,
    added: usize,
    exists: usize,
    reused: usize,
    missing: usize,
    #[serde(default)]
    matched_ids: Vec<i64>,
    cleaned: usize,
    matched_by_hash: usize,
    missing_games: Vec<String>,
    missing_reasons: Vec<MissingGame>,
    #[serde(default)]
    samples_added: usize,
    #[serde(default)]
    samples_existed: usize,
    #[serde(default)]
    samples_reused: usize,
    #[serde(default)]
    samples_missing: usize,
    #[serde(default)]
    missing_samples: Vec<String>,
}

fn db_path() -> String {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--db") {
        if let Some(path) = args.get(pos + 1) {
            return path.clone();
        }
    }
    std::env::var("ROM_DB").unwrap_or_else(|_| {
        eprintln!("Error: --db <path> or ROM_DB env required");
        std::process::exit(1);
    })
}

fn has_json() -> bool {
    std::env::args().any(|a| a == "--json")
}

fn strip_global_flags(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args {
        if skip_next { skip_next = false; continue; }
        if a == "--json" { continue; }
        if a == "--db" { skip_next = true; continue; }
        out.push(a.clone());
    }
    out
}

fn print_json<T: Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn print_usage() {
    eprintln!("Usage: build-cli <command> [options] [--json] --db <path>");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  dat list");
    eprintln!("  dat info <version-id>");
    eprintln!("  scan <version-id> <dir>");
    eprintln!("  verify <version-id> <dir> [--fallback <id>]");
    eprintln!("  diff <version-id-a> <version-id-b>");
    eprintln!("  fixdat <version-id-a> <version-id-b> --output <file>");
    eprintln!("  export <version-id> <output-dir> --format split|merged|non-merged [--input-dir <dir>] [--progress]");
        eprintln!("  build <import-dir> --collection-id <id> [--update] [--dry-run] [--version-id <id>] [--base-dir <dir>] [--collection-dir <dir>] [--progress] [--verbose]");
    eprintln!();
        eprintln!("  Build uses the collection_id to find the latest version from the");
        eprintln!("  database. Use --update to upgrade in-place (renames old folder, deletes");
    eprintln!("  old version from DB). Default mode creates a delta folder for each version.");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  --json                 Output in JSON format");
    eprintln!("  --db <path>            Database path (required, or $ROM_DB)");
    eprintln!("  --verbose              Verbose per-game decision logging on stderr");
}

fn main() -> ExitCode {
    if std::env::args().any(|a| a == "--version") {
        println!("build-cli {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_target(true)
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    let json = has_json();
    let clean = strip_global_flags(&args);

    if clean.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    let exit = match clean[1].as_str() {
        "dat" => cmd_dat(&clean[1..], json),
        "scan" => cmd_scan(&clean[1..], json),
        "verify" => cmd_verify(&clean[1..], json),
        "diff" => cmd_diff(&clean[1..], json),
        "fixdat" => cmd_fixdat(&clean[1..], json),
        "export" => cmd_export(&clean[1..], json),
        "build" => cmd_build(&clean[1..], json),
        _ => {
            eprintln!("Unknown command: {}", clean[1]);
            ExitCode::FAILURE
        }
    };

    if exit != ExitCode::SUCCESS && json {
        let err = serde_json::json!({"error": "command failed"});
        println!("{}", serde_json::to_string_pretty(&err).unwrap());
    }

    exit
}

fn cmd_dat(args: &[String], json: bool) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: build-cli dat <list|info> ...");
        return ExitCode::FAILURE;
    }
    match args[1].as_str() {
        "list" => cmd_dat_list(json),
        "info" => cmd_dat_info(&args[1..], json),
        _ => {
            eprintln!("Unknown dat subcommand: {}", args[1]);
            ExitCode::FAILURE
        }
    }
}

fn open_db() -> Result<Database, String> {
    Database::open(&db_path()).map_err(|e| format!("Database error: {}", e))
}

fn cmd_dat_list(json: bool) -> ExitCode {
    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let versions = match db.list_versions() { Ok(v) => v, Err(e) => { eprintln!("Error: {}", e); return ExitCode::FAILURE; } };

    if json {
        let entries: Vec<VersionEntry> = versions.iter().map(|v| VersionEntry {
            id: v.id, collection_id: v.collection_id, version: v.version.clone(),
            directory: v.dir.clone(), total_games: v.total_games, total_roms: v.total_roms,
        }).collect();
        print_json(&serde_json::json!({"versions": entries}));
    } else {
        if versions.is_empty() { println!("No versions imported."); return ExitCode::SUCCESS; }
        println!("{:<5} {:<12} {:<12} {:<30} {}/{}", "ID", "Collection", "Version", "Directory", "Games", "ROMs");
        println!("{}", "-".repeat(80));
        for v in &versions {
            println!("{:<5} {:<12} {:<12} {:<30} {}/{}", v.id, v.collection_id, v.version,
                v.dir.as_deref().unwrap_or("-"), v.total_games, v.total_roms);
        }
    }
    ExitCode::SUCCESS
}

fn cmd_dat_info(args: &[String], json: bool) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: build-cli dat info <version-id>");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let version = match db.get_version(version_id) {
        Ok(Some(v)) => v,
        Ok(None) => { eprintln!("Version {} not found", version_id); return ExitCode::FAILURE; }
        Err(e) => { eprintln!("Error: {}", e); return ExitCode::FAILURE; }
    };
    let games = match db.list_games(version_id) {
        Ok(g) => g,
        Err(e) => { eprintln!("Error: {}", e); return ExitCode::FAILURE; }
    };

    if json {
        let info = serde_json::json!({
            "version": { "id": version.id, "collection_id": version.collection_id, "version": version.version, "directory": version.dir, "total_games": version.total_games, "total_roms": version.total_roms },
            "games": games.iter().map(|g| g.name.clone()).collect::<Vec<_>>()
        });
        print_json(&info);
    } else {
        println!("ID:        {}", version.id);
        println!("Collection ID: {}", version.collection_id);
        println!("Version:   {}", version.version);
        if let Some(dir) = &version.dir { println!("Directory: {}", dir); }
        println!("Games:     {} ({} ROMs)", version.total_games, version.total_roms);
    }
    ExitCode::SUCCESS
}

fn cmd_scan(args: &[String], json: bool) -> ExitCode {
    let mut game_id: Option<i64> = None;
    let mut collection_dir_arg: Option<std::path::PathBuf> = None;
    let mut clean_args: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--game-id" && i + 1 < args.len() {
            game_id = args[i + 1].parse::<i64>().ok();
            i += 2;
            continue;
        }
        if args[i] == "--collection-dir" && i + 1 < args.len() {
            collection_dir_arg = Some(std::path::PathBuf::from(&args[i + 1]));
            i += 2;
            continue;
        }
        clean_args.push(args[i].clone());
        i += 1;
    }

    if clean_args.len() < 3 {
        eprintln!("Usage: build-cli scan <version-id> <dir> [--collection-dir <dir>] [--game-id <id>] [--progress]");
        return ExitCode::FAILURE;
    }
    let show_progress = clean_args.iter().any(|a| a == "--progress");
    let version_id: i64 = match clean_args[1].parse() {
        Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", clean_args[1]); return ExitCode::FAILURE; }
    };
    let dir = std::path::Path::new(&clean_args[2]);
    if !dir.exists() { eprintln!("Directory not found: {}", clean_args[2]); return ExitCode::FAILURE; }

    let emit_progress = |pct: u32, msg: &str| {
        if show_progress {
            eprintln!(r#"{{"phase":"scanning","pct":{},"msg":"{}","matched":0,"missing":0,"total":0}}"#, pct, msg);
        }
    };

    emit_progress(0, "Loading games...");
    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let all_games = match db.list_games(version_id) {
        Ok(g) => g, Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };
    let game_map: HashMap<i64, &rom_manager::models::Game> = all_games.iter().map(|g| (g.id, g)).collect();

    emit_progress(10, "Checking prior versions...");
    let (collection_dir, prior_versions) = if let Some(cd) = &collection_dir_arg {
        let version_file = cd.join(".version");
        let versions = if version_file.exists() {
            std::fs::read_to_string(&version_file).ok()
                .map(|content| content.lines().map(|l| l.trim().to_string()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let current_version = db.get_version(version_id).ok().flatten().map(|v| v.version);
        let prior = current_version.as_ref()
            .map(|cv| rom_manager::builder::filter_prior_versions(&versions, cv))
            .unwrap_or_default();
        (Some(cd.as_path()), prior)
    } else {
        (None, vec![])
    };

    let roms_dir = dir.join(rom_manager::builder::ROMS_DIR_NAME);
    struct ScanEntry {
        name: String,
        game_id: i64,
        source: String,
    }

    let mut matched_entries: Vec<ScanEntry> = Vec::new();
    let mut missing: Vec<MissingGame> = Vec::new();
    let total = all_games.len();

    emit_progress(15, "Checking games...");
    for (idx, game) in all_games.iter().enumerate() {
        if let Some(gid) = game_id {
            if game.id != gid { continue; }
        }

        match check_game_availability(&db, version_id, game.id, &game_map, &roms_dir, collection_dir, &prior_versions, &all_games) {
            Ok(Availability::Existed) => {
                matched_entries.push(ScanEntry {
                    name: game.name.clone(),
                    game_id: game.id,
                    source: "existed".to_string(),
                });
            }
            Ok(Availability::Reused { .. }) => {
                matched_entries.push(ScanEntry {
                    name: game.name.clone(),
                    game_id: game.id,
                    source: "reused".to_string(),
                });
            }
            Ok(Availability::Missing { reason, rom_details }) => {
                missing.push(MissingGame {
                    name: game.name.clone(),
                    game_id: game.id,
                    platform: game.platform.clone(),
                    reason,
                    rom_details,
                    sampleof: game.sampleof.clone(),
                    sample_details: vec![],
                });
            }
            Err(e) => {
                eprintln!("  error checking {}: {}", game.name, e);
                missing.push(MissingGame {
                    name: game.name.clone(),
                    game_id: game.id,
                    platform: game.platform.clone(),
                    reason: rom_manager::models::MissingReason::FileNotFound,
                    rom_details: vec![],
                    sampleof: game.sampleof.clone(),
                    sample_details: vec![],
                });
            }
        }

        if idx % 100 == 0 {
            emit_progress(15 + ((idx as u64 * 40) / total.max(1) as u64) as u32, &format!("Checking games ({}/{})", idx + 1, total));
        }
    }

    matched_entries.sort_by(|a, b| a.name.cmp(&b.name));
    missing.sort_by(|a, b| a.name.cmp(&b.name));

    emit_progress(60, "Building results...");
    let matches: Vec<ScanMatch> = matched_entries.iter().map(|e| ScanMatch {
        name: e.name.clone(),
        game_id: Some(e.game_id),
        filename: None,
    }).collect();

    let matched_names: HashSet<String> = matched_entries.iter().map(|e| e.name.clone()).collect();
    let expected_names: HashSet<String> = all_games.iter().map(|g| g.name.clone()).collect();
    let mut missing_names: Vec<String> = expected_names.difference(&matched_names).cloned().collect();
    missing_names.sort();

    let mut missing_by_platform: HashMap<String, Vec<String>> = HashMap::new();
    for game in &all_games {
        if !matched_names.contains(&game.name) {
            let plat = if game.platform.is_empty() { "unknown".to_string() } else { game.platform.clone() };
            missing_by_platform.entry(plat).or_default().push(game.name.clone());
        }
    }
    for v in missing_by_platform.values_mut() {
        v.sort();
        v.dedup();
    }

    let matched_count = matched_entries.len();
    let reused_count = matched_entries.iter().filter(|e| e.source == "reused").count();

    let samples_dir = dir.join("samples");
    let sr = if samples_dir.is_dir() {
        scan_samples(&all_games, &db, version_id, &samples_dir).unwrap_or(SampleResult { samples_found: 0, samples_missing: 0, missing_samples: Vec::new() })
    } else { SampleResult { samples_found: 0, samples_missing: 0, missing_samples: Vec::new() } };

    emit_progress(100, "Scan complete");
    let result = ScanOutput {
        total: all_games.len(),
        matched: matched_count,
        missing: missing.len(),
        matches,
        missing_names: missing_names.clone(),
        missing_by_platform,
        missing_reasons: missing.clone(),
        samples_found: sr.samples_found,
        samples_missing: sr.samples_missing,
        missing_samples: sr.missing_samples,
    };

    if json {
        print_json(&result);
    } else {
        print!("Scan complete: {} total, {} matched ({} current + {} reused), {} missing",
            total, matched_count, matched_count - reused_count, reused_count, missing.len());
        if sr.samples_found > 0 || sr.samples_missing > 0 {
            print!(" (samples: {} found, {} missing)", sr.samples_found, sr.samples_missing);
        }
        println!();
    }
    ExitCode::SUCCESS
}

fn cmd_verify(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli verify <version-id> <dir> [--fallback <id>]");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let dir = std::path::Path::new(&args[2]);
    let fallback_id: Option<i64> = args.get(3).and_then(|a| {
        if a == "--fallback" { args.get(4).and_then(|s| s.parse().ok()) } else { None }
    });

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };

    let fallback_dirs = if let Some(fb_id) = fallback_id {
        match db.get_version(fb_id) {
            Ok(Some(v)) => { vec![(fb_id, v.version, v.dir.as_ref().map(PathBuf::from).unwrap_or_default())] }
            _ => { eprintln!("Fallback version {} not found", fb_id); return ExitCode::FAILURE; }
        }
    } else { Vec::new() };

    let result = match verify_version(&db, version_id, dir, &fallback_dirs) {
        Ok(r) => r, Err(e) => { eprintln!("Verify error: {}", e); return ExitCode::FAILURE; }
    };

    if json {
        let details: Vec<VerifyDetail> = result.details.iter().map(|d| {
            let (status, name, detail) = match d {
                GameStatus::Present { name, .. } => ("present".into(), name.clone(), None),
                GameStatus::Missing { name } => ("missing".into(), name.clone(), None),
                GameStatus::Inherited { name, from_version, .. } => ("inherited".into(), name.clone(), Some(format!("from v{}", from_version))),
                GameStatus::Mismatch { name, detail, .. } => ("mismatch".into(), name.clone(), Some(detail.clone())),
            };
            VerifyDetail { status, name, detail }
        }).collect();
        print_json(&VerifyOutput {
            total_games: result.total_games, present: result.present,
            missing: result.missing, inherited: result.inherited,
            mismatched: result.mismatched, details,
        });
    } else {
        println!("Verify: {} total, {} present, {} missing, {} inherited, {} mismatched",
            result.total_games, result.present, result.missing, result.inherited, result.mismatched);
    }
    ExitCode::SUCCESS
}

fn cmd_diff(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli diff <version-id-a> <version-id-b>");
        return ExitCode::FAILURE;
    }
    let va: i64 = match args[1].parse() { Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; } };
    let vb: i64 = match args[2].parse() { Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", args[2]); return ExitCode::FAILURE; } };

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let diff = match db.diff_versions(va, vb) {
        Ok(d) => d, Err(e) => { eprintln!("Diff error: {}", e); return ExitCode::FAILURE; }
    };

    if json {
        print_json(&DiffOutput {
            version_a: diff.version_a, version_b: diff.version_b,
            added: diff.added, removed: diff.removed,
            changed: diff.changed, unchanged: diff.unchanged,
        });
    } else {
        println!("Diff {} → {}: +{} -{} ~{} ({} unchanged)",
            diff.version_a, diff.version_b, diff.added.len(), diff.removed.len(), diff.changed.len(), diff.unchanged);
    }
    ExitCode::SUCCESS
}

fn cmd_fixdat(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli fixdat <version-id-a> <version-id-b> --output <file>");
        return ExitCode::FAILURE;
    }

    let va: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let vb: i64 = match args[2].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[2]); return ExitCode::FAILURE; }
    };

    let output_path = args.iter().position(|a| a == "--output")
        .and_then(|p| args.get(p + 1))
        .map(std::path::PathBuf::from);

    let output_path = match output_path {
        Some(p) => p,
        None => { eprintln!("--output <file> is required"); return ExitCode::FAILURE; }
    };

    let db = match open_db() {
        Ok(d) => d,
        Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; }
    };

    let diff = match db.diff_versions(va, vb) {
        Ok(d) => d,
        Err(e) => { eprintln!("Diff error: {}", e); return ExitCode::FAILURE; }
    };

    // Load all games for version B to build a name→Game map
    let games_b = match db.list_games(vb) {
        Ok(g) => g,
        Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };
    let game_map: std::collections::HashMap<String, rom_manager::models::Game> = games_b
        .into_iter()
        .map(|g| (g.name.clone(), g))
        .collect();

    let names: Vec<&String> = diff.added.iter().chain(diff.changed.iter()).collect();
    let total = names.len();
    let mut errors: Vec<String> = Vec::new();
    let mut export_games = Vec::with_capacity(total);

    for name in &names {
        let game = match game_map.get(*name) {
            Some(g) => g.clone(),
            None => {
                errors.push(format!("'{}' not found in version {}", name, vb));
                continue;
            }
        };

        // Resolve cloneof (parent_game_id → parent game name)
        let cloneof = game.parent_game_id
            .and_then(|pid| game_map.values().find(|g| g.id == pid))
            .map(|g| g.name.clone());

        // Fetch romof from the rom_set
        let romof = match db.get_romof(game.id, vb) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("'{}': romof query error: {}", name, e));
                None
            }
        };

        // Fetch ROM list for version B
        let roms = match db.list_roms_for_game(game.id, vb) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("'{}': rom list error: {}", name, e));
                continue;
            }
        };

        export_games.push(ExportGame {
            name: game.name,
            description: game.description,
            year: game.year,
            manufacturer: game.manufacturer,
            cloneof,
            romof,
            isbios: game.isbios,
            roms: roms.into_iter().map(|r| ExportRom {
                name: r.filename,
                size: r.size,
                crc32: r.crc32,
                sha1: r.sha1,
                status: r.status,
            }).collect(),
        });
    }

    // Write the fixdat
    let file = match std::fs::File::create(&output_path) {
        Ok(f) => f,
        Err(e) => { eprintln!("Cannot create {}: {}", output_path.display(), e); return ExitCode::FAILURE; }
    };

    if let Err(e) = write_logiqx_dat(&export_games, file) {
        eprintln!("Write error: {}", e);
        return ExitCode::FAILURE;
    }

    let written = export_games.len();

    if json {
        let result = serde_json::json!({
            "fixdat": output_path.to_string_lossy().to_string(),
            "total": total,
            "written": written,
            "added": diff.added.len(),
            "changed": diff.changed.len(),
            "errors": errors,
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        println!("Fixdat written to {}", output_path.display());
        println!("  added:   {} games", diff.added.len());
        println!("  changed: {} games", diff.changed.len());
        if !errors.is_empty() {
            println!("  errors:  {}", errors.len());
            for e in &errors {
                println!("    - {}", e);
            }
        }
    }

    ExitCode::SUCCESS
}

fn cmd_export(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli export <version-id> <output-dir> --format split|merged|non-merged [--input-dir <dir>] [--progress]");
        return ExitCode::FAILURE;
    }

    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let output_dir = std::path::PathBuf::from(&args[2]);
    let show_progress = args.iter().any(|a| a == "--progress");

    let format = args.iter().position(|a| a == "--format")
        .and_then(|p| args.get(p + 1))
        .and_then(|s| s.parse::<MergeMode>().ok())
        .unwrap_or(MergeMode::Split);

    let input_dir = args.iter().position(|a| a == "--input-dir")
        .and_then(|p| args.get(p + 1))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };

    let progress_cb = |p: &rom_manager::builder::BuildProgress| {
        if show_progress {
            eprintln!("{}", serde_json::to_string(p).unwrap_or_default());
        }
    };

    let cancel = &CANCEL_FLAG;
    install_signal_handlers();

    match export_version(&db, version_id, &input_dir, &output_dir, format, &progress_cb, cancel) {
        Ok(result) => {
            if json {
                print_json(&serde_json::json!({
                    "version": result.version,
                    "format": result.format,
                    "total_games": result.total_games,
                    "exported": result.exported,
                    "skipped": result.skipped,
                    "merged": result.merged,
                }));
            } else {
                println!("Export complete");
                println!("  version:    {}", result.version);
                println!("  format:     {}", result.format);
                println!("  total:      {} games", result.total_games);
                println!("  exported:   {} zips", result.exported);
                if result.skipped > 0 {
                    println!("  skipped:    {} (no source zip)", result.skipped);
                }
                if result.merged > 0 {
                    println!("  merged:     {} groups merged", result.merged);
                }
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Export error: {}", e);
            ExitCode::FAILURE
        }
    }
}

fn cmd_build(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli build <import-dir> --collection-id <id> [--update] [--dry-run] [--version-id <id>] [--base-dir <dir>] [--collection-dir <dir>] [--progress]");
        return ExitCode::FAILURE;
    }
    let import_dir = std::path::Path::new(&args[1]);
    if !import_dir.is_dir() {
        eprintln!("Import directory not found: {}", args[1]);
        return ExitCode::FAILURE;
    }
    let collection_id = args.iter().position(|a| a == "--collection-id")
        .and_then(|p| args.get(p + 1))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| { eprintln!("--collection-id <id> is required"); std::process::exit(1); });

    let update = args.iter().any(|a| a == "--update");
    let show_progress = args.iter().any(|a| a == "--progress");
    let dry_run = args.iter().any(|a| a == "--dry-run");
    let verbose = args.iter().any(|a| a == "--verbose");
    let version_id = args.iter().position(|a| a == "--version-id")
        .and_then(|p| args.get(p + 1))
        .and_then(|s| s.parse::<i64>().ok());
    let base_dir = args.iter().position(|a| a == "--base-dir")
        .and_then(|p| args.get(p + 1))
        .map(|s| std::path::PathBuf::from(s))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let collection_dir = args.iter().position(|a| a == "--collection-dir")
        .and_then(|p| args.get(p + 1))
        .map(|s| std::path::PathBuf::from(s));

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };

    if show_progress {
        CANCEL_FLAG.store(false, Ordering::Relaxed);
        install_signal_handlers();
    }

    let progress_cb = |p: &rom_manager::builder::BuildProgress| {
        if show_progress {
            // JSON line to stderr for the server to parse
            eprintln!("{}", serde_json::to_string(p).unwrap_or_default());
        }
    };

    match build_version(&db, collection_id, import_dir, &base_dir, collection_dir.as_deref(), update, dry_run, version_id, &progress_cb, &CANCEL_FLAG, verbose) {
        Ok(result) => {
            if json {
                print_json(&BuildOutput {
                    source: format!("collection_{}", collection_id),
                    version: result.version,
                    mode: result.mode,
                    prev_version: result.prev_version,
                    total_games: result.total_games,
                    added: result.added,
                    exists: result.exists,
                    reused: result.reused,
                    missing: result.missing,
                    cleaned: result.cleaned,
                    matched_by_hash: result.matched_by_hash,
                    matched_ids: result.matched_ids,
                    missing_games: result.missing_games,
                    missing_reasons: result.missing_reasons,
                    samples_added: result.samples_added,
                    samples_existed: result.samples_existed,
                    samples_reused: result.samples_reused,
                    samples_missing: result.samples_missing,
                    missing_samples: result.missing_samples,
                });
            } else {
                if dry_run {
                    println!("Scan result for collection {} {}", collection_id, result.version);
                } else {
                    let mode_label = if update { "update" } else { "delta" };
                    println!("Built collection {} {} ({} mode)", collection_id, result.version, mode_label);
                }
                if let Some(ref pv) = result.prev_version {
                    println!("  from v{} → v{}", pv, result.version);
                }
                println!("  total:     {}", result.total_games);
                println!("  added:     {} (newly copied)", result.added);
                if result.matched_by_hash > 0 {
                    println!("  matched-by-hash: {} (name mismatch, renamed)", result.matched_by_hash);
                }
                if result.exists > 0 {
                    println!("  exists:    {} (already in place)", result.exists);
                }
                if result.reused > 0 {
                    println!("  reused:    {} (from prior version)", result.reused);
                }
                if result.missing > 0 {
                    println!("  missing:   {}", result.missing);
                }
                if result.cleaned > 0 {
                    println!("  cleaned:   {} (moved to deleted_roms)", result.cleaned);
                }
                if result.samples_added > 0 || result.samples_existed > 0 || result.samples_reused > 0 || result.samples_missing > 0 {
                    print!("  samples:   ");
                    if result.samples_added > 0 { print!("{} added ", result.samples_added); }
                    if result.samples_existed > 0 { print!("{} existed ", result.samples_existed); }
                    if result.samples_reused > 0 { print!("{} reused ", result.samples_reused); }
                    if result.samples_missing > 0 { print!("{} missing", result.samples_missing); }
                    println!();
                }
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Build error: {}", e);
            ExitCode::FAILURE
        }
    }
}
