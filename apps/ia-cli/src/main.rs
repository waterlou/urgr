use std::path::Path;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: ia-cli <command> [options]\n");
        eprintln!("Commands:");
        eprintln!("  search <romset> [version]             Search IA for ROM sets");
        eprintln!("  list <identifier> [--filter <name>]    List files in an IA item");
        eprintln!("  download <identifier> <path> -o <dir>  Download a file from an IA item");
        eprintln!("  find <romset> <game> [--version <v>]   Search, find, and download a game");
        eprintln!("       [--crc <crc>] [--output <dir>]");
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
        return Err("Usage: ia-cli search <romset> [version]".into());
    }
    let romset = &args[1];
    let version = args.get(2).map(|s| s.as_str());

    let docs = ia_archive::search_items(romset, version, 10).await?;

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

    // Filter out metadata files and empty entries
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
        // Show first 30 files
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
        return Err("Usage: ia-cli download <identifier> <path> -o <output-dir>".into());
    }
    let identifier = &args[1];
    let path = &args[2];
    let out_dir = args
        .iter()
        .position(|a| a == "-o" || a == "--output")
        .and_then(|p| args.get(p + 1))
        .map(|s| Path::new(s))
        .unwrap_or_else(|| Path::new("."));

    println!("Downloading {} from {} ...", path, identifier);

    let (saved_path, size) = ia_archive::download_file(
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

async fn cmd_find(args: &[String]) -> Result<(), String> {
    if args.len() < 3 {
        return Err("Usage: ia-cli find <romset> <game> [--version <v>] [--crc <crc>] [--output <dir>] [--username <u>] [--password <p>]"
            .into());
    }
    let romset = &args[1];
    let game = &args[2];
    let version = args
        .iter()
        .position(|a| a == "--version")
        .and_then(|p| args.get(p + 1));
    let _crc = args
        .iter()
        .position(|a| a == "--crc")
        .and_then(|p| args.get(p + 1));
    let username = args
        .iter()
        .position(|a| a == "--username")
        .and_then(|p| args.get(p + 1));
    let password = args
        .iter()
        .position(|a| a == "--password")
        .and_then(|p| args.get(p + 1));
    let out_dir = args
        .iter()
        .position(|a| a == "-o" || a == "--output")
        .and_then(|p| args.get(p + 1))
        .map(|s| Path::new(s))
        .unwrap_or_else(|| Path::new("."));

    // Log in to IA if credentials provided (enables downloading private files)
    let auth_client = if let (Some(u), Some(p)) = (username, password) {
        eprintln!("Logging in as {}...", u);
        match ia_archive::login(u, p).await {
            Ok(client) => {
                eprintln!("  Login successful.");
                Some(client)
            }
            Err(e) => {
                eprintln!("  Login failed (will try anonymous): {}", e);
                None
            }
        }
    } else {
        None
    };
    let is_authenticated = auth_client.is_some();

    // Step 1: Search for the ROM set
    eprintln!("Searching for {} rom set...", romset);
    let docs = ia_archive::search_items(romset, version.map(|s| s.as_str()), 20).await?;

    if docs.is_empty() {
        return Err(format!(
            "No '{}' ROM set found on Internet Archive.",
            romset
        ));
    }

    let game_lower = game.to_lowercase();
    let mut found_match: Option<(String, String, u64)> = None;
    let mut tried_items = Vec::new();

    for doc in &docs {
        tried_items.push(doc.identifier.clone());
        eprintln!("  Checking: {}...", doc.identifier);
        let meta = match ia_archive::get_metadata(&doc.identifier).await {
            Ok(m) => m,
            Err(_) => continue,
        };

        let matches: Vec<_> = meta
            .files
            .iter()
            .filter(|f| {
                let name_lower = f.name.to_lowercase();
                name_lower.contains(&game_lower)
                    && (name_lower.ends_with(".zip") || name_lower.ends_with(".7z"))
                    && f.size.parse::<u64>().unwrap_or(0) > 0
                    && (is_authenticated || f.private.as_deref() != Some("true"))
            })
            .collect();

        if let Some(best) = matches.first() {
            let file_path = best.name.trim_start_matches('/').to_string();
            let size = best.size.parse::<u64>().unwrap_or(0);
            found_match = Some((doc.identifier.clone(), file_path, size));
            break;
        }
    }

    // Fallback: search directly for the game name on IA
    if found_match.is_none() {
        eprintln!("  Not found in ROM sets. Searching for game name directly...");
        let game_docs = ia_archive::search_items(game, version.map(|s| s.as_str()), 10).await.unwrap_or_default();
        for doc in &game_docs {
            if tried_items.contains(&doc.identifier) { continue; }
            tried_items.push(doc.identifier.clone());
            eprintln!("  Checking: {}...", doc.identifier);
            let meta = match ia_archive::get_metadata(&doc.identifier).await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let matches: Vec<_> = meta
                .files
                .iter()
                .filter(|f| {
                    let name_lower = f.name.to_lowercase();
                    name_lower == game_lower + ".zip" || name_lower == game_lower + ".7z"
                        || name_lower.contains(&game_lower) && (name_lower.ends_with(".zip") || name_lower.ends_with(".7z"))
                        && f.size.parse::<u64>().unwrap_or(0) > 0
                        && (is_authenticated || f.private.as_deref() != Some("true"))
                })
                .collect();
            if let Some(best) = matches.first() {
                let file_path = best.name.trim_start_matches('/').to_string();
                let size = best.size.parse::<u64>().unwrap_or(0);
                found_match = Some((doc.identifier.clone(), file_path, size));
                break;
            }
        }
    }

    let (identifier, file_path, file_size) = match found_match {
        Some((id, path, size)) => (id, path, size),
        None => {
            eprintln!("  Game '{}' not found in any search result.", game);
            eprintln!("  Tried items:");
            for id in &tried_items {
                eprintln!("    - {}", id);
            }
            return Err(format!("Game '{}' not found on Internet Archive", game));
        }
    };

    eprintln!("  Found: {}  ({})", identifier, &file_path.rsplit('/').next().unwrap_or(&file_path));
    let size_mb = file_size as f64 / 1_048_576.0;
    if size_mb > 0.0 {
        eprintln!("  Size: {:.1} MB", size_mb);
    }

    // Step 3: Download the file
    eprintln!("  Downloading...");
    let (saved_path, size) = ia_archive::download_file_with_client(
        auth_client,
        &identifier,
        &file_path,
        out_dir,
        Some(&|downloaded, total| {
            if total > 0 {
                let pct = downloaded as f64 / total as f64 * 100.0;
                eprint!("\r  {:.0}%", pct);
            }
        }),
    )
    .await?;

    println!("\nDone! Saved to: {}", saved_path);
    println!("Size: {:.1} MB", size as f64 / 1_048_576.0);
    Ok(())
}
