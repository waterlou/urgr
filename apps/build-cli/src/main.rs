use std::collections::HashSet;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};

use rom_manager::builder::build_version;
use rom_manager::scanner::{scan_directory, ScanMatch};
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
    source: String,
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
    unchanged: usize,
    reused: usize,
    missing: usize,
    cleaned: usize,
    missing_games: Vec<String>,
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
    eprintln!("  build <source> <import-dir> [--update] [--dry-run] [--version-id <id>] [--base-dir <dir>]");
    eprintln!();
    eprintln!("  Build automatically detects the latest version for <source> from the");
    eprintln!("  database. Use --update to upgrade in-place (renames old folder, deletes");
    eprintln!("  old version from DB). Default mode creates a delta folder for each version.");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  --json                 Output in JSON format");
    eprintln!("  --db <path>            Database path (required, or $ROM_DB)");
}

fn main() -> ExitCode {
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
            id: v.id, source: v.source.clone(), version: v.version.clone(),
            directory: v.dir.clone(), total_games: v.total_games, total_roms: v.total_roms,
        }).collect();
        print_json(&serde_json::json!({"versions": entries}));
    } else {
        if versions.is_empty() { println!("No versions imported."); return ExitCode::SUCCESS; }
        println!("{:<5} {:<12} {:<12} {:<30} {}/{}", "ID", "Source", "Version", "Directory", "Games", "ROMs");
        println!("{}", "-".repeat(80));
        for v in &versions {
            println!("{:<5} {:<12} {:<12} {:<30} {}/{}", v.id, v.source, v.version,
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
            "version": { "id": version.id, "source": version.source, "version": version.version, "directory": version.dir, "total_games": version.total_games, "total_roms": version.total_roms },
            "games": games.iter().map(|g| g.name.clone()).collect::<Vec<_>>()
        });
        print_json(&info);
    } else {
        println!("ID:        {}", version.id);
        println!("Source:    {}", version.source);
        println!("Version:   {}", version.version);
        if let Some(dir) = &version.dir { println!("Directory: {}", dir); }
        println!("Games:     {} ({} ROMs)", version.total_games, version.total_roms);
    }
    ExitCode::SUCCESS
}

fn cmd_scan(args: &[String], json: bool) -> ExitCode {
    let mut game_id: Option<i64> = None;
    let mut clean_args: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--game-id" && i + 1 < args.len() {
            game_id = args[i + 1].parse::<i64>().ok();
            i += 2;
            continue;
        }
        clean_args.push(args[i].clone());
        i += 1;
    }

    if clean_args.len() < 3 {
        eprintln!("Usage: build-cli scan <version-id> <dir> [--game-id <id>]");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match clean_args[1].parse() {
        Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", clean_args[1]); return ExitCode::FAILURE; }
    };
    let dir = std::path::Path::new(&clean_args[2]);
    if !dir.exists() { eprintln!("Directory not found: {}", clean_args[2]); return ExitCode::FAILURE; }

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let games = match db.list_games(version_id) {
        Ok(g) => g, Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };
    let expected_names: HashSet<String> = games.iter().map(|g| g.name.clone()).collect();

    if let Some(gid) = game_id {
        // Single game scan
        let game = match games.iter().find(|g| g.id == gid) {
            Some(g) => g.clone(),
            None => { eprintln!("Game not found: {}", gid); return ExitCode::FAILURE; }
        };
        let expected: HashSet<String> = [game.name.clone()].into();
        let matches = match scan_directory(&expected, dir) {
            Ok(m) => m, Err(e) => { eprintln!("Scan error: {}", e); return ExitCode::FAILURE; }
        };
        let matched = matches.len();
        let missing: Vec<String> = if matched == 0 { vec![game.name.clone()] } else { vec![] };
        let result = ScanOutput { total: 1, matched, missing: 1 - matched, matches, missing_names: missing };
        if json { print_json(&result); }
        else { println!("Scan complete: {} matched, {} missing", matched, 1 - matched); }
    } else {
        // Full scan
        let matches = match scan_directory(&expected_names, dir) {
            Ok(m) => m, Err(e) => { eprintln!("Scan error: {}", e); return ExitCode::FAILURE; }
        };
        let matched_names: HashSet<String> = matches.iter().map(|m| m.name.clone()).collect();
        let missing: Vec<String> = expected_names.difference(&matched_names).cloned().collect();
        let matched = matches.len();
        let result = ScanOutput { total: expected_names.len(), matched, missing: missing.len(), matches, missing_names: missing.clone() };
        if json {
            print_json(&result);
        } else {
            println!("Scan complete: {} files, {} matched, {} missing", expected_names.len(), matched, missing.len());
        }
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

fn cmd_build(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: build-cli build <source> <import-dir> [--update] [--dry-run] [--version-id <id>] [--base-dir <dir>] [--collection-dir <dir>] [--progress]");
        return ExitCode::FAILURE;
    }
    let source = &args[1];
    let import_dir = std::path::Path::new(&args[2]);
    if !import_dir.is_dir() {
        eprintln!("Import directory not found: {}", args[2]);
        return ExitCode::FAILURE;
    }

    let update = args.iter().any(|a| a == "--update");
    let show_progress = args.iter().any(|a| a == "--progress");
    let dry_run = args.iter().any(|a| a == "--dry-run");
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

    match build_version(&db, source, import_dir, &base_dir, collection_dir.as_deref(), update, dry_run, version_id, &progress_cb, &CANCEL_FLAG) {
        Ok(result) => {
            if json {
                print_json(&BuildOutput {
                    source: source.to_string(),
                    version: result.version,
                    mode: result.mode,
                    prev_version: result.prev_version,
                    total_games: result.total_games,
                    added: result.added,
                    exists: result.exists,
                    unchanged: result.unchanged,
                    reused: result.reused,
                    missing: result.missing,
                    cleaned: result.cleaned,
                    missing_games: result.missing_games,
                });
            } else {
                if dry_run {
                    println!("Scan result for {} {}", source, result.version);
                } else {
                    let mode_label = if update { "update" } else { "delta" };
                    println!("Built {} {} ({} mode)", source, result.version, mode_label);
                }
                if let Some(ref pv) = result.prev_version {
                    println!("  from v{} → v{}", pv, result.version);
                }
                println!("  total:     {}", result.total_games);
                println!("  added:     {} (newly copied)", result.added);
                if result.exists > 0 {
                    println!("  exists:    {} (already in place)", result.exists);
                }
                if result.reused > 0 {
                    println!("  reused:    {} (from prior version)", result.reused);
                }
                if result.unchanged > 0 {
                    println!("  unchanged: {} (kept from prev)", result.unchanged);
                }
                if result.missing > 0 {
                    println!("  missing:   {}", result.missing);
                }
                if result.cleaned > 0 {
                    println!("  cleaned:   {} (moved to deleted_roms)", result.cleaned);
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
