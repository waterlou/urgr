use std::path::PathBuf;
use std::process::ExitCode;

use rom_scraper::{compute_hashes, parse_filename, Config, HttpClient, ScraperRegistry};
use serde::Serialize;

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
struct ScrapeOutput {
    hashes: HashOutput,
    matched: Option<ScrapeMatch>,
}

#[derive(Serialize)]
struct SearchResult {
    id: String,
    title: String,
    platform: String,
    release_date: Option<String>,
}

#[derive(Serialize)]
struct ScrapeMatch {
    id: String,
    title: String,
    platform: String,
    platform_short: String,
    description: String,
    publisher: Option<String>,
    developer: Option<String>,
    release_date: Option<String>,
    players: Option<u8>,
    genres: Vec<String>,
    rating: Option<f32>,
    covers: Vec<String>,
    screenshots: Vec<String>,
    roms: Vec<RomEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<Vec<String>>,
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

fn normalize_url(u: &str) -> String {
    if u.starts_with("//") {
        format!("https:{}", u)
    } else {
        u.to_string()
    }
}

fn print_json<T: Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn game_to_match(game: &rom_scraper::Game) -> ScrapeMatch {
    ScrapeMatch {
        id: game.id.clone(),
        title: game.title.clone(),
        platform: game.platform.name.clone(),
        platform_short: game.platform.short_name.clone(),
        description: game.description.clone(),
        publisher: game.publisher.clone(),
        developer: game.developer.clone(),
        release_date: game.release_date.clone(),
        players: game.players,
        genres: game.genres.clone(),
        rating: game.rating,
        covers: game.media.covers.iter().map(|m| m.url.clone()).collect(),
        screenshots: game.media.screenshots.iter().map(|m| m.url.clone()).collect(),
        roms: game.roms.iter().map(|r| RomEntry {
            filename: r.filename.clone(),
            crc: r.crc32.clone(),
        }).collect(),
        downloaded: None,
    }
}

async fn enrich_game(registry: &ScraperRegistry, game: rom_scraper::Game) -> rom_scraper::Game {
    match registry.get_game_detail(&game.id, &game.source).await {
        Ok(Some(detail)) => detail,
        _ => game,
    }
}

fn slugify(s: &str) -> String {
    s.to_lowercase().chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(64)
        .collect()
}

async fn download_media(urls: &[String], platform: &str, release_date: &Option<String>, title: &str, client: &HttpClient) -> Vec<String> {
    let platform_slug = if platform.is_empty() { "unknown" } else { platform };
    let year = release_date.as_ref().and_then(|d| d.get(..4)).unwrap_or("0000");
    let dir_name = format!("{}-{}-{}", slugify(platform_slug), year, slugify(title));
    let base = std::path::Path::new("data").join("media").join(&dir_name);
    std::fs::create_dir_all(&base).ok();
    let mut local_paths = Vec::new();
    for url in urls {
        let normalized = normalize_url(url);
        let filename = normalized.rsplit('/').next().unwrap_or("unknown");
        let dest = base.join(filename);
        if dest.exists() {
            local_paths.push(dest.to_string_lossy().to_string());
            continue;
        }
        match client.get_bytes(&normalized).await {
            Ok(bytes) => {
                std::fs::write(&dest, &bytes).ok();
                local_paths.push(dest.to_string_lossy().to_string());
            }
            Err(e) => eprintln!("Download failed for {}: {}", normalized, e),
        }
    }
    local_paths
}

fn print_usage() {
    eprintln!("scraper-cli  —  Scrape retro game metadata from multiple providers");
    eprintln!();
    eprintln!("USAGE:");
    eprintln!("  scraper-cli <command> [options]");
    eprintln!();
    eprintln!("COMMANDS:");
    eprintln!("  hash <file>                    Compute ROM hashes (CRC32, MD5, SHA1)");
    eprintln!("  search <query> [--source <s>]  Search games by name");
    eprintln!("  scrape <file> [--download] [--source <s>]   Match a ROM file and optionally download media");
    eprintln!("  detail <game-id> [--source <s>] Get full game details by ID");
    eprintln!();
    eprintln!("OPTIONS:");
    eprintln!("  --source <s>       Provider: thegamesdb (default), screenscraper, igdb");
    eprintln!("                     (default: thegamesdb, or SCRAPER_SOURCE env var)");
    eprintln!("  --platform <p>     Platform filter (e.g., nes, snes, arcade)");
    eprintln!("  --download         Download cover/screenshot media to data/media/<game-id>/");
    eprintln!();
    eprintln!("ENVIRONMENT:");
    eprintln!("  All providers need credentials. May be set in .env or as env vars.");
    eprintln!();
    eprintln!("  SCRAPER_SOURCE     Default provider (screenscraper, igdb, thegamesdb)");
    eprintln!();
    eprintln!("  ScreenScraper:");
    eprintln!("    SS_DEVID          Dev ID (required)");
    eprintln!("    SS_DEVPASSWORD    Dev password (required)");
    eprintln!("    SS_USERNAME       Optional username for more requests");
    eprintln!("    SS_PASSWORD       Optional password");
    eprintln!();
    eprintln!("  IGDB (Twitch API):");
    eprintln!("    IGDB_CLIENT_ID       Twitch Client ID (required)");
    eprintln!("    IGDB_CLIENT_SECRET   Twitch Client Secret (required)");
    eprintln!();
    eprintln!("  TheGamesDB:");
    eprintln!("    TGDB_API_KEY         API key from thegamesdb.net (optional - built-in key active by default)");
    eprintln!();
    eprintln!("EXAMPLES:");
    eprintln!("  scraper-cli search \"Super Mario\"");
    eprintln!("  scraper-cli search \"Street Fighter\" --source igdb --platform arcade");
    eprintln!("  scraper-cli search \"Zelda\" --source thegamesdb");
    eprintln!("  scraper-cli scrape ~/roms/smb.zip");
    eprintln!("  scraper-cli detail 12345 --source igdb");
}

#[tokio::main]
async fn main() -> ExitCode {
    dotenvy::dotenv().ok();
    let _ = dotenvy::from_path("data/.env");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    let exit = match args[1].as_str() {
        "hash" => cmd_hash(&args[1..]).await,
        "search" => cmd_search(&args[1..]).await,
        "scrape" => cmd_scrape(&args[1..]).await,
        "detail" => cmd_detail(&args[1..]).await,
        _ => {
            eprintln!("Unknown command: {}", args[1]);
            print_usage();
            ExitCode::FAILURE
        }
    };

    if exit != ExitCode::SUCCESS {
        let err = serde_json::json!({"error": "command failed"});
        println!("{}", serde_json::to_string_pretty(&err).unwrap());
    }

    exit
}

async fn cmd_hash(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: scraper-cli hash <file>");
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

            print_json(&HashOutput {
                crc32: hashes.crc32,
                md5: hashes.md5,
                sha1: hashes.sha1,
                size: hashes.size,
                filename,
                parsed_title,
                parsed_region,
            });
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
        eprintln!("Usage: scraper-cli search <query> [--source <s>] [--platform <p>]");
        return ExitCode::FAILURE;
    }
    let query = &args[1];
    let platform = args.iter().position(|a| a == "--platform")
        .and_then(|p| args.get(p + 1));
    let source = parse_source(args);

