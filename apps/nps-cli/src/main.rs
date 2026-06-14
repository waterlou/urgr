use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};

use rom_manager::scanner::{scan_nps_directory, ScanMatch};
use rom_manager::{Database, NpsGame};
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
struct ScanOutput {
    total: usize,
    matched: usize,
    missing: usize,
    matches: Vec<ScanMatch>,
    missing_names: Vec<String>,
}

#[derive(Serialize)]
struct BuildOutput {
    built: usize,
    skipped: usize,
    total: usize,
}

#[derive(Serialize)]
struct ScrapeOutput {
    scraped: usize,
    failed: usize,
    total: usize,
}

#[derive(Serialize)]
struct ProgressMsg {
    pct: u32,
    msg: String,
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

fn has_progress() -> bool {
    std::env::args().any(|a| a == "--progress")
}

fn strip_global_flags(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args {
        if skip_next { skip_next = false; continue; }
        if a == "--json" || a == "--progress" { continue; }
        if a == "--db" { skip_next = true; continue; }
        out.push(a.clone());
    }
    out
}

fn print_json<T: Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn send_progress(pct: u32, msg: &str) {
    if has_progress() {
        eprintln!("{}", serde_json::to_string(&ProgressMsg { pct, msg: msg.to_string() }).unwrap());
    }
}

fn print_usage() {
    eprintln!("Usage: nps-cli <command> [options] [--json] [--progress] --db <path>");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  scan <version-id> <dir>              Scan directory for .pkg files");
    eprintln!("  build <version-id> <collection-dir> [--input-dir <dir>]");
    eprintln!("                                      Copy or download .pkg files into structured dirs");
    eprintln!("  scrape <version-id> [--game-id <id>] Fetch Sony Store screenshots");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  --json                 Output in JSON format");
    eprintln!("  --progress             Output progress as JSON lines to stderr");
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
        "scan" => cmd_scan(&clean[1..], json),
        "build" => cmd_build(&clean[1..], json),
        "scrape" => cmd_scrape(&clean[1..], json),
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
        eprintln!("Usage: nps-cli scan <version-id> <dir> [--game-id <id>]");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match clean_args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", clean_args[1]); return ExitCode::FAILURE; }
    };
    let dir = Path::new(&clean_args[2]);
    if !dir.exists() {
        eprintln!("Directory not found: {}", clean_args[2]);
        return ExitCode::FAILURE;
    }

    let db = match Database::open(&db_path()) {
        Ok(d) => d,
        Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };

    let games = match db.list_nps_games(version_id) {
        Ok(g) => g,
        Err(e) => { eprintln!("Failed to list games: {}", e); return ExitCode::FAILURE; }
    };

    let target_games: Vec<&NpsGame> = if let Some(gid) = game_id {
        games.iter().filter(|g| g.id == gid).collect()
    } else {
        games.iter().collect()
    };

    if target_games.is_empty() {
        eprintln!("No games found for version {} (game_id={:?})", version_id, game_id);
        return ExitCode::FAILURE;
    }

    let mut title_to_game: HashMap<String, String> = HashMap::new();
    for game in &target_games {
        if let Some(ref tid) = game.title_id {
            title_to_game.insert(tid.clone(), game.name.clone());
        }
        title_to_game.insert(game.name.clone(), game.name.clone());
    }

    let matches = match scan_nps_directory(&title_to_game, dir) {
        Ok(m) => m,
        Err(e) => { eprintln!("Scan error: {}", e); return ExitCode::FAILURE; }
    };

    let matched_names: HashSet<String> = matches.iter().map(|m| m.name.clone()).collect();
    let expected_names: HashSet<String> = target_games.iter().map(|g| g.name.clone()).collect();
    let missing: Vec<String> = expected_names.difference(&matched_names).cloned().collect();

    let result = ScanOutput { total: expected_names.len(), matched: matches.len(), missing: missing.len(), matches: matches.clone(), missing_names: missing.clone() };
    if json {
        print_json(&result);
    } else {
        println!("Scan complete: {} files, {} matched, {} missing", expected_names.len(), matches.len(), missing.len());
    }
    ExitCode::SUCCESS
}

