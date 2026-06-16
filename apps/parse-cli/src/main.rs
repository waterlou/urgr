use std::collections::HashMap;
use std::process::ExitCode;

use rom_manager::dat::{detect_format, parse_dat};
use rom_manager::models::ParsedGame;
use rom_manager::Database;
use serde::Serialize;

#[derive(Serialize)]
struct DatImportOutput {
    format: String,
    total_games_parsed: usize,
    total_roms_parsed: usize,
    games_inserted: usize,
    roms_inserted: usize,
    version_id: i64,
    warnings: Vec<String>,
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

fn print_json<T: Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn print_usage() {
    eprintln!(
"parse-cli  —  Import ROM DAT sets into the game manager database

This tool reads a DAT file (MAME listxml, Logiqx XML, or ClrMAMEPro format),
detects its format automatically, parses all games and ROM entries, then
inserts them into the SQLite database as a new versioned set. Each import
creates a version row that groups the games together, so you can later diff,
verify, or build against that specific set.

USAGE:
    parse-cli import <file> <source> <version> [--dir <dir>] [--json] --db <path>

ARGUMENTS:
    <file>              Path to the DAT file (.dat, .xml, .txt)
    <source>            Short label identifying the source collection.
                        Examples: mame, fbneo, no-intro, redump, tosec
    <version>           Version string for this set. This is stored verbatim
                        and used to identify the version later.
                        Examples: \"0.261\", \"1.0.0.03\", \"2024-01-01\"

OPTIONS:
    --dir <dir>         Base directory where the actual ROM ZIP files live.
                        Stored with the version so build-cli knows where to
                        scan for ROM files later.
    --db <path>         Path to the game manager SQLite database file.
                        Required unless the ROM_DB environment variable is set.
    --json              Print the import summary as JSON instead of plain text.
                        Useful for scripting or piping into jq.

MAME FILTER OPTIONS:
    --status <s>        Only import games with matching driver status.
                        Values: good, imperfect, preliminary.
    --exclude-bios      Exclude BIOS games (isbios='yes').
    --only-runnable     Only import runnable games (runnable='yes').
                        Excludes devices and unplayable machines.

ENVIRONMENT VARIABLES:
    ROM_DB              Default database path. Used when --db is not given.

WHAT HAPPENS:
    1. The DAT file is opened and its format is automatically detected
       (MAME listxml / Logiqx XML / ClrMAMEPro).
    2. All <game> / machine entries are parsed into GameEntry records.
    3. All <rom> entries are parsed into RomEntry records, linked to their
       parent game.
    4. A new version row is created in the 'set_versions' table with the
       given source label and version string.
    5. All games are inserted into 'set_games' with a foreign key to the
       new version.
    6. All ROMs are inserted into 'set_roms' with a foreign key to their
       parent game.
    7. A summary is printed showing how many games and ROMs were imported.

EXAMPLES:

  # Import a MAME listxml into a fresh database
  parse-cli import mame0261.xml mame 0.261 --db ~/roms/games.db

  # Import an FBNeo ClrMAMEPro DAT and record where the ROM zips live
  parse-cli import fbneo.dat fbneo 1.0.0.03 \\
      --dir /mnt/roms/fbneo --db ~/roms/games.db

  # Import a No-Intro set, output JSON for scripting
  parse-cli import nintendo.dat no-intro 2024-01-01 \\
      --json --db ~/roms/games.db

  # Use the ROM_DB environment variable instead of --db
  export ROM_DB=~/roms/games.db
  parse-cli import nes.xml no-intro 2024-06-01
");
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("parse-cli {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let json = has_json();

    if args.len() < 5 || args[1] != "import" {
        print_usage();
        return ExitCode::FAILURE;
    }

    let file = &args[2];
    let source = &args[3];
    let version = &args[4];
    let dir = args.iter().position(|a| a == "--dir")
        .and_then(|p| args.get(p + 1));
    let platform = args.iter().position(|a| a == "--platform")
        .and_then(|p| args.get(p + 1));
    let subtype = args.iter().position(|a| a == "--subtype")
        .and_then(|p| args.get(p + 1));
    let existing_only = args.iter().any(|a| a == "--existing-only");

    // MAME filter flags
    let status_filter = args.iter().position(|a| a == "--status")
        .and_then(|p| args.get(p + 1));
    let exclude_bios = args.iter().any(|a| a == "--exclude-bios");
    let only_runnable = args.iter().any(|a| a == "--only-runnable");
    let path = std::path::Path::new(file);
    if !path.exists() {
        eprintln!("File not found: {}", file);
        return ExitCode::FAILURE;
    }

    let db_path = db_path();
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };

    let fmt = match detect_format(file) {
        Ok(f) => f,
        Err(e) => { eprintln!("Format detection failed: {}", e); return ExitCode::FAILURE; }
    };

    let (games, stats) = match parse_dat(file) {
        Ok(v) => v,
        Err(e) => { eprintln!("Parse error: {}", e); return ExitCode::FAILURE; }
    };

    let warnings = stats.errors.clone();

    let version_id = match db.import_version(source, version, dir.map(|s| s.as_str())) {
        Ok(id) => id,
        Err(e) => { eprintln!("Failed to import version: {}", e); return ExitCode::FAILURE; }
    };

    // Apply MAME filters before insertion
    let filtered: Vec<ParsedGame> = games.into_iter().filter(|game| {
        if existing_only {
            let exists = db.game_exists(&game.name, version_id).unwrap_or(false);
            if !exists { return false; }
        }
        if let Some(ref status) = status_filter {
            if game.driver_status.as_deref() != Some(status.as_str()) {
                return false;
            }
        }
        if exclude_bios && game.isbios {
            return false;
        }
        if only_runnable && game.runnable != Some(true) {
            return false;
        }
        true
    }).collect();

    let games_inserted = filtered.len();
    let mut rom_count = 0usize;
    for game in &filtered {
        let mut game_clone = game.clone();
        // If --platform was passed, override the platform field (used for FBNeo per-manufacturer dats)
        if let Some(p) = platform {
            game_clone.platform = p.to_string();
        }
        let gid = match db.insert_game(&game_clone) {
            Ok(id) => id,
            Err(e) => { eprintln!("Failed to insert game {}: {}", game_clone.name, e); return ExitCode::FAILURE; }
        };
        let rsid = match db.insert_rom_set(gid, version_id, game_clone.romof.as_deref()) {
            Ok(id) => id,
            Err(e) => { eprintln!("Failed to create ROM set for {}: {}", game_clone.name, e); return ExitCode::FAILURE; }
        };
        if !game_clone.roms.is_empty() {
            if let Err(e) = db.insert_rom_files_batch(rsid, &game_clone.roms) {
                eprintln!("Failed to insert ROMs for {}: {}", game_clone.name, e);
                return ExitCode::FAILURE;
            }
            rom_count += game_clone.roms.len();
        }
        // Set subtype on all ROM files for this rom set
        if let Some(st) = subtype {
            if let Err(e) = db.set_rom_subtype(rsid, st) {
                eprintln!("Failed to set subtype for {}: {}", game_clone.name, e);
                return ExitCode::FAILURE;
            }
        }
    }
    // Second pass: resolve cloneof → parent_game_id
    if let Err(e) = db.resolve_parents(&filtered) {
        eprintln!("Warning: failed to resolve parent references: {}", e);
    }

    if json {
        print_json(&DatImportOutput {
            format: format!("{:?}", fmt),
            total_games_parsed: stats.total_games,
            total_roms_parsed: stats.total_roms,
            games_inserted,
            roms_inserted: rom_count,
            version_id,
            warnings,
        });
    } else {
        println!("Imported {} games, {} ROMs (version_id: {})", games_inserted, rom_count, version_id);
    }

    ExitCode::SUCCESS
}
