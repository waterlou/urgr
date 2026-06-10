use serde::Deserialize;

const METADATA_URL: &str = "https://archive.org/metadata";

#[derive(Debug, Deserialize)]
pub struct MetadataResponse {
    pub files: Vec<IAFile>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct IAFile {
    pub name: String,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub md5: Option<String>,
}

/// Get the file listing for an IA item.
pub async fn get_metadata(identifier: &str) -> Result<MetadataResponse, String> {
    let url = format!("{}/{}", METADATA_URL, identifier);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "GameManager/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("IA API returned HTTP {}", resp.status()));
    }

    let data: MetadataResponse = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    Ok(data)
}
