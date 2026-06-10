use std::path::Path;
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

/// URL-encode special characters in a path segment for IA downloads
fn encode_ia_path(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | '.' | '-' | '_' | ' ' => c.to_string(),
            _ => {
                let mut out = String::new();
                for b in c.to_string().bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
                out
            }
        })
        .collect()
}

/// Download a file from an IA item.
/// Returns the number of bytes downloaded.
pub async fn download_file(
    identifier: &str,
    path: &str,
    out_dir: &Path,
    on_progress: Option<&dyn Fn(u64, u64)>,
) -> Result<(String, u64), String> {
    let encoded_path = encode_ia_path(path);
    let url = format!("https://archive.org/download/{}/{}", identifier, encoded_path);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .cookie_store(true)
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let resp = client
        .get(&url)
        .header("Referer", "https://archive.org/")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned HTTP {} for {}", resp.status(), url));
    }

    let total_size = resp.content_length().unwrap_or(0);

    // Determine output file path
    let filename = path.rsplit('/').next().unwrap_or(path);
    let out_path = out_dir.join(filename);

    // Create output directory
    tokio::fs::create_dir_all(out_dir)
        .await
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // Stream download
    let mut file = tokio::fs::File::create(&out_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += chunk.len() as u64;
        if let Some(cb) = on_progress {
            cb(downloaded, total_size);
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;

    let out_str = out_path.to_string_lossy().to_string();
    Ok((out_str, downloaded))
}
