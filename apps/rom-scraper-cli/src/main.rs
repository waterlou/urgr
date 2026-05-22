use std::path::PathBuf;
use std::process::ExitCode;

use rom_manager::dat::{detect_format, parse_dat};
use rom_manager::scanner::scan_directory;
use rom_manager::verifier::{verify_version, GameStatus};
use rom_manager::Database;
use rom_scraper::{compute_hashes, parse_filename, Config, ScraperRegistry};
use serde::Serialize;

// ── JSON output types ──

#[derive(Serialize)]
struct HashOutput {
    crc32: String,
    md5: String,
    sha1: String,
    size: u64,
    filename: Option<String>,
    parsed_title: Option<String>,
    parsed_region: Option<String>,
}

#[derive(Serialize)]
struct SearchResult {
    id: String,
    title: String,
    platform: String,
    release_date: Option<String>,
}

#[derive(Serialize)]
struct ScrapeOutput {
    hashes: HashOutput,
    matched: Option<ScrapeMatch>,
    filename_fallback: Option<SearchResult>,
}

#[derive(Serialize)]
struct ScrapeMatch {
    title: String,
    platform: String,
    description: String,
    publisher: Option<String>,
    covers: usize,
    screenshots: usize,
}

#[derive(Serialize)]
struct DetailOutput {
    id: String,
    title: String,
    platform: String,
    platform_short: String,
    synopsis: String,
    publisher: Option<String>,
    developer: Option<String>,
    release_date: Option<String>,
    players: Option<u8>,
    genres: Vec<String>,
    covers: Vec<String>,
    screenshots: Vec<String>,
    roms: Vec<RomEntry>,
}

#[derive(Serialize)]
struct RomEntry {
    filename: Option<String>,
    crc: Option<String>,
}

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

#[derive(Serialize)]
struct DatInfoOutput {
    id: i64,
    source: String,
    version: String,
    directory: Option<String>,
    total_games: i64,
    total_roms: i64,
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

fn db_path(args: &[String]) -> String {
    if let Some(pos) = args.iter().position(|a| a == "--db") {
        if let Some(path) = args.get(pos + 1) {
            return path.clone();
        }
    }
    std::env::var("ROM_DB").unwrap_or_else(|_| "roms.db".to_string())
}

fn has_json(args: &[String]) -> bool {
    args.iter().any(|a| a == "--json")
}

fn strip_global_flags(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "--json" {
            continue;
        }
        if a == "--db" {
            skip_next = true;
            continue;
        }
        out.push(a.clone());
    }
    out
}

fn print_json<T: Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn print_usage() {
    eprintln!("Usage: rom-scraper-cli <command> [options] [--json] [--db <path>]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  hash <file>            Compute ROM hashes");
    eprintln!("  search <query>         Search games by name");
    eprintln!("  scrape <file>          Match a ROM file via hash");
    eprintln!("  detail <game-id>       Get full game details");
    eprintln!("  dat import <file> <source> <version> [--dir <path>]");
    eprintln!("  dat list               List imported versions");
    eprintln!("  dat info <version-id>  Show version details");
    eprintln!("  scan <version-id> <dir>");
    eprintln!("  verify <version-id> <dir> [--fallback <id>]");
    eprintln!("  diff <version-id-a> <version-id-b>");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  --json                 Output in JSON format");
    eprintln!("  --db <path>            Database path (default: roms.db or $ROM_DB)");
    eprintln!();
    eprintln!("Environment:");
    eprintln!("  ROM_DB              SQLite database path (default: roms.db)");
    eprintln!("  SS_DEVID            ScreenScraper dev ID");
    eprintln!("  SS_DEVPASSWORD      ScreenScraper dev password");
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
        print_usage();
        return ExitCode::FAILURE;
    }

    let json = has_json(&args);
    let clean = strip_global_flags(&args);

    // clean[0] = binary name, clean[1] = command
    if clean.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    let exit = match clean[1].as_str() {
        "hash" => cmd_hash(&clean[1..], json).await,
        "search" => cmd_search(&clean[1..], json).await,
        "scrape" => cmd_scrape(&clean[1..], json).await,
        "detail" => cmd_detail(&clean[1..], json).await,
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

// ── Commands ──

async fn cmd_hash(args: &[String], json: bool) -> ExitCode {
    // args[0] = "hash", args[1] = file
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
            let filename = path.file_name().map(|n| n.to_string_lossy().to_string());
            let (parsed_title, parsed_region) = filename.as_deref()
                .and_then(|n| parse_filename(n))
                .map(|p| (Some(p.title), p.region))
                .unwrap_or((None, None));

            if json {
                print_json(&HashOutput {
                    crc32: hashes.crc32,
                    md5: hashes.md5,
                    sha1: hashes.sha1,
                    size: hashes.size,
                    filename,
                    parsed_title,
                    parsed_region,
                });
            } else {
                if let Some(title) = &parsed_title {
                    println!("Title:    {}", title);
                }
                if let Some(region) = &parsed_region {
                    println!("Region:   {}", region);
                }
                println!("CRC32:    {}", hashes.crc32);
                println!("MD5:      {}", hashes.md5);
                println!("SHA1:     {}", hashes.sha1);
                println!("Size:     {} bytes", hashes.size);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Hash error: {}", e);
            ExitCode::FAILURE
        }
    }
}

