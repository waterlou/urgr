use std::process::ExitCode;

use rom_manager::Database;

fn db_or_usage() -> (Database, String) {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        print_usage();
        std::process::exit(1);
    }
    let db_path = &args[2];
    match Database::open(db_path) {
        Ok(db) => (db, db_path.clone()),
        Err(e) => {
            eprintln!("Error opening database at {}: {}", db_path, e);
            std::process::exit(1);
        }
    }
}

fn table_count(db: &Database, table: &str) -> i64 {
    db.conn
        .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
        .unwrap_or(0)
}

fn print_usage() {
    eprintln!(
"db-cli  —  Inspect and query the game manager SQLite database

USAGE:
    db-cli summary <db>
    db-cli versions <db> [--source <s>]
    db-cli games   <db> <version-id> [--search <q>] [--limit <n>]
    db-cli roms    <db> <version-id> <game-id>

COMMANDS:
    summary     Show row counts for every table in the database
    versions    List all version sets (source, version, game/rom counts)
    games       List games in a version set, with optional name search
    roms        List ROM entries for a specific game

ARGUMENTS:
    <db>            Path to the game-manager SQLite database file
    <version-id>    Numeric version ID (use 'versions' to find it)
    <game-id>       Numeric game entry ID (use 'games' to find it)

OPTIONS:
    --source <s>    When listing versions, filter to a specific source
    --search <q>    When listing games, only show names containing <q>
    --limit <n>     Max rows to show (default: 50, use 0 for unlimited)

EXAMPLES:
    db-cli summary ~/roms/games.db
    db-cli versions ~/roms/games.db
    db-cli versions ~/roms/games.db --source mame
    db-cli games ~/roms/games.db 1 --search 1942
    db-cli games ~/roms/games.db 1 --limit 10
    db-cli roms ~/roms/games.db 1 42
");
}

fn cmd_summary(db: Database, _db_path: String) -> ExitCode {
    println!("Database Summary");
    println!("{}", "─".repeat(50));
    println!("  set_versions    {:>8}  (imported DAT sets)", table_count(&db, "set_versions"));
    println!("  game_entries    {:>8}  (parsed games)",      table_count(&db, "game_entries"));
    println!("  rom_entries     {:>8}  (ROM files)",         table_count(&db, "rom_entries"));

    let versions = db.list_versions().unwrap_or_default();
    if !versions.is_empty() {
        println!();
        println!("Available versions (use `db-cli versions <db>` for details):");
        for v in &versions {
            println!("  [{}] col:{} {}", v.id, v.collection_id, v.version);
        }
    }
    ExitCode::SUCCESS
}

fn cmd_versions(db: Database, _db_path: String) -> ExitCode {
    let all_args: Vec<String> = std::env::args().collect();
    let source_filter: Option<String> = all_args
        .iter()
        .position(|a| a == "--collection-id")
        .and_then(|p| all_args.get(p + 1).cloned());

    let versions = match db.list_versions() {
        Ok(v) => v,
        Err(e) => { eprintln!("Error listing versions: {}", e); return ExitCode::FAILURE; }
    };

    let filtered: Vec<_> = versions
        .into_iter()
        .filter(|v| source_filter.as_ref().map_or(true, |s| v.collection_id.to_string() == *s))
        .collect();

    if filtered.is_empty() {
        println!("No versions found{}.",
            source_filter.map_or(String::new(), |s| format!(" for collection_id '{}'", s)));
        return ExitCode::SUCCESS;
    }

    println!("ID   ColID  Version        Games   ROMs   Directory");
    println!("{}", "─".repeat(72));
    for v in &filtered {
        let dir = v.dir.as_deref().unwrap_or("-");
        println!("{:<4} {:<6} {:<14} {:>6} {:>6} {}",
            v.id, v.collection_id, v.version, v.total_games, v.total_roms, dir);
    }
    ExitCode::SUCCESS
}

fn cmd_games(db: Database, _db_path: String) -> ExitCode {
    let args: Vec<String> = std::env::args().collect();

    let version_id: i64 = match args.get(3).and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => { eprintln!("Error: <version-id> must be a number"); return ExitCode::FAILURE; }
    };

    let all_args: Vec<String> = std::env::args().collect();
    let search = all_args
        .iter()
        .position(|a| a == "--search")
        .and_then(|p| all_args.get(p + 1).cloned());

    let limit: usize = all_args
        .iter()
        .position(|a| a == "--limit")
        .and_then(|p| all_args.get(p + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);

    // verify version exists
    if db.get_version(version_id).ok().flatten().is_none() {
        eprintln!("Error: version {} not found", version_id);
        return ExitCode::FAILURE;
    }

    let all_games = match db.list_games(version_id) {
        Ok(g) => g,
        Err(e) => { eprintln!("Error listing games: {}", e); return ExitCode::FAILURE; }
    };

    let filtered: Vec<_> = all_games
        .into_iter()
        .filter(|g| search.as_ref().map_or(true, |q| g.name.to_lowercase().contains(&q.to_lowercase())))
        .collect();

    let total = filtered.len();
    let shown = if limit == 0 { filtered.len() } else { filtered.len().min(limit) };

    if shown == 0 {
        println!("No games match{}.", search.map_or(String::new(), |s| format!(" '{}'", s)));
        return ExitCode::SUCCESS;
    }

    let parent_names: std::collections::HashMap<i64, String> = filtered.iter()
        .filter_map(|g| g.parent_game_id.map(|pid| (pid, g.name.clone())))
        .collect();
    println!("Games in version {} (showing {} of {}):", version_id, shown, total);
    println!("{}", "─".repeat(72));
    println!("{:<6} {:<28} {:<6} {:<18} {:<12}", "ID", "Name", "Year", "Manufacturer", "Cloneof");
    println!("{}", "─".repeat(72));
    for g in &filtered[..shown] {
        let year = g.year.as_deref().unwrap_or("-");
        let mfr = g.manufacturer.as_deref().unwrap_or("-");
        let clone = g.parent_game_id.and_then(|pid| parent_names.get(&pid)).map(|s| s.as_str()).unwrap_or("-");
        println!("{:<6} {:<28} {:<6} {:<18} {:<12}", g.id, g.name, year, mfr, clone);
    }
    if shown < total {
        println!("... and {} more (use --limit 0 to see all)", total - shown);
    }
    ExitCode::SUCCESS
}

fn cmd_roms(db: Database, _db_path: String) -> ExitCode {
    let args: Vec<String> = std::env::args().collect();

    let version_id: i64 = match args.get(3).and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => { eprintln!("Error: <version-id> must be a number"); return ExitCode::FAILURE; }
    };
    let game_id: i64 = match args.get(4).and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => { eprintln!("Error: <game-id> must be a number"); return ExitCode::FAILURE; }
    };

    let roms = match db.list_roms_for_game(game_id, version_id) {
        Ok(r) => r,
        Err(e) => { eprintln!("Error listing ROMs: {}", e); return ExitCode::FAILURE; }
    };

    if roms.is_empty() {
        println!("No ROM entries for game_id {}.", game_id);
        return ExitCode::SUCCESS;
    }

    println!("ROM entries for game_id {} ({} files):", game_id, roms.len());
    println!("{}", "─".repeat(100));
    println!("{:<6} {:<30} {:>8} {:<10} {:<10} {:<10}", "ID", "Filename", "Size", "CRC32", "Status", "Merge");
    println!("{}", "─".repeat(100));
    for r in &roms {
        let size = r.size.map(|s| format!("{}", s)).unwrap_or_else(|| "-".into());
        let crc = r.crc32.as_deref().unwrap_or("-");
        let merge = r.merge_target.as_deref().unwrap_or("-");
        println!("{:<6} {:<30} {:>8} {:<10} {:<10} {:<10}", r.id, r.filename, size, crc, r.status, merge);
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    if std::env::args().any(|a| a == "--version") {
        println!("db-cli {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    match args[1].as_str() {
        "summary"  => cmd_summary(db_or_usage().0, db_or_usage().1),
        "versions" => cmd_versions(db_or_usage().0, db_or_usage().1),
        "games"    => cmd_games(db_or_usage().0, db_or_usage().1),
        "roms"     => cmd_roms(db_or_usage().0, db_or_usage().1),
        _ => {
            if args[1] == "--help" || args[1] == "-h" {
                print_usage();
                ExitCode::SUCCESS
            } else {
                eprintln!("Unknown command: {}", args[1]);
                print_usage();
                ExitCode::FAILURE
            }
        }
    }
}
