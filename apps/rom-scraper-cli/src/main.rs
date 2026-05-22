use std::path::PathBuf;
use std::process::ExitCode;

use rom_scraper::{compute_hashes, parse_filename, Config, ScraperRegistry};

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
        eprintln!("  hash <file>          Compute ROM hashes");
        eprintln!("  search <query>       Search games by name");
        eprintln!("  scrape <file>        Match a ROM file via hash");
        eprintln!("  detail <game-id>     Get full game details");
        eprintln!();
        eprintln!("Environment:");
        eprintln!("  SS_DEVID          ScreenScraper dev ID (required for search/scrape/detail)");
        eprintln!("  SS_DEVPASSWORD    ScreenScraper dev password");
        eprintln!("  SS_USERNAME       Optional ScreenScraper account username");
        eprintln!("  SS_PASSWORD       Optional ScreenScraper account password");
        return ExitCode::FAILURE;
    }

    match args[1].as_str() {
        "hash" => cmd_hash(&args[1..]).await,
        "search" => cmd_search(&args[1..]).await,
        "scrape" => cmd_scrape(&args[1..]).await,
        "detail" => cmd_detail(&args[1..]).await,
        _ => {
            eprintln!("Unknown command: {}", args[1]);
            ExitCode::FAILURE
        }
    }
}

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
        Some(reg) => {
            match reg.search_by_name(query, platform.map(|s| s.as_str())).await {
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
            }
        }
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
                    // Fall back to filename
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
            // Hash-only mode (no network needed)
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
