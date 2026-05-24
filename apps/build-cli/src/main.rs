use std::path::PathBuf;
use std::process::ExitCode;

use rom_manager::scanner::scan_directory;
use rom_manager::verifier::{verify_version, GameStatus};
use rom_manager::Database;
use serde::Serialize;

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
    total_files: usize,
    matched_games: usize,
    missing_games: usize,
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
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  --json                 Output in JSON format");
    eprintln!("  --db <path>            Database path (required, or $ROM_DB)");
}

fn main() -> ExitCode {
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
    if args.len() < 3 {
        eprintln!("Usage: build-cli scan <version-id> <dir>");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id, Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let dir = std::path::Path::new(&args[2]);
    if !dir.exists() { eprintln!("Directory not found: {}", args[2]); return ExitCode::FAILURE; }

    let db = match open_db() { Ok(d) => d, Err(e) => { eprintln!("{}", e); return ExitCode::FAILURE; } };
    let result = match scan_directory(&db, version_id, dir) {
        Ok(r) => r, Err(e) => { eprintln!("Scan error: {}", e); return ExitCode::FAILURE; }
    };

    if json {
        print_json(&ScanOutput { total_files: result.total_files, matched_games: result.matched_games, missing_games: result.missing_games });
    } else {
        println!("Scan complete: {} files, {} matched, {} missing", result.total_files, result.matched_games, result.missing_games);
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
