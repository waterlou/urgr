use std::path::PathBuf;
use std::process::ExitCode;

use rom_manager::dat::{detect_format, parse_dat};
use rom_manager::scanner::scan_directory;
use rom_manager::verifier::verify_version;
use rom_manager::Database;
use rom_scraper::{compute_hashes, parse_filename, Config, ScraperRegistry};

fn db_path() -> String {
    std::env::var("ROM_DB").unwrap_or_else(|_| "roms.db".to_string())
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli <command> [options]");
        eprintln!();
        eprintln!("Commands:");
        eprintln!("  hash <file>            Compute ROM hashes");
        eprintln!("  search <query>         Search games by name");
        eprintln!("  scrape <file>          Match a ROM file via hash");
        eprintln!("  detail <game-id>       Get full game details");
        eprintln!("  dat import <file> <source> <version> [--dir <path>]");
        eprintln!("  dat list               List imported versions");
        eprintln!("  scan <version-id> <dir>");
        eprintln!("  verify <version-id> <dir> [--fallback <id>]");
        eprintln!("  diff <version-id-a> <version-id-b>");
        eprintln!();
        eprintln!("Environment:");
        eprintln!("  ROM_DB              SQLite database path (default: roms.db)");
        eprintln!("  SS_DEVID            ScreenScraper dev ID");
        eprintln!("  SS_DEVPASSWORD      ScreenScraper dev password");
        return ExitCode::FAILURE;
    }

    match args[1].as_str() {
        "hash" => cmd_hash(&args[1..]).await,
        "search" => cmd_search(&args[1..]).await,
        "scrape" => cmd_scrape(&args[1..]).await,
        "detail" => cmd_detail(&args[1..]).await,
        "dat" => cmd_dat(&args[1..]),
        "scan" => cmd_scan(&args[1..]),
        "verify" => cmd_verify(&args[1..]),
        "diff" => cmd_diff(&args[1..]),
        _ => {
            eprintln!("Unknown command: {}", args[1]);
            ExitCode::FAILURE
        }
    }
}

// ── Existing commands ──

async fn cmd_hash(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli hash <file>");
        return ExitCode::FAILURE;
    }
    let path = PathBuf::from(&args[1]);
    if !path.exists() {
        eprintln!("File not found: {}", path.display());
        return ExitCode::FAILURE;
    }
    match compute_hashes(&path) {
        Ok(hashes) => {
            let filename = path.file_name().map(|n| n.to_string_lossy());
            if let Some(name) = filename {
                if let Some(parsed) = parse_filename(&name) {
                    println!("Title:    {}", parsed.title);
                    if let Some(region) = parsed.region {
                        println!("Region:   {}", region);
                    }
                }
            }
            println!("CRC32:    {}", hashes.crc32);
            println!("MD5:      {}", hashes.md5);
            println!("SHA1:     {}", hashes.sha1);
            println!("Size:     {} bytes", hashes.size);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Hash error: {}", e);
            ExitCode::FAILURE
        }
    }
}

async fn cmd_search(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli search <query> [--platform <name>]");
        return ExitCode::FAILURE;
    }
    let query = &args[1];
    let platform = args.get(2).and_then(|p| {
        if p == "--platform" { args.get(3) } else { None }
    });
    let registry = build_registry();
    match registry {
        Some(reg) => match reg.search_by_name(query, platform.map(|s| s.as_str())).await {
            Ok(games) => {
                if games.is_empty() {
                    println!("No results found.");
                } else {
                    for game in &games {
                        println!(
                            "[{}] {} ({}) — {}",
                            game.id,
                            game.title,
                            game.platform.short_name,
                            game.release_date.as_deref().unwrap_or("N/A")
                        );
                    }
                }
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Search error: {}", e);
                ExitCode::FAILURE
            }
        },
        None => ExitCode::FAILURE,
    }
}

