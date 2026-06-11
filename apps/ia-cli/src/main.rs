use std::collections::HashMap;
use std::path::Path;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
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
    if args.len() < 2 {
        return Err("Usage: ia-cli search <query>".into());
    }
    let query = &args[1];
    let docs = ia_archive::search_items(query, 10).await?;

    if docs.is_empty() {
        println!("No matching items found on Internet Archive.");
        return Ok(());
    }

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
    if args.len() < 2 {
        return Err("Usage: ia-cli list <identifier> [--filter <name>]".into());
    }
    let identifier = &args[1];
    let filter = args
        .iter()
        .position(|a| a == "--filter")
        .and_then(|p| args.get(p + 1));

    let meta = ia_archive::get_metadata(identifier).await?;
    let files: Vec<_> = meta
        .files
        .iter()
        .filter(|f| {
            let size: u64 = f.size.parse().unwrap_or(0);
            size > 0
                && !f.name.starts_with("__")
                && !f.name.ends_with(".xml")
                && !f.name.ends_with(".sqlite")
        })
        .collect();

    if files.is_empty() {
        println!("No files found in item '{}'.", identifier);
        return Ok(());
    }

    let total_games = files
        .iter()
        .filter(|f| f.name.ends_with(".zip") && !f.name.contains("/__"))
        .count();

    println!("Item '{}': {} files ({} game zips)", identifier, files.len(), total_games);

    if let Some(pattern) = filter {
        let pattern_lower = pattern.to_lowercase();
        let matching: Vec<_> = files
            .iter()
            .filter(|f| f.name.to_lowercase().contains(&pattern_lower))
            .collect();

        if matching.is_empty() {
            println!("  No files matching '{}'.", pattern);
            return Ok(());
        }

        println!("  Matching files:");
        for f in &matching {
            let size_mb: f64 = f.size.parse().unwrap_or(0) as f64 / 1_048_576.0;
            println!("    {}  ({:.1} MB)", f.name, size_mb);
        }
    } else {
        for f in files.iter().take(30) {
            println!("  {}", f.name);
        }
        if files.len() > 30 {
            println!("  ... and {} more files", files.len() - 30);
        }
    }
    Ok(())
}

async fn cmd_download(args: &[String]) -> Result<(), String> {
    if args.len() < 3 {
        return Err("Usage: ia-cli download <identifier> <path> -o <output-dir> [--username <u>] [--password <p>]".into());
    }
    let identifier = &args[1];
    let path = &args[2];
    let out_dir = args
        .iter()
        .position(|a| a == "-o" || a == "--output")
        .and_then(|p| args.get(p + 1))
        .map(|s| Path::new(s))
        .unwrap_or_else(|| Path::new("."));

    let username = args
        .iter()
        .position(|a| a == "--username")
        .and_then(|p| args.get(p + 1));
    let password = args
        .iter()
        .position(|a| a == "--password")
        .and_then(|p| args.get(p + 1));

    let dl_client = if let (Some(u), Some(p)) = (username, password) {
        eprintln!("Logging in as {}...", u);
        match ia_archive::login(u, p).await {
            Ok(session) => {
                eprintln!("  Login successful.");
                Some(session.client)
            }
            Err(e) => {
                eprintln!("  Login failed (will try anonymous): {}", e);
                None
            }
        }
    } else {
        None
    };

    println!("Downloading {} from {} ...", path, identifier);

    let (saved_path, size) = ia_archive::download_file_with_client(
        dl_client,
        identifier,
        path,
        out_dir,
        Some(&|downloaded, total| {
            if total > 0 {
                let pct = downloaded as f64 / total as f64 * 100.0;
                let mb_dl = downloaded as f64 / 1_048_576.0;
                let mb_total = total as f64 / 1_048_576.0;
                eprint!("\r  {:.0}% ({:.1}/{:.1} MB)", pct, mb_dl, mb_total);
            }
        }),
    )
    .await?;

    println!("\nSaved to: {}", saved_path);
    println!("Size: {:.1} MB", size as f64 / 1_048_576.0);
    Ok(())
}

