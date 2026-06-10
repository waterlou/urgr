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
        return Err("Usage: ia-cli find <romset> <game> [--version <v>] [--crc <crc>] [--output <dir>]"
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
    let out_dir = args
        .iter()
        .position(|a| a == "-o" || a == "--output")
        .and_then(|p| args.get(p + 1))
        .map(|s| Path::new(s))
        .unwrap_or_else(|| Path::new("."));

    // Step 1: Search for the ROM set
    println!("Searching for {} rom set...", romset);
    let docs = ia_archive::search_items(romset, version.map(|s| s.as_str()), 5).await?;

    if docs.is_empty() {
        return Err(format!(
            "No '{}' ROM set found on Internet Archive.",
            romset
        ));
    }

    let identifier = &docs[0].identifier;
    let title = docs[0].title.as_deref().unwrap_or(identifier);
    println!("  Found: {}  ({})", identifier, title);

    // Step 2: List files and find the game
    println!("Searching for {}...", game);
    let meta = ia_archive::get_metadata(identifier).await?;

    let game_lower = game.to_lowercase();
    let _game_zip = format!("{}.zip", game_lower);

    let matches: Vec<_> = meta
        .files
        .iter()
        .filter(|f| {
            let name_lower = f.name.to_lowercase();
            name_lower.contains(&game_lower) && name_lower.ends_with(".zip")
        })
        .collect();

    if matches.is_empty() {
        println!("  Game '{}' not found in item '{}'.", game, identifier);
        // Show some example files
        let zips: Vec<_> = meta
            .files
            .iter()
            .filter(|f| f.name.ends_with(".zip") && f.size.parse().unwrap_or(0) > 0)
            .take(10)
            .collect();
        if !zips.is_empty() {
            println!("  Example files available:");
            for z in &zips {
                println!("    {}", z.name);
            }
        }
        return Ok(());
    }

    let target = &matches[0];
    if matches.len() > 1 {
        println!("  Found {} matches, using first: {}", matches.len(), target.name);
    } else {
        println!("  Found: {}", target.name);
    }

    // Step 3: Download the file
    let file_path = target.name.trim_start_matches('/');
    println!("Downloading...");
    let (saved_path, size) = ia_archive::download_file(
        identifier,
        file_path,
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