fn cmd_build(args: &[String], json: bool) -> ExitCode {
    if args.len() < 3 {
        eprintln!("Usage: nps-cli build <version-id> <collection-dir> [--input-dir <dir>]");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let collection_dir = PathBuf::from(&args[2]);
    let input_dir = args.iter().position(|a| a == "--input-dir")
        .and_then(|p| args.get(p + 1))
        .map(PathBuf::from);

    let db = match Database::open(&db_path()) {
        Ok(d) => d,
        Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };

    install_signal_handlers();
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let games = match db.list_nps_games(version_id) {
        Ok(g) => g,
        Err(e) => { eprintln!("Failed to list games: {}", e); return ExitCode::FAILURE; }
    };

    // Build title_id -> game_name mapping for scanning
    let mut title_to_game: HashMap<String, String> = HashMap::new();
    for game in &games {
        if let Some(ref tid) = game.title_id {
            title_to_game.insert(tid.clone(), game.name.clone());
        }
    }

    // Scan input directory to find matching files (shared logic with cmd_scan)
    let matches: Vec<rom_manager::scanner::ScanMatch> = if let Some(ref input) = input_dir {
        match scan_nps_directory(&title_to_game, input) {
            Ok(m) => m,
            Err(e) => { eprintln!("Scan error: {}", e); return ExitCode::FAILURE; }
        }
    } else {
        Vec::new()
    };
    let matched_by_name: HashMap<String, &rom_manager::scanner::ScanMatch> = matches.iter().map(|m| (m.name.clone(), m)).collect();

    let total = games.iter().map(|g| g.roms.len()).sum::<usize>();
    let mut built = 0;
    let mut skipped = 0;
    let mut processed = 0;

    for game in &games {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            eprintln!("Build cancelled");
            break;
        }

        let platform = game.platform.as_deref().unwrap_or("Games");
        let matched = matched_by_name.get(&game.name);

        for rom in &game.roms {
            processed += 1;
            let subtype_dir = match rom.subtype.as_str() {
                "dlc" => "DLCs",
                "update" => "Updates",
                _ => "Games",
            };

            let dest_dir = collection_dir.join(platform).join(subtype_dir);
            if let Err(e) = std::fs::create_dir_all(&dest_dir) {
                eprintln!("Failed to create dir {}: {}", dest_dir.display(), e);
                skipped += 1;
                continue;
            }

            let dest_file = dest_dir.join(&rom.filename);
            if dest_file.exists() {
                skipped += 1;
                continue;
            }

            let mut copied = false;

            // Try local copy from scanned match first
            if let Some(m) = matched {
                if let Some(ref src) = m.filename {
                    if let Err(e) = std::fs::copy(src, &dest_file) {
                        eprintln!("Failed to copy {}: {}", rom.filename, e);
                    } else {
                        built += 1;
                        copied = true;
                    }
                }
            }

            // Try CDN download if not copied locally
            if !copied {
                if let Some(ref content_id) = game.content_id {
                    if rom.size.unwrap_or(0) > 0 {
                        let url = format!(
                            "https://d2wy0z66aukln1.cloudedge.net/{}/{}",
                            content_id, rom.filename
                        );
                        send_progress(
                            ((processed as f32 / total as f32) * 100.0) as u32,
                            &format!("Downloading {}", rom.filename),
                        );
                        match reqwest::blocking::get(&url) {
                            Ok(resp) if resp.status().is_success() => {
                                match resp.bytes() {
                                    Ok(bytes) => {
                                        if let Err(e) = std::fs::write(&dest_file, &bytes) {
                                            eprintln!("Failed to write {}: {}", rom.filename, e);
                                            skipped += 1;
                                        } else {
                                            built += 1;
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to download {}: {}", rom.filename, e);
                                        skipped += 1;
                                    }
                                }
                            }
                            _ => {
                                skipped += 1;
                            }
                        }
                    } else {
                        skipped += 1;
                    }
                } else {
                    skipped += 1;
                }
            }
        }
    }

    let result = BuildOutput { built, skipped, total };
    if json {
        print_json(&result);
    } else {
        println!("Build complete: {} copied, {} skipped, {} total", result.built, result.skipped, result.total);
    }
    ExitCode::SUCCESS
}

fn cmd_scrape(args: &[String], json: bool) -> ExitCode {
    if args.len() < 2 {
        eprintln!("Usage: nps-cli scrape <version-id> [--game-id <id>]");
        return ExitCode::FAILURE;
    }
    let version_id: i64 = match args[1].parse() {
        Ok(id) => id,
        Err(_) => { eprintln!("Invalid version ID: {}", args[1]); return ExitCode::FAILURE; }
    };
    let game_id: Option<i64> = args.iter().position(|a| a == "--game-id")
        .and_then(|p| args.get(p + 1))
        .and_then(|s| s.parse().ok());

    let db = match Database::open(&db_path()) {
        Ok(d) => d,
        Err(e) => { eprintln!("Database error: {}", e); return ExitCode::FAILURE; }
    };

    install_signal_handlers();
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let games = match db.list_nps_games(version_id) {
        Ok(g) => g,
        Err(e) => { eprintln!("Failed to list games: {}", e); return ExitCode::FAILURE; }
    };

    let games: Vec<NpsGame> = if let Some(gid) = game_id {
        games.into_iter().filter(|g| g.id == gid).collect()
    } else {
        games
    };

    let total = games.len();
    let mut scraped = 0;
    let mut failed = 0;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let regions = ["us", "eu", "jp"];
    let langs = ["en", "en-3", "ja"];

    for game in &games {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            eprintln!("Scrape cancelled");
            break;
        }

        let content_id = game.content_id.as_deref().unwrap_or("");
        if content_id.is_empty() {
            failed += 1;
            continue;
        }

        let mut screenshots: Vec<String> = Vec::new();

        'outer: for region in &regions {
            for lang in &langs {
                let url = format!(
                    "https://store.playstation.com/store/api/chihiro/00_09_000/container/{}/{}/{}",
                    region, lang, content_id
                );

                send_progress(
                    (((total - games.len() + scraped + failed) as f32 / total as f32) * 100.0) as u32,
                    &format!("Scraping {}", game.name),
                );

                match client.get(&url).send() {
                    Ok(resp) if resp.status().is_success() => {
                        if let Ok(data) = resp.json::<serde_json::Value>() {
                            if let Some(obj) = data.get("metadata") {
                                if let Some(hero) = obj.get("hero_image") {
                                    if let Some(urls) = hero.get("urls") {
                                        if let Some(arr) = urls.as_array() {
                                            for img in arr {
                                                if let Some(url) = img.get("url") {
                                                    if let Some(s) = url.as_str() {
                                                        screenshots.push(s.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                if let Some(screens) = obj.get("screens") {
                                    if let Some(arr) = screens.as_array() {
                                        for screen in arr {
                                            if let Some(url) = screen.get("url") {
                                                if let Some(s) = url.as_str() {
                                                    screenshots.push(s.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !screenshots.is_empty() {
                                break 'outer;
                            }
                        }
                    }
                    _ => continue,
                }
            }
        }

        if !screenshots.is_empty() {
            screenshots.truncate(5);
            let json = serde_json::to_string(&screenshots).unwrap_or_else(|_| "[]".to_string());
            if let Err(e) = db.conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                &[&format!("screenshots_{}", game.id) as &dyn rusqlite::types::ToSql, &json as &dyn rusqlite::types::ToSql],
            ) {
                eprintln!("Failed to update game {}: {}", game.id, e);
                failed += 1;
            } else {
                scraped += 1;
            }
        } else {
            failed += 1;
        }
    }

    let result = ScrapeOutput { scraped, failed, total };
    if json {
        print_json(&result);
    } else {
        println!("Scrape complete: {} scraped, {} failed, {} total", result.scraped, result.failed, result.total);
    }
    ExitCode::SUCCESS
}