// =============================================================================
// cmd_find — search, find, download, verify CRC
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
    let out_dir = flag_val(args, "--output")
        .map(|s| Path::new(s))
        .unwrap_or_else(|| Path::new("."));

    // Parse CRC map: "name1:crc32,name2:crc32,..."
    let expected_crcs: HashMap<String, String> = if let Some(crc_str) = crc_arg {
        crc_str.split(',')
            .filter_map(|pair| {
                let mut parts = pair.splitn(2, ':');
                let name = parts.next()?.to_lowercase();
                let crc = parts.next()?.to_uppercase();
                Some((name, crc))
            })
            .collect()
    } else {
        HashMap::new()
    };

    // Login if credentials provided
    let auth_session = if let (Some(u), Some(p)) = (username.as_deref(), password.as_deref()) {
        eprintln!("Logging in as {}...", u);
        match ia_archive::login(u, p).await {
            Ok(s) => { eprintln!("  Login successful (screenname: {}).", s.screenname); Some(s) }
            Err(e) => { eprintln!("  Login failed (will try anonymous): {}", e); None }
        }
    } else { None };
    let is_authenticated = auth_session.is_some();

    let game_lower = game.to_lowercase();
    let mut found_match: Option<(String, String, u64)> = None;
    let mut tried_items: Vec<String> = Vec::new();
    let mut found_identifier: Option<String> = None;

    // --- Search strategy ---
    // Priority 1: cached-id provided
    if found_match.is_none() {
        if let Some(id) = cached_id {
            let id_str = id.to_string();
            if !tried_items.contains(&id_str) {
                tried_items.push(id_str.clone());
                eprintln!("  Checking cached item: {}...", id_str);
                found_match = find_game_in_item(&id_str, &game_lower, is_authenticated).await?;
                if found_match.is_some() { found_identifier = Some(id_str); }
            }
        }
    }

    // Priority 2: source + version search
    if found_match.is_none() {
        let mut queries = Vec::new();
        if let Some(ver) = &version {
            queries.push(format!("{} {} roms", source, ver));
        }
        queries.push(format!("{} roms", source));

        for query in &queries {
            if found_match.is_some() { break; }
            eprintln!("  Searching: {}...", query);
            if let Ok(docs) = ia_archive::search_items(query, 20).await {
                for doc in &docs {
                    if tried_items.contains(&doc.identifier) { continue; }
                    tried_items.push(doc.identifier.clone());
                    eprintln!("  Checking: {}...", doc.identifier);
                    found_match = find_game_in_item(&doc.identifier, &game_lower, is_authenticated).await?;
                    if found_match.is_some() { found_identifier = Some(doc.identifier.clone()); break; }
                }
            }
        }
    }

    // Priority 3: search by game name directly
    if found_match.is_none() {
        eprintln!("  Searching for game '{}' directly on IA...", game);
        if let Ok(docs) = ia_archive::search_items(game, 10).await {
            for doc in &docs {
                if tried_items.contains(&doc.identifier) { continue; }
                tried_items.push(doc.identifier.clone());
                eprintln!("  Checking: {}...", doc.identifier);
                found_match = find_game_in_item(&doc.identifier, &game_lower, is_authenticated).await?;
                if found_match.is_some() { found_identifier = Some(doc.identifier.clone()); break; }
            }
        }
    }

    let (identifier, file_path, file_size) = match found_match {
        Some((id, path, size)) => (id, path, size),
        None => {
            eprintln!("  Game '{}' not found in any search result.", game);
            eprintln!("  Tried items:");
            for id in &tried_items { eprintln!("    - {}", id); }
            // Output JSON error
            let err = serde_json::json!({"ok":false,"error":"Game not found on Internet Archive","tried_items":tried_items});
            println!("{}", serde_json::to_string(&err).unwrap());
            return Err("Game not found on Internet Archive".into());
        }
    };

    let found_identifier = found_identifier.unwrap_or_else(|| identifier.clone());
    eprintln!("  Found: {}  ({})", identifier, &file_path.rsplit('/').next().unwrap_or(&file_path));
    let size_mb = file_size as f64 / 1_048_576.0;
    if size_mb > 0.0 { eprintln!("  Size: {:.1} MB", size_mb); }

    // --- Download ---
    eprintln!("  Downloading...");
    let dl_client = auth_session.as_ref().map(|s| s.client.clone());

    // Download to temp path first for CRC verification
    let temp_dir = out_dir.join(".ia-tmp");
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let filename = file_path.rsplit('/').next().unwrap_or(&file_path);

    let (actual_path, _) = ia_archive::download_file_with_client(
        dl_client,
        &identifier,
        &file_path,
        &temp_dir,
        Some(&|downloaded, total| {
            if total > 0 {
                let pct = downloaded as f64 / total as f64 * 100.0;
                eprint!("\r  Download: {:.0}%", pct);
            }
        }),
    )
    .await?;

    // Move to final destination
    let final_path = out_dir.join(filename);
    if actual_path != final_path.to_string_lossy().to_string() {
        tokio::fs::rename(&actual_path, &final_path).await.map_err(|e| format!("Failed to move file: {}", e))?;
    }

    // --- CRC verification ---
    let crc_result = if !expected_crcs.is_empty() {
        eprintln!("\r  Verifying CRC...");
        let r = ia_archive::verify_zip_crc(&final_path, &expected_crcs)?;
        if r.mismatches.is_empty() && r.missing.is_empty() {
            eprintln!("  CRC: {} entries matched ✓", r.match_count);
        } else {
            if !r.mismatches.is_empty() {
                eprintln!("  CRC mismatch! {} matched, {} mismatched:", r.match_count, r.mismatch_count);
                for m in &r.mismatches {
                    eprintln!("    {}: expected {}, got {}", m.entry_name, m.expected, m.got);
                }
            }
            if !r.missing.is_empty() {
                eprintln!("  CRC incomplete! {} entries missing from zip:", r.missing_count);
                for m in &r.missing {
                    eprintln!("    {}", m);
                }
            }
        }
        Some(r)
    } else {
        None
    };

    let crc_match = crc_result.as_ref().map_or(true, |r| r.mismatches.is_empty() && r.missing.is_empty());
    let download_url = format!("https://archive.org/download/{}/{}", identifier, file_path);

    // Output JSON result
    let output = if crc_match {
        serde_json::json!({
            "ok": true,
            "file": filename,
            "size": file_size,
            "path": final_path.to_string_lossy().to_string(),
            "identifier": identifier,
            "cached_id": found_identifier,
            "crc_match": true,
            "download_url": download_url,
        })
    } else {
        let r = crc_result.as_ref().unwrap();
        serde_json::json!({
            "ok": false,
            "error": "CRC mismatch",
            "crc_mismatches": r.mismatches.iter().map(|m| serde_json::json!({
                "file": m.entry_name,
                "expected": m.expected,
                "got": m.got,
            })).collect::<Vec<_>>(),
            "crc_missing": r.missing,
            "download_url": download_url,
        })
    };

    println!("{}", serde_json::to_string(&output).unwrap());

    // Cleanup temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    if crc_match {
        Ok(())
    } else {
        let _ = std::fs::remove_file(&final_path);
        Err("CRC mismatch — download rejected".into())
    }
}

fn flag_val<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|p| args.get(p + 1))
        .map(|s| s.as_str())
}

async fn find_game_in_item(ident: &str, game_lower: &str, is_authenticated: bool) -> Result<Option<(String, String, u64)>, String> {
    let meta = ia_archive::get_metadata(ident).await?;
    let game_zip = format!("{}.zip", game_lower);
    let game_7z = format!("{}.7z", game_lower);
    let matches: Vec<_> = meta
        .files
        .iter()
        .filter(|f| {
            let nl = f.name.to_lowercase();
            let base = nl.rsplit('/').next().unwrap_or(&nl);
            (base == &game_zip || base == &game_7z)
                && f.size.parse::<u64>().unwrap_or(0) > 0
                && (is_authenticated || f.private.as_deref() != Some("true"))
        })
        .collect();
    if let Some(best) = matches.first() {
        let file_path = best.name.trim_start_matches('/').to_string();
        let size = best.size.parse::<u64>().unwrap_or(0);
        Ok(Some((ident.to_string(), file_path, size)))
    } else {
        Ok(None)
    }
}
