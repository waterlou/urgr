use std::collections::HashMap;
use std::path::Path;

const MAX_DOWNLOAD_ATTEMPTS: usize = 5;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--version" {
        println!("ia-cli {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.len() < 2 {
        eprintln!("Usage: ia-cli <command> [options]\n");
        eprintln!("Commands:");
        eprintln!("  search <query>                          Search IA for items");
        eprintln!("  list <identifier> [--filter <name>]     List files in an IA item");
        eprintln!("  download <id> <path> -o <dir>           Download a file from IA");
        eprintln!("  find <source> <game> [--version <v>]    Search, find, and download");
        eprintln!("       [--cached-id <id>] [--crc <n:c,...>] [--output <dir>]");
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "search" => cmd_search(&args[1..]).await,
        "list" => cmd_list(&args[1..]).await,
        "download" => cmd_download(&args[1..]).await,
        "find" => cmd_find(&args[1..]).await,
        _ => {
            eprintln!("Unknown command: {}", args[1]);
            std::process::exit(1);
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

async fn cmd_search(args: &[String]) -> Result<(), String> {
    if args.len() < 2 { return Err("Usage: ia-cli search <query>".into()); }
    let query = &args[1];
    let docs = ia_archive::search_items(query, 10).await?;
    if docs.is_empty() { println!("No matching items found on Internet Archive."); return Ok(()); }
    println!("Found {} items:", docs.len());
    for doc in &docs {
        let title = doc.title.as_deref().unwrap_or("(no title)");
        let downloads = doc.downloads.unwrap_or(0);
        println!("  {}  ({} downloads)", doc.identifier, downloads);
        println!("    Title: {}", title);
    }
    Ok(())
}

async fn cmd_list(args: &[String]) -> Result<(), String> {
    if args.len() < 2 { return Err("Usage: ia-cli list <identifier> [--filter <name>]".into()); }
    let identifier = &args[1];
    let filter = args.iter().position(|a| a == "--filter").and_then(|p| args.get(p + 1));
    let meta = ia_archive::get_metadata(identifier).await?;
    let files: Vec<_> = meta.files.iter().filter(|f| {
        let size: u64 = f.size.parse().unwrap_or(0);
        size > 0 && !f.name.starts_with("__") && !f.name.ends_with(".xml") && !f.name.ends_with(".sqlite")
    }).collect();

    if files.is_empty() { println!("No files found in item '{}'.", identifier); return Ok(()); }
    let total_games = files.iter().filter(|f| f.name.ends_with(".zip") && !f.name.contains("/__")).count();
    println!("Item '{}': {} files ({} game zips)", identifier, files.len(), total_games);

    if let Some(pattern) = filter {
        let pattern_lower = pattern.to_lowercase();
        let matching: Vec<_> = files.iter().filter(|f| f.name.to_lowercase().contains(&pattern_lower)).collect();
        if matching.is_empty() { println!("  No files matching '{}'.", pattern); return Ok(()); }
        println!("  Matching files:");
        for f in &matching { let s: f64 = f.size.parse().unwrap_or(0) as f64 / 1_048_576.0; println!("    {}  ({:.1} MB)", f.name, s); }
    } else {
        for f in files.iter().take(30) { println!("  {}", f.name); }
        if files.len() > 30 { println!("  ... and {} more files", files.len() - 30); }
    }
    Ok(())
}

async fn cmd_download(args: &[String]) -> Result<(), String> {
    if args.len() < 3 { return Err("Usage: ia-cli download <identifier> <path> -o <output-dir> [--username <u>] [--password <p>]".into()); }
    let identifier = &args[1];
    let path = &args[2];
    let out_dir = args.iter().position(|a| a == "-o" || a == "--output").and_then(|p| args.get(p + 1)).map(|s| Path::new(s)).unwrap_or_else(|| Path::new("."));
    let username = args.iter().position(|a| a == "--username").and_then(|p| args.get(p + 1));
    let password = args.iter().position(|a| a == "--password").and_then(|p| args.get(p + 1));

    let dl_client = if let (Some(u), Some(p)) = (username, password) {
        eprintln!("Logging in as {}...", u);
        match ia_archive::login(u, p).await {
            Ok(session) => { eprintln!("  Login successful."); Some(session.client) }
            Err(e) => { eprintln!("  Login failed (will try anonymous): {}", e); None }
        }
    } else { None };

    println!("Downloading {} from {} ...", path, identifier);
    let (saved_path, size) = ia_archive::download_file_with_client(dl_client, identifier, path, out_dir, Some(&|downloaded, total| {
        if total > 0 { let pct = downloaded as f64 / total as f64 * 100.0; eprint!("\r  {:.0}% ({:.1}/{:.1} MB)", pct, downloaded as f64 / 1_048_576.0, total as f64 / 1_048_576.0); }
    })).await?;
    println!("\nSaved to: {}", saved_path);
    println!("Size: {:.1} MB", size as f64 / 1_048_576.0);
    Ok(())
}

// =============================================================================
// cmd_find — search, find, download, verify CRC with fallback retry
// =============================================================================
async fn cmd_find(args: &[String]) -> Result<(), String> {
    if args.len() < 3 {
        return Err("Usage: ia-cli find <source> <game> [--version <v>] [--cached-id <id>] [--crc <name:crc,...>] [--output <dir>] [--username <u>] [--password <p>]".into());
    }
    let source = &args[1];
    let game = &args[2];
    let version = flag_val(args, "--version");
    let cached_id = flag_val(args, "--cached-id");
    let crc_arg = flag_val(args, "--crc");
    let username = flag_val(args, "--username");
    let password = flag_val(args, "--password");
    let out_dir = flag_val(args, "--output").map(|s| Path::new(s)).unwrap_or_else(|| Path::new("."));

    let expected_crcs: HashMap<String, String> = if let Some(crc_str) = crc_arg {
        crc_str.split(',').filter_map(|pair| {
            let mut parts = pair.splitn(2, ':');
            let name = parts.next()?.to_lowercase();
            let crc = parts.next()?.to_uppercase();
            Some((name, crc))
        }).collect()
    } else { HashMap::new() };

    let auth_session = if let (Some(u), Some(p)) = (username.as_deref(), password.as_deref()) {
        eprintln!("Logging in as {}...", u);
        match ia_archive::login(u, p).await {
            Ok(s) => { eprintln!("  Login successful (screenname: {}).", s.screenname); Some(s) }
            Err(e) => { eprintln!("  Login failed (will try anonymous): {}", e); None }
        }
    } else { None };
    let is_authenticated = auth_session.is_some();
    let dl_client = auth_session.as_ref().map(|s| s.client.clone());

    let game_lower = game.to_lowercase();
    let game_zip = format!("{}.zip", game_lower);
    let game_7z = format!("{}.7z", game_lower);
    let mut candidates: Vec<String> = Vec::new();

    // Priority 1: cached-id
    if let Some(id) = cached_id {
        if !candidates.contains(&id.to_string()) {
            candidates.push(id.to_string());
        }
    }

    // Priority 2: source + version search
    let mut queries = Vec::new();
    if let Some(ver) = &version { queries.push(format!("{} {} roms", source, ver)); }
    queries.push(format!("{} roms", source));

    for query in &queries {
        if let Ok(docs) = ia_archive::search_items(query, 20).await {
            for doc in &docs {
                if !candidates.contains(&doc.identifier) {
                    candidates.push(doc.identifier.clone());
                }
            }
        }
    }

    // Priority 3: search by game name directly
    if let Ok(docs) = ia_archive::search_items(game, 10).await {
        for doc in &docs {
            if !candidates.contains(&doc.identifier) {
                candidates.push(doc.identifier.clone());
            }
        }
    }

    // Collect all matching files across all candidates
    struct Match {
        identifier: String,
        file_path: String,
        file_size: u64,
    }

    let mut all_matches: Vec<Match> = Vec::new();

    for ident in &candidates {
        eprintln!("  Checking: {}...", ident);
        if let Ok(meta) = ia_archive::get_metadata(ident).await {
            for f in &meta.files {
                let nl = f.name.to_lowercase();
                let base = nl.rsplit('/').next().unwrap_or(&nl);
                if (base == &game_zip || base == &game_7z)
                    && f.size.parse::<u64>().unwrap_or(0) > 0
                    && (is_authenticated || f.private.as_deref() != Some("true"))
                {
                    let file_path = f.name.trim_start_matches('/').to_string();
                    let size = f.size.parse::<u64>().unwrap_or(0);
                    all_matches.push(Match { identifier: ident.clone(), file_path, file_size: size });
                    break; // one file per item
                }
            }
        }
    }

    if all_matches.is_empty() {
        progress_msg(100, &format!("Game '{}' not found on Internet Archive", game));
        let err = serde_json::json!({"ok":false,"error":"Game not found on Internet Archive","candidates":candidates});
        println!("{}", serde_json::to_string(&err).unwrap());
        return Err("Game not found on Internet Archive".into());
    }

    progress_msg(5, &format!("Found {} candidate(s), starting download...", all_matches.len()));
    // Try each match — download + CRC verify, continue to next on failure
    let temp_dir = out_dir.join(".ia-tmp");
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let mut last_error = String::new();
    let mut download_attempts = 0usize;

    for (attempt, m) in all_matches.iter().enumerate() {
        if attempt >= MAX_DOWNLOAD_ATTEMPTS {
            eprintln!("  Reached maximum download attempts ({})", all_matches.len().min(MAX_DOWNLOAD_ATTEMPTS));
            break;
        }
        download_attempts += 1;

        let filename = m.file_path.rsplit('/').next().unwrap_or(&m.file_path);
        let size_mb = m.file_size as f64 / 1_048_576.0;
        let total_attempts = all_matches.len().min(MAX_DOWNLOAD_ATTEMPTS);
        progress_msg(10 + (download_attempts as u32 - 1) * 15, &format!("Attempt {}/{}: downloading {} from {} ({:.1} MB)", download_attempts, total_attempts, filename, m.identifier, size_mb));

        // Download
        let dl_result = ia_archive::download_file_with_client(
            dl_client.clone(),
            &m.identifier,
            &m.file_path,
            &temp_dir,
            Some(&|downloaded, total| {
                if total > 0 {
                    let pct = downloaded as f64 / total as f64 * 100.0;
                    eprintln!("  Download: {:.0}%", pct);
                }
            }),
        ).await;

        match dl_result {
            Ok((actual_path, _)) => {
                let final_path = out_dir.join(filename);
                if actual_path != final_path.to_string_lossy().to_string() {
                    if let Err(e) = tokio::fs::rename(&actual_path, &final_path).await {
                        eprintln!("  Failed to move file: {}", e);
                        last_error = format!("Failed to move file: {}", e);
                        let _ = tokio::fs::remove_file(&actual_path).await;
                        continue;
                    }
                }

                // CRC verification
                let crc_pass = if !expected_crcs.is_empty() {
                    progress_msg(10 + (download_attempts as u32 - 1) * 15 + 5, "Verifying CRC...");
                    match ia_archive::verify_zip_crc(&final_path, &expected_crcs) {
                        Ok(r) => {
                            if r.mismatches.is_empty() && r.missing.is_empty() {
                                progress_msg(10 + (download_attempts as u32 - 1) * 15 + 10, &format!("CRC: {} entries matched ✓", r.match_count));
                                true
                            } else {
                                if !r.mismatches.is_empty() {
                                    eprintln!("  CRC mismatch! {} matched, {} mismatched:", r.match_count, r.mismatch_count);
                                    for m in &r.mismatches { eprintln!("    {}: expected {}, got {}", m.entry_name, m.expected, m.got); }
                                }
                                if !r.missing.is_empty() {
                                    eprintln!("  CRC incomplete! {} entries missing:", r.missing_count);
                                    for m in &r.missing { eprintln!("    {}", m); }
                                }
                                false
                            }
                        }
                        Err(e) => {
                            eprintln!("  CRC verify error: {}", e);
                            false
                        }
                    }
                } else {
                    true // no CRC to check
                };

                if crc_pass {
                    // Cleanup temp dir
                    let _ = std::fs::remove_dir_all(&temp_dir);

                    let download_url = format!("https://archive.org/download/{}/{}", m.identifier, m.file_path);
                    let output = serde_json::json!({
                        "ok": true,
                        "file": filename,
                        "size": m.file_size,
                        "path": final_path.to_string_lossy().to_string(),
                        "identifier": m.identifier,
                        "cached_id": m.identifier,
                        "crc_match": true,
                        "download_url": download_url,
                    });
                    println!("{}", serde_json::to_string(&output).unwrap());
                    return Ok(());
                } else {
                    // CRC failed — delete the bad file and try next source
                    progress_msg(10 + (download_attempts as u32 - 1) * 15 + 10, &format!("CRC failed for {} from {}, trying next source...", filename, m.identifier));
                    let _ = std::fs::remove_file(&final_path);
                    last_error = format!("CRC mismatch for {} from {}", filename, m.identifier);
                }
            }
            Err(e) => {
                eprintln!("  Download failed: {}", e);
                last_error = format!("Download failed from {}: {}", m.identifier, e);
            }
        }
    }

    // All attempts failed
    let _ = std::fs::remove_dir_all(&temp_dir);

    progress_msg(100, &format!("All {} download attempt(s) failed: {}", download_attempts, last_error));
    let download_url = all_matches.first().map(|m| format!("https://archive.org/download/{}/{}", m.identifier, m.file_path)).unwrap_or_default();
    let output = serde_json::json!({
        "ok": false,
        "error": last_error,
        "download_url": download_url,
        "attempts": download_attempts,
    });
    println!("{}", serde_json::to_string(&output).unwrap());
    Err(last_error)
}

fn flag_val<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|p| args.get(p + 1)).map(|s| s.as_str())
}

fn progress_msg(pct: u32, msg: &str) {
    eprintln!("{}", serde_json::json!({"pct": pct, "msg": msg}));
}