async fn cmd_search(args: &[String], json: bool) -> ExitCode {
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
                if json {
                    let results: Vec<SearchResult> = games.iter().map(|g| SearchResult {
                        id: g.id.clone(),
                        title: g.title.clone(),
                        platform: g.platform.short_name.clone(),
                        release_date: g.release_date.clone(),
                    }).collect();
                    print_json(&serde_json::json!({"results": results}));
                } else {
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

async fn cmd_scrape(args: &[String], json: bool) -> ExitCode {
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

            let hash_out = HashOutput {
                crc32: hashes.crc32.clone(),
                md5: hashes.md5.clone(),
                sha1: hashes.sha1.clone(),
                size: hashes.size,
                filename: path.file_name().map(|n| n.to_string_lossy().to_string()),
                parsed_title: None,
                parsed_region: None,
            };

            match reg.search_by_hashes(&hashes, None).await {
                Ok(Some(game)) => {
                    if json {
                        print_json(&ScrapeOutput {
                            hashes: hash_out,
                            matched: Some(ScrapeMatch {
                                title: game.title,
                                platform: game.platform.name,
                                description: game.description,
                                publisher: game.publisher,
                                covers: game.media.covers.len(),
                                screenshots: game.media.screenshots.len(),
                            }),
                            filename_fallback: None,
                        });
                    } else {
                        println!("Hashes:");
                        println!("  CRC32: {}", hashes.crc32);
                        println!("  MD5:   {}", hashes.md5);
                        println!("  SHA1:  {}", hashes.sha1);
                        println!();
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
                    }
                    ExitCode::SUCCESS
                }
                Ok(None) => {
                    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    let fallback = parse_filename(filename).and_then(|parsed| {
                        Some((parsed.title.clone(), parsed.title))
                    });

                    if json {
                        let (title, _) = fallback.unwrap_or_default();
                        let fb_result = if !title.is_empty() {
                            let reg2 = build_registry();
                            if let Some(reg2) = reg2 {
                                if let Ok(games) = reg2.search_by_name(&title, None).await {
                                    games.first().map(|g| SearchResult {
                                        id: g.id.clone(),
                                        title: g.title.clone(),
                                        platform: g.platform.short_name.clone(),
                                        release_date: g.release_date.clone(),
                                    })
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        print_json(&ScrapeOutput {
                            hashes: hash_out,
                            matched: None,
                            filename_fallback: fb_result,
                        });
                    } else {
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

async fn cmd_detail(args: &[String], json: bool) -> ExitCode {
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
                    if json {
                        print_json(&DetailOutput {
                            id: game.id.clone(),
                            title: game.title.clone(),
                            platform: game.platform.name.clone(),
                            platform_short: game.platform.short_name.clone(),
                            synopsis: truncate(&game.description, 500),
                            publisher: game.publisher.clone(),
                            developer: game.developer.clone(),
                            release_date: game.release_date.clone(),
                            players: game.players,
                            genres: game.genres.clone(),
                            covers: game.media.covers.iter().map(|c| c.url.clone()).collect(),
                            screenshots: game.media.screenshots.iter().map(|s| s.url.clone()).collect(),
                            roms: game.roms.iter().map(|r| RomEntry {
                                filename: r.filename.clone(),
                                crc: r.crc32.clone(),
                            }).collect(),
                        });
                    } else {
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

fn cmd_dat(args: &[String], json: bool) -> ExitCode {
    // args[0] = "dat", args[1] = subcommand
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli dat <import|list|info> ...");
        return ExitCode::FAILURE;
    }
    match args[1].as_str() {
        "import" => cmd_dat_import(&args[1..], json),
        "list" => cmd_dat_list(&args[1..], json),
        "info" => cmd_dat_info(&args[1..], json),
        _ => {
            eprintln!("Unknown dat subcommand: {}", args[1]);
            eprintln!("Usage: rom-scraper-cli dat <import|list|info> ...");
            ExitCode::FAILURE
        }
    }
}

fn cmd_dat_import(args: &[String], json: bool) -> ExitCode {
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

    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
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

    let (games, roms, stats) = match parse_dat(file) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Parse error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let warnings = stats.errors.clone();

    if !json {
        println!("Detected format: {:?}", fmt);
        println!("Parsed {} games ({} ROMs)", stats.total_games, stats.total_roms);
        if !stats.errors.is_empty() {
            for err in &stats.errors {
                eprintln!("  Warning: {}", err);
            }
        }
    }

    let version_id = match db.import_version(source, version, dir.map(|s| s.as_str())) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("Failed to import version: {}", e);
            return ExitCode::FAILURE;
        }
    };

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
        println!("Inserted {} game entries", games_inserted);
        println!("Inserted {} ROM entries", rom_count);
        println!("Version ID: {}", version_id);
    }

    ExitCode::SUCCESS
}

fn cmd_dat_list(args: &[String], json: bool) -> ExitCode {
    let _ = args;
    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
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

    if json {
        let entries: Vec<VersionEntry> = versions.iter().map(|v| VersionEntry {
            id: v.id,
            source: v.source.clone(),
            version: v.version.clone(),
            directory: v.dir.clone(),
            total_games: v.total_games,
            total_roms: v.total_roms,
        }).collect();
        print_json(&serde_json::json!({"versions": entries}));
        return ExitCode::SUCCESS;
    }

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

fn cmd_dat_info(args: &[String], json: bool) -> ExitCode {
    // args[0] = "info", args[1] = version-id
    if args.len() < 2 {
        eprintln!("Usage: rom-scraper-cli dat info <version-id>");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => {
            eprintln!("Invalid version ID: {}", args[1]);
            return ExitCode::FAILURE;
        }
    };

    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let version = match db.get_version(version_id) {
        Ok(Some(v)) => v,
        Ok(None) => {
            eprintln!("Version {} not found", version_id);
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let games = match db.list_games(version_id) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("Error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    if json {
        let info = DatInfoOutput {
            id: version.id,
            source: version.source,
            version: version.version,
            directory: version.dir,
            total_games: version.total_games,
            total_roms: version.total_roms,
        };
        let game_names: Vec<String> = games.iter().map(|g| g.name.clone()).collect();
        print_json(&serde_json::json!({
            "version": info,
            "games": game_names
        }));
    } else {
        println!("ID:        {}", version.id);
        println!("Source:    {}", version.source);
        println!("Version:   {}", version.version);
        if let Some(dir) = &version.dir {
            println!("Directory: {}", dir);
        }
        println!("Games:     {} ({} ROMs)", version.total_games, version.total_roms);
        println!();
        println!("Games:");
        for game in &games {
            println!("  [{}] {}", game.id, game.name);
        }
    }

    ExitCode::SUCCESS
}

fn cmd_scan(args: &[String], json: bool) -> ExitCode {
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

    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("Database error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    if !json {
        println!("Scanning {} for version {}...", dir.display(), version_id);
    }
    let result = match scan_directory(&db, version_id, dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Scan error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    if json {
        print_json(&ScanOutput {
            total_files: result.total_files,
            matched_games: result.matched_games,
            missing_games: result.missing_games,
        });
    } else {
        println!("Scan complete:");
        println!("  Total files:     {}", result.total_files);
        println!("  Matched games:   {}", result.matched_games);
        println!("  Missing games:   {}", result.missing_games);
    }

    ExitCode::SUCCESS
}

fn cmd_verify(args: &[String], json: bool) -> ExitCode {
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

    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
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

    if !json {
        println!("Verifying version {} in {}...", version_id, dir.display());
    }
    let result = match verify_version(&db, version_id, dir, &fallback_dirs) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Verify error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    if json {
        let details: Vec<VerifyDetail> = result.details.iter().map(|d| {
            let (status, name, detail) = match d {
                GameStatus::Present { name, .. } => ("present".into(), name.clone(), None),
                GameStatus::Missing { name } => ("missing".into(), name.clone(), None),
                GameStatus::Inherited { name, from_version, .. } => {
                    ("inherited".into(), name.clone(), Some(format!("from v{}", from_version)))
                }
                GameStatus::Mismatch { name, detail, .. } => {
                    ("mismatch".into(), name.clone(), Some(detail.clone()))
                }
            };
            VerifyDetail { status, name, detail }
        }).collect();

        print_json(&VerifyOutput {
            total_games: result.total_games,
            present: result.present,
            missing: result.missing,
            inherited: result.inherited,
            mismatched: result.mismatched,
            details,
        });
    } else {
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
                    GameStatus::Present { name, .. } => {
                        println!("  ✓ {}", name);
                    }
                    GameStatus::Missing { name } => {
                        println!("  ✗ {} (missing)", name);
                    }
                    GameStatus::Inherited { name, from_version, .. } => {
                        println!("  ← {} (from v{})", name, from_version);
                    }
                    GameStatus::Mismatch { name, detail, .. } => {
                        println!("  ⚠ {} ({})", name, detail);
                    }
                }
            }
        }
    }

    ExitCode::SUCCESS
}

fn cmd_diff(args: &[String], json: bool) -> ExitCode {
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

    let db_path = db_path(args);
    let db = match Database::open(&db_path) {
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

    if json {
        print_json(&DiffOutput {
            version_a: diff.version_a,
            version_b: diff.version_b,
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
            unchanged: diff.unchanged,
        });
    } else {
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
    }

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