async fn cmd_scrape(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli scrape <file>");
        return ExitCode::FAILURE;
    }
    let path = PathBuf::from(&args[1]);
    if !path.exists() {
        eprintln!("File not found: {}", path.display());
        return ExitCode::FAILURE;
    }
    let registry = build_registry();
    match registry {
        Some(reg) => {
            let hashes = match compute_hashes(&path) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("Hash error: {}", e);
                    return ExitCode::FAILURE;
                }
            };
            println!("Hashes:");
            println!("  CRC32: {}", hashes.crc32);
            println!("  MD5:   {}", hashes.md5);
            println!("  SHA1:  {}", hashes.sha1);
            println!();
            match reg.search_by_hashes(&hashes, None).await {
                Ok(Some(game)) => {
                    println!("Matched: {}", game.title);
                    println!("Platform: {}", game.platform.name);
                    println!("Description: {}", truncate(&game.description, 200));
                    if let Some(pub_) = game.publisher {
                        println!("Publisher: {}", pub_);
                    }
                    println!(
                        "Covers: {} | Screenshots: {}",
                        game.media.covers.len(),
                        game.media.screenshots.len()
                    );
                    ExitCode::SUCCESS
                }
                Ok(None) => {
                    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if let Some(parsed) = parse_filename(filename) {
                        println!("No hash match. Trying filename: {}", parsed.title);
                        match reg.search_by_name(&parsed.title, None).await {
                            Ok(games) if !games.is_empty() => {
                                println!("Top result: {} [{}]", games[0].title, games[0].id);
                            }
                            _ => {
                                println!("No match found for this ROM.");
                            }
                        }
                    } else {
                        println!("No match found for this ROM.");
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Scrape error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }
        None => ExitCode::FAILURE,
    }
}

async fn cmd_detail(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli detail <game-id>");
        return ExitCode::FAILURE;
    }
    let game_id = &args[1];
    let registry = build_registry();
    match registry {
        Some(reg) => {
            match reg
                .get_game_detail(game_id, &rom_scraper::ScrapeSource::ScreenScraper)
                .await
            {
                Ok(Some(game)) => {
                    println!("ID:       {}", game.id);
                    println!("Title:    {}", game.title);
                    println!("Platform: {} ({})", game.platform.name, game.platform.short_name);
                    println!("Synopsis: {}", truncate(&game.description, 500));
                    if let Some(p) = &game.publisher {
                        println!("Publisher: {}", p);
                    }
                    if let Some(d) = &game.developer {
                        println!("Developer: {}", d);
                    }
                    if let Some(d) = &game.release_date {
                        println!("Released: {}", d);
                    }
                    if let Some(p) = game.players {
                        println!("Players:  {}", p);
                    }
                    if !game.genres.is_empty() {
                        println!("Genres:   {}", game.genres.join(", "));
                    }
                    if !game.media.covers.is_empty() {
                        println!("Covers:");
                        for c in &game.media.covers {
                            println!("  {}", c.url);
                        }
                    }
                    if !game.media.screenshots.is_empty() {
                        println!("Screenshots:");
                        for s in &game.media.screenshots {
                            println!("  {}", s.url);
                        }
                    }
                    if !game.roms.is_empty() {
                        println!("ROMs:");
                        for r in &game.roms {
                            println!(
                                "  {} (CRC: {})",
                                r.filename.as_deref().unwrap_or("?"),
                                r.crc32.as_deref().unwrap_or("-")
                            );
                        }
                    }
                    ExitCode::SUCCESS
                }
                Ok(None) => {
                    eprintln!("Game not found: {}", game_id);
                    ExitCode::FAILURE
                }
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }
        None => ExitCode::FAILURE,
    }
}

// ── New commands ──

fn cmd_dat(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli dat <import|list> ...");
        return ExitCode::FAILURE;
    }
    match args[1].as_str() {
        "import" => cmd_dat_import(&args[1..]),
        "list" => cmd_dat_list(&args[1..]),
        _ => {
            eprintln!("Unknown dat subcommand: {}", args[1]);
            eprintln!("Usage: rom-scraper-cli dat <import|list> ...");
            ExitCode::FAILURE
        }
    }
}

