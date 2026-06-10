use serde::Deserialize;

const SEARCH_URL: &str = "https://archive.org/advancedsearch.php";

#[derive(Debug, Deserialize)]
pub struct SearchResponse {
    pub response: SearchResponseBody,
}

#[derive(Debug, Deserialize)]
pub struct SearchResponseBody {
    pub docs: Vec<SearchDoc>,
    #[serde(rename = "numFound")]
    pub num_found: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SearchDoc {
    pub identifier: String,
    pub title: Option<String>,
    pub downloads: Option<i64>,
}

/// Search Internet Archive for items matching a romset and optional collection name/version.
/// `collection_name` is preferred — when set the search uses it as the primary term.
pub async fn search_items(
    romset: &str,
    version: Option<&str>,
    collection_name: Option<&str>,
    rows: u32,
) -> Result<Vec<SearchDoc>, String> {
    let primary = collection_name.unwrap_or(romset);
    let mut query = format!("title:({} roms) OR description:({} roms)", primary, primary);
    if let Some(ver) = version {
        query.push_str(&format!(" AND (title:{} OR description:{})", ver, ver));
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .cookie_store(true)
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;
    let url = format!(
        "{}?q={}&fl[]=identifier&fl[]=title&fl[]=downloads&sort[]=downloads+desc&output=json&rows={}",
        SEARCH_URL, urlencoding(&query), rows
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "GameManager/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("IA API returned HTTP {}", resp.status()));
    }

    let data: SearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error (url: {}): {}", &url[..std::cmp::min(120, url.len())], e))?;

    Ok(data.response.docs)
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
            ' ' => "+".to_string(),
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
