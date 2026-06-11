use std::collections::HashMap;
use std::process::ExitCode;

use rom_manager::dat::{detect_format, parse_dat};
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

    let (games, roms, stats) = match parse_dat(file) {
        Ok(v) => v,
        Err(e) => { eprintln!("Parse error: {}", e); return ExitCode::FAILURE; }
    };

    let warnings = stats.errors.clone();

    let version_id = match db.import_version(source, version, dir.map(|s| s.as_str())) {
        Ok(id) => id,
        Err(e) => { eprintln!("Failed to import version: {}", e); return ExitCode::FAILURE; }
    };

    let mut parser_id_to_db_id: HashMap<i64, i64> = HashMap::new();
    for game in &games {
        match db.insert_game(version_id, game) {
            Ok(db_id) => {
                parser_id_to_db_id.insert(game.id, db_id);
                // Set platform if provided
                if let Some(p) = platform {
                    if let Err(e) = db.set_game_platform(db_id, p) {
                        eprintln!("Failed to set platform: {}", e);
                    }
                }
            }
            Err(e) => { eprintln!("Failed to insert game {}: {}", game.name, e); return ExitCode::FAILURE; }
        }
    }
    let games_inserted = games.len();

    let mut rom_count = 0usize;
    for rom in &roms {
        if let Some(&db_game_id) = parser_id_to_db_id.get(&rom.game_entry_id) {
            let mut r = rom.clone();
            r.game_entry_id = db_game_id;
            if let Err(e) = db.insert_rom(db_game_id, &r) {
                eprintln!("Failed to insert ROM {}: {}", rom.filename, e);
            } else {
                rom_count += 1;
            }
        }
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