fn cmd_dat_import(args: &[String]) -> ExitCode {
    // args[0] = "import", args[1] = file, args[2] = source, args[3] = version
    if args.len() < 4 {
        eprintln!("Usage: rom-scraper-cli dat import <file> <source> <version> [--dir <path>]");
        return ExitCode::FAILURE;
    }
    let file = &args[1];
    let source = &args[2];
    let version = &args[3];
    let dir = args.get(4).and_then(|a| {
        if a == "--dir" { args.get(5) } else { None }
    });

    let path = std::path::Path::new(file);
    if !path.exists() {
        eprintln!("File not found: {}", file);
        return ExitCode::FAILURE;
    }

    let db = match Database::open(&db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let fmt = match detect_format(file) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Format detection failed: {}", e);
            return ExitCode::FAILURE;
        }
    };
    println!("Detected format: {:?}", fmt);

    let (games, roms, stats) = match parse_dat(file) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Parse error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    println!("Parsed {} games ({} ROMs)", stats.total_games, stats.total_roms);
    if !stats.errors.is_empty() {
        for err in &stats.errors {
            eprintln!("  Warning: {}", err);
        }
    }

    let version_id = match db.import_version(source, version, dir.map(|s| s.as_str())) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("Failed to import version: {}", e);
            return ExitCode::FAILURE;
        }
    };

    // Insert games one at a time so we capture the DB-assigned IDs
    use std::collections::HashMap;
    let mut parser_id_to_db_id: HashMap<i64, i64> = HashMap::new();
    for game in &games {
        match db.insert_game(version_id, game) {
            Ok(db_id) => {
                parser_id_to_db_id.insert(game.id, db_id);
            }
            Err(e) => {
                eprintln!("Failed to insert game {}: {}", game.name, e);
                return ExitCode::FAILURE;
            }
        }
    }
    println!("Inserted {} game entries", games.len());

    // Insert ROMs with remapped game_entry_id
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
    println!("Inserted {} ROM entries", rom_count);
    println!("Version ID: {}", version_id);

    ExitCode::SUCCESS
}