    let config = build_config();
    let registry = ScraperRegistry::new(&config);

    let platform_str = platform.map(|s| s.as_str());

    let result = match source {
        Some(src) => registry.search_by_name_from_source(query, &src, platform_str).await,
        None => registry.search_by_name(query, platform_str).await,
    };

    match result {
        Ok(games) => {
            let results: Vec<SearchResult> = games.iter().map(|g| SearchResult {
                id: g.id.clone(),
                title: g.title.clone(),
                platform: g.platform.name.clone(),
                release_date: g.release_date.clone(),
            }).collect();
            print_json(&serde_json::json!({"results": results}));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Search error: {}", e);
            ExitCode::FAILURE
        }
    }
}

async fn cmd_scrape(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: scraper-cli scrape <file> [--download] [--source <s>]");
        return ExitCode::FAILURE;
    }
    let path = PathBuf::from(&args[1]);
    if !path.exists() {
        eprintln!("File not found: {}", path.display());
        return ExitCode::FAILURE;
    }
    let download = args.iter().any(|a| a == "--download");
    let source = parse_source(args);
    let config = build_config();
    let registry = ScraperRegistry::new(&config);

    let hashes = match compute_hashes(&path) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("Hash error: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let filename = path.file_name().map(|n| n.to_string_lossy().to_string());
    let (parsed_title, parsed_region) = filename.as_deref()
        .and_then(|n| parse_filename(n))
        .map(|p| (Some(p.title), p.region))
        .unwrap_or((None, None));

    let hash_out = HashOutput {
        crc32: hashes.crc32.clone(),
        md5: hashes.md5.clone(),
        sha1: hashes.sha1.clone(),
        size: hashes.size,
        filename: filename.clone(),
        parsed_title: parsed_title.clone(),
        parsed_region,
    };

    let mut matched = None;

    match source {
        Some(ref src) => {
            if let Ok(Some(game)) = registry.search_by_hashes_from_source(&hashes, src, None).await {
                matched = Some(game_to_match(&enrich_game(&registry, game).await));
            }
            if matched.is_none() {
                if let Some(ref title) = parsed_title {
                    if let Ok(games) = registry.search_by_name_from_source(title, src, None).await {
                        if let Some(game) = games.into_iter().next() {
                            matched = Some(game_to_match(&enrich_game(&registry, game).await));
                        }
                    }
                }
            }
        }
        None => {
            if let Ok(Some(game)) = registry.search_by_hashes(&hashes, None).await {
                matched = Some(game_to_match(&enrich_game(&registry, game).await));
            }
            if matched.is_none() {
                if let Some(ref title) = parsed_title {
                    if let Ok(games) = registry.search_by_name(title, None).await {
                        if let Some(game) = games.into_iter().next() {
                            matched = Some(game_to_match(&enrich_game(&registry, game).await));
                        }
                    }
                }
            }
        }
    }

    if download {
        if let Some(ref mut m) = matched {
            let client = HttpClient::new();
            let mut all = Vec::new();
            all.extend(download_media(&m.covers, &m.platform, &m.release_date, &m.title, &client).await);
            all.extend(download_media(&m.screenshots, &m.platform, &m.release_date, &m.title, &client).await);
            if !all.is_empty() {
                m.downloaded = Some(all);
            }
        }
    }

    print_json(&ScrapeOutput { hashes: hash_out, matched });
    ExitCode::SUCCESS
}