fn cmd_dat_list(args: &[String]) -> ExitCode {
    let _ = args;
    let db = match Database::open(&db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let versions = match db.list_versions() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    if versions.is_empty() {
        println!("No versions imported.");
        return ExitCode::SUCCESS;
    }

    println!("{:<5} {:<12} {:<12} {:<30} {}", "ID", "Source", "Version", "Directory", "Games/Roms");
    println!("{}", "-".repeat(80));
    for v in &versions {
        let dir = v.dir.as_deref().unwrap_or("-");
        println!(
            "{:<5} {:<12} {:<12} {:<30} {}/{}",
            v.id, v.source, v.version, dir, v.total_games, v.total_roms
        );
    }

    ExitCode::SUCCESS
}

fn cmd_scan(args: &[String]) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: rom-scraper-cli scan <version-id> <dir>");
        return ExitCode::FAILURE;
    }

    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => {
            eprintln!("Invalid version ID: {}", args[1]);
            return ExitCode::FAILURE;
        }
    };
    let dir = std::path::Path::new(&args[2]);

    if !dir.exists() {
        eprintln!("Directory not found: {}", args[2]);
        return ExitCode::FAILURE;
    }

    let db = match Database::open(&db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    println!("Scanning {} for version {}...", dir.display(), version_id);
    let result = match scan_directory(&db, version_id, dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Scan error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    println!("Scan complete:");
    println!("  Total files:     {}", result.total_files);
    println!("  Matched games:   {}", result.matched_games);
    println!("  Missing games:   {}", result.missing_games);

    ExitCode::SUCCESS
}

fn cmd_verify(args: &[String]) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: rom-scraper-cli verify <version-id> <dir> [--fallback <id>]");
        return ExitCode::FAILURE;
    }

    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => {
            eprintln!("Invalid version ID: {}", args[1]);
            return ExitCode::FAILURE;
        }
    };
    let dir = std::path::Path::new(&args[2]);

    let fallback_id: Option<i64> = args.get(3).and_then(|a| {
        if a == "--fallback" {
            args.get(4).and_then(|s| s.parse().ok())
        } else {
            None
        }
    });

    let db = match Database::open(&db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let fallback_dirs = if let Some(fb_id) = fallback_id {
        match db.get_version(fb_id) {
            Ok(Some(v)) => {
                let fb_dir = v.dir.as_ref().map(PathBuf::from).unwrap_or_default();
                vec![(fb_id, v.version, fb_dir)]
            }
            _ => {
                eprintln!("Fallback version {} not found", fb_id);
                return ExitCode::FAILURE;
            }
        }
    } else {
        Vec::new()
    };

    println!("Verifying version {} in {}...", version_id, dir.display());
    let result = match verify_version(&db, version_id, dir, &fallback_dirs) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Verify error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    println!("Verify complete:");
    println!("  Total games:  {}", result.total_games);
    println!("  Present:      {}", result.present);
    println!("  Missing:      {}", result.missing);
    println!("  Inherited:    {}", result.inherited);
    println!("  Mismatched:   {}", result.mismatched);

    if !result.details.is_empty() {
        println!();
        println!("Details:");
        for detail in &result.details {
            match detail {
                rom_manager::verifier::GameStatus::Present { name, .. } => {
                    println!("  ✓ {}", name);
                }
                rom_manager::verifier::GameStatus::Missing { name } => {
                    println!("  ✗ {} (missing)", name);
                }
                rom_manager::verifier::GameStatus::Inherited { name, from_version, .. } => {
                    println!("  ← {} (from v{})", name, from_version);
                }
                rom_manager::verifier::GameStatus::Mismatch { name, detail, .. } => {
                    println!("  ⚠ {} ({})", name, detail);
                }
            }
        }
    }

    ExitCode::SUCCESS
}

fn cmd_diff(args: &[String]) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: rom-scraper-cli diff <version-id-a> <version-id-b>");
        return ExitCode::FAILURE;
    }

    let va: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => {
            eprintln!("Invalid version ID: {}", args[1]);
            return ExitCode::FAILURE;
        }
    };
    let vb: i64 = match args[2].parse() {
        Ok(id) => id,
        Err(_) => {
            eprintln!("Invalid version ID: {}", args[2]);
            return ExitCode::FAILURE;
        }
    };

    let db = match Database::open(&db_path()) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let diff = match db.diff_versions(va, vb) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Diff error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    println!("Diff: {} → {}", diff.version_a, diff.version_b);
    println!("  Added:     {}", diff.added.len());
    for name in &diff.added {
        println!("    + {}", name);
    }
    println!("  Removed:   {}", diff.removed.len());
    for name in &diff.removed {
        println!("    - {}", name);
    }
    println!("  Changed:   {}", diff.changed.len());
    for name in &diff.changed {
        println!("    ~ {}", name);
    }
    println!("  Unchanged: {}", diff.unchanged);

    ExitCode::SUCCESS
}

// ── Shared helpers ──

fn build_registry() -> Option<ScraperRegistry> {
    let dev_id = std::env::var("SS_DEVID").ok();
    let dev_password = std::env::var("SS_DEVPASSWORD").ok();
    match (dev_id, dev_password) {
        (Some(id), Some(pwd)) => {
            let mut config = Config::default().with_screenscraper(&id, &pwd);
            if let Ok(u) = std::env::var("SS_USERNAME") {
                if let Ok(p) = std::env::var("SS_PASSWORD") {
                    config = Config::default().with_screenscraper_auth(&id, &pwd, &u, &p);
                }
            }
            Some(ScraperRegistry::new(&config))
        }
        _ => {
            tracing::warn!("SS_DEVID / SS_DEVPASSWORD not set — network scraping disabled");
            let config = Config::default();
            Some(ScraperRegistry::new(&config))
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