async fn cmd_detail(args: &[String]) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: scraper-cli detail <game-id> [--source <s>]");
        return ExitCode::FAILURE;
    }
    let game_id = &args[1];
    let source = parse_source(args).unwrap_or(rom_scraper::ScrapeSource::TheGamesDb);

    let config = build_config();
    let registry = ScraperRegistry::new(&config);

    match registry.get_game_detail(game_id, &source).await {
        Ok(Some(game)) => {
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

fn build_config() -> Config {
    let mut config = Config::default();

    let ss_dev_id = std::env::var("SS_DEVID").ok();
    let ss_dev_pwd = std::env::var("SS_DEVPASSWORD").ok();
    if let (Some(id), Some(pwd)) = (&ss_dev_id, &ss_dev_pwd) {
        let u = std::env::var("SS_USERNAME").ok();
        let p = std::env::var("SS_PASSWORD").ok();
        if let (Some(u), Some(p)) = (&u, &p) {
            config = config.with_screenscraper_auth(id, pwd, u, p);
        } else {
            config = config.with_screenscraper(id, pwd);
        }
    }

    if let (Some(id), Some(secret)) = (std::env::var("IGDB_CLIENT_ID").ok().as_ref(), std::env::var("IGDB_CLIENT_SECRET").ok().as_ref()) {
        config = config.with_igdb(id, secret);
    }

    if let Ok(key) = std::env::var("TGDB_API_KEY") {
        if !key.is_empty() {
            config = config.with_thegamesdb(&key);
        }
    }

    config
}

fn parse_source(args: &[String]) -> Option<rom_scraper::ScrapeSource> {
    if let Some(pos) = args.iter().position(|a| a == "--source") {
        let val = args.get(pos + 1)?;
        return match val.as_str() {
            "screenscraper" => Some(rom_scraper::ScrapeSource::ScreenScraper),
            "igdb" => Some(rom_scraper::ScrapeSource::Igdb),
            "thegamesdb" => Some(rom_scraper::ScrapeSource::TheGamesDb),
            "no-intro-pictures" => Some(rom_scraper::ScrapeSource::NoIntroPictures),
            "sony-store" => Some(rom_scraper::ScrapeSource::SonyStore),
            "vgmuseum" => Some(rom_scraper::ScrapeSource::Vgmuseum),
            _ => {
                eprintln!("Unknown source '{}'. Valid: screenscraper, igdb, thegamesdb, no-intro-pictures, sony-store, vgmuseum", val);
                None
            }
        };
    }
    let from_env = std::env::var("SCRAPER_SOURCE").ok();
    if let Some(val) = from_env.as_deref() {
        return match val {
            "screenscraper" => Some(rom_scraper::ScrapeSource::ScreenScraper),
            "igdb" => Some(rom_scraper::ScrapeSource::Igdb),
            "thegamesdb" => Some(rom_scraper::ScrapeSource::TheGamesDb),
            "no-intro-pictures" => Some(rom_scraper::ScrapeSource::NoIntroPictures),
            "sony-store" => Some(rom_scraper::ScrapeSource::SonyStore),
            "vgmuseum" => Some(rom_scraper::ScrapeSource::Vgmuseum),
            _ => None,
        };
    }
    Some(rom_scraper::ScrapeSource::TheGamesDb)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let end = s.floor_char_boundary(max);
        format!("{}...", &s[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rom_scraper::{Game, Platform, Media, MediaItem, MediaType, RomInfo, ScrapeSource};

    fn make_game(id: &str, title: &str, platform_name: &str, platform_short: &str) -> Game {
        Game {
            id: id.to_string(),
            title: title.to_string(),
            alternative_titles: Vec::new(),
            platform: Platform {
                id: String::new(),
                name: platform_name.to_string(),
                short_name: platform_short.to_string(),
            },
            description: String::new(),
            publisher: None,
            developer: None,
            release_date: None,
            genres: Vec::new(),
            players: None,
            rating: None,
            roms: Vec::new(),
            media: Media::default(),
            source: ScrapeSource::TheGamesDb,
        }
    }

    // ---- slugify ----

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("hello world"), "hello_world");
    }

    #[test]
    fn test_slugify_uppercase() {
        assert_eq!(slugify("Super Mario World"), "super_mario_world");
    }

    #[test]
    fn test_slugify_special_chars() {
        assert_eq!(slugify("Donkey Kong 64!"), "donkey_kong_64");
    }

    #[test]
    fn test_slugify_already_slug() {
        assert_eq!(slugify("the-legend-of-zelda"), "the-legend-of-zelda");
    }

    #[test]
    fn test_slugify_truncates() {
        let long = "a".repeat(100);
        assert!(slugify(&long).len() <= 64);
    }

    #[test]
    fn test_slugify_leading_trailing_underscores() {
        assert_eq!(slugify("___hello___"), "hello");
    }

    // ---- normalize_url ----

    #[test]
    fn test_normalize_url_https() {
        assert_eq!(normalize_url("https://example.com/img.jpg"), "https://example.com/img.jpg");
    }

    #[test]
    fn test_normalize_url_protocol_relative() {
        assert_eq!(normalize_url("//images.igdb.com/img.jpg"), "https://images.igdb.com/img.jpg");
    }

    #[test]
    fn test_normalize_url_http() {
        assert_eq!(normalize_url("http://cdn.example.com/img.jpg"), "http://cdn.example.com/img.jpg");
    }

    // ---- truncate ----

    #[test]
    fn test_truncate_short() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_exact() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_long() {
        assert_eq!(truncate("hello world", 5), "hello...");
    }

    #[test]
    fn test_truncate_empty() {
        assert_eq!(truncate("", 5), "");
    }

    #[test]
    fn test_truncate_zero_max() {
        assert_eq!(truncate("abc", 0), "...");
    }

    // ---- parse_source ----

    #[test]
    fn test_parse_source_flag_thegamesdb() {
        let args = vec!["scrape".to_string(), "rom.zip".to_string(), "--source".to_string(), "thegamesdb".to_string()];
        assert_eq!(parse_source(&args), Some(ScrapeSource::TheGamesDb));
    }

    #[test]
    fn test_parse_source_flag_igdb() {
        let args = vec!["search".to_string(), "game".to_string(), "--source".to_string(), "igdb".to_string()];
        assert_eq!(parse_source(&args), Some(ScrapeSource::Igdb));
    }

    #[test]
    fn test_parse_source_flag_screenscraper() {
        let args = vec!["detail".to_string(), "123".to_string(), "--source".to_string(), "screenscraper".to_string()];
        assert_eq!(parse_source(&args), Some(ScrapeSource::ScreenScraper));
    }

    #[test]
    fn test_parse_source_flag_unknown() {
        let args = vec!["scrape".to_string(), "rom.zip".to_string(), "--source".to_string(), "invalid".to_string()];
        assert_eq!(parse_source(&args), None);
    }

    #[test]
    fn test_parse_source_no_flag_defaults_to_thegamesdb() {
        let args = vec!["search".to_string(), "game".to_string()];
        assert_eq!(parse_source(&args), Some(ScrapeSource::TheGamesDb));
    }

    #[test]
    fn test_parse_source_flag_without_value_returns_none() {
        let args = vec!["scrape".to_string(), "rom.zip".to_string(), "--source".to_string()];
        assert_eq!(parse_source(&args), None);
    }

    #[test]
    fn test_parse_source_env_igdb() {
        let args = vec!["search".to_string(), "game".to_string()];
        std::env::set_var("SCRAPER_SOURCE", "igdb");
        assert_eq!(parse_source(&args), Some(ScrapeSource::Igdb));
        std::env::remove_var("SCRAPER_SOURCE");
    }

    #[test]
    fn test_parse_source_flag_overrides_env() {
        let args = vec!["search".to_string(), "game".to_string(), "--source".to_string(), "screenscraper".to_string()];
        std::env::set_var("SCRAPER_SOURCE", "igdb");
        assert_eq!(parse_source(&args), Some(ScrapeSource::ScreenScraper));
        std::env::remove_var("SCRAPER_SOURCE");
    }

    // ---- game_to_match ----

    #[test]
    fn test_game_to_match_basic() {
        let game = make_game("123", "Test Game", "Nintendo Switch", "NSW");
        let m = game_to_match(&game);
        assert_eq!(m.id, "123");
        assert_eq!(m.title, "Test Game");
        assert_eq!(m.platform, "Nintendo Switch");
        assert_eq!(m.platform_short, "NSW");
    }

    #[test]
    fn test_game_to_match_covers_and_screenshots() {
        let mut game = make_game("456", "Game", "Arcade", "");
        game.media.covers.push(MediaItem { url: "https://example.com/cover.jpg".into(), kind: MediaType::Cover2D });
        game.media.screenshots.push(MediaItem { url: "//example.com/shot.jpg".into(), kind: MediaType::Screenshot });
        let m = game_to_match(&game);
        assert_eq!(m.covers, vec!["https://example.com/cover.jpg"]);
        assert_eq!(m.screenshots, vec!["//example.com/shot.jpg"]);
    }

    #[test]
    fn test_game_to_match_roms() {
        let mut game = make_game("789", "Game", "PC", "");
        game.roms.push(RomInfo {
            filename: Some("rom.zip".into()),
            size: Some(1024),
            crc32: Some("AABBCCDD".into()),
            md5: None,
            sha1: None,
            region: None,
            version: None,
        });
        let m = game_to_match(&game);
        assert_eq!(m.roms.len(), 1);
        assert_eq!(m.roms[0].filename, Some("rom.zip".into()));
        assert_eq!(m.roms[0].crc, Some("AABBCCDD".into()));
    }

    #[test]
    fn test_game_to_match_downloaded_none() {
        let game = make_game("0", "No Download", "NES", "");
        let m = game_to_match(&game);
        assert!(m.downloaded.is_none());
    }

    #[test]
    fn test_game_to_match_metadata() {
        let mut game = make_game("1", "Metroid", "SNES", "snes");
        game.description = "A classic game.".to_string();
        game.publisher = Some("Nintendo".into());
        game.developer = Some("Nintendo R&D1".into());
        game.release_date = Some("1994-03-19".into());
        game.genres = vec!["Action".into(), "Adventure".into()];
        game.players = Some(1);
        game.rating = Some(85.5);
        let m = game_to_match(&game);
        assert_eq!(m.description, "A classic game.");
        assert_eq!(m.publisher, Some("Nintendo".into()));
        assert_eq!(m.developer, Some("Nintendo R&D1".into()));
        assert_eq!(m.release_date, Some("1994-03-19".into()));
        assert_eq!(m.players, Some(1));
        assert_eq!(m.genres, vec!["Action", "Adventure"]);
        assert_eq!(m.rating, Some(85.5));
    }

    // ---- Composite ----

    #[test]
    fn test_scrapematch_serialization() {
        let game = make_game("1", "Test", "SNES", "snes");
        let m = game_to_match(&game);
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["id"], "1");
        assert_eq!(json["title"], "Test");
        assert_eq!(json["platform"], "SNES");
        assert_eq!(json["platform_short"], "snes");
        assert!(json.get("downloaded").is_none());
    }

    #[test]
    fn test_detailoutput_serialization() {
        let out = DetailOutput {
            id: "42".into(),
            title: "Zelda".into(),
            platform: "NES".into(),
            platform_short: "nes".into(),
            synopsis: "An adventure".into(),
            publisher: Some("Nintendo".into()),
            developer: None,
            release_date: None,
            players: None,
            genres: vec!["Adventure".into()],
            covers: vec![],
            screenshots: vec![],
            roms: vec![],
        };
        let json = serde_json::to_value(&out).unwrap();
        assert_eq!(json["id"], "42");
        assert_eq!(json["title"], "Zelda");
        assert_eq!(json["synopsis"], "An adventure");
        assert_eq!(json["publisher"], "Nintendo");
    }

    #[test]
    fn test_searchresult_serialization() {
        let r = SearchResult {
            id: "7".into(),
            title: "Mario".into(),
            platform: "SNES".into(),
            release_date: Some("1990-11-21".into()),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["id"], "7");
        assert_eq!(json["release_date"], "1990-11-21");
    }
}
