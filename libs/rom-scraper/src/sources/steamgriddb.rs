use async_trait::async_trait;
use serde::Deserialize;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::Result;
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

const SGDB_URL: &str = "https://steamgriddb.com/api/v2";

#[derive(Deserialize)]
struct SGDBGamesResponse {
    data: Vec<SGDBGame>,
}

#[derive(Deserialize)]
struct SGDBGameResponse {
    data: SGDBGame,
}

#[derive(Deserialize, Default)]
struct SGDBGame {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    types: Vec<String>,
    #[serde(default)]
    verified: bool,
}

#[derive(Deserialize)]
struct SGBDGridListResponse {
    data: Vec<SGDBGrid>,
}

#[derive(Deserialize, Default)]
struct SGDBGrid {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    url: String,
    #[serde(default)]
    thumb: String,
    #[serde(default)]
    style: String,
    #[serde(default)]
    tags: Vec<String>,
}

pub struct SteamGridDB {
    client: HttpClient,
    api_key: String,
    priority: u32,
}

impl SteamGridDB {
    pub fn new(config: &Config) -> Self {
        let cfg = config.steamgriddb.as_ref().expect("SteamGridDB config required");
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::SteamGridDB)
            .map(|e| e.priority)
            .unwrap_or(380);
        Self {
            client: HttpClient::new(),
            api_key: cfg.api_key.clone(),
            priority,
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.api_key)) {
            h.insert(reqwest::header::AUTHORIZATION, v);
        }
        h
    }

    fn is_tag_ok(tags: &[String]) -> bool {
        !tags.iter().any(|t| t == "nsfw" || t == "humor" || t == "epilepsy")
    }

    async fn authorize(&self, url: &str) -> Result<String> {
        let resp = self.client.inner()
            .get(url)
            .headers(self.headers())
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status != 200 {
            return Err(crate::Error::Source(format!("SteamGridDB HTTP {} from {}", status, url)));
        }
        Ok(resp.text().await?)
    }

    async fn search_and_fetch_grids(&self, query: &str) -> Result<Vec<Game>> {
        let search_url = format!("{}/search/autocomplete/{}", SGDB_URL, url_encode_sgdb(query));
        let body = self.authorize(&search_url).await?;
        let search_resp: SGDBGamesResponse = serde_json::from_str(&body)
            .map_err(|e| crate::Error::Source(format!("SteamGridDB search parse error: {}", e)))?;

        let mut results = Vec::new();
        for game in &search_resp.data {
            if game.name.is_empty() { continue; }

            let grids_url = format!("{}/grids/game/{}?styles=alternate,white_logo,material,no_logo&dimensions=600x900,920x430",
                SGDB_URL, game.id);
            let grids_body = self.authorize(&grids_url).await?;
            let grids_resp: SGBDGridListResponse = match serde_json::from_str(&grids_body) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let mut covers = Vec::new();
            let mut logos = Vec::new();

            for grid in &grids_resp.data {
                if !Self::is_tag_ok(&grid.tags) { continue; }
                if grid.url.is_empty() { continue; }
                match grid.style.as_str() {
                    "white_logo" => logos.push(MediaItem { url: grid.url.clone(), kind: MediaType::Logo }),
                    _ => covers.push(MediaItem { url: grid.url.clone(), kind: MediaType::Cover2D }),
                }
            }

            if covers.is_empty() && logos.is_empty() { continue; }

            results.push(Game {
                id: game.id.to_string(),
                title: game.name.clone(),
                alternative_titles: vec![],
                platform: Platform {
                    id: String::new(),
                    name: String::new(),
                    short_name: String::new(),
                },
                description: String::new(),
                publisher: None,
                developer: None,
                release_date: None,
                genres: vec![],
                players: None,
                rating: None,
                roms: vec![],
                media: Media { covers, logos, ..Default::default() },
                source: ScrapeSource::SteamGridDB,
            });
        }
        Ok(results)
    }
}

#[async_trait]
impl crate::sources::GameScraper for SteamGridDB {
    fn name(&self) -> &str { "steamgriddb" }

    fn source_type(&self) -> ScrapeSource { ScrapeSource::SteamGridDB }

    fn priority(&self) -> u32 { self.priority }

    async fn search_by_name(&self, query: &str, _platform: Option<&str>) -> Result<Vec<Game>> {
        self.search_and_fetch_grids(query).await
    }

    async fn search_by_hash(&self, _hash: &str, _hash_type: HashType, _platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let game_url = format!("{}/games/id/{}", SGDB_URL, game_id);
        let body = self.authorize(&game_url).await?;
        let game_resp: SGDBGameResponse = serde_json::from_str(&body)
            .map_err(|e| crate::Error::Source(format!("SteamGridDB game parse error: {}", e)))?;

        let grids_url = format!("{}/grids/game/{}?styles=alternate,white_logo,material,no_logo&dimensions=600x900,920x430",
            SGDB_URL, game_id);
        let grids_body = self.authorize(&grids_url).await?;
        let grids_resp: SGBDGridListResponse = serde_json::from_str(&grids_body)
            .map_err(|e| crate::Error::Source(format!("SteamGridDB grids parse error: {}", e)))?;

        let mut covers = Vec::new();
        let mut logos = Vec::new();
        for grid in &grids_resp.data {
            if !Self::is_tag_ok(&grid.tags) { continue; }
            if grid.url.is_empty() { continue; }
            match grid.style.as_str() {
                "white_logo" => logos.push(MediaItem { url: grid.url.clone(), kind: MediaType::Logo }),
                _ => covers.push(MediaItem { url: grid.url.clone(), kind: MediaType::Cover2D }),
            }
        }

        Ok(Game {
            id: game_id.to_string(),
            title: game_resp.data.name.clone(),
            alternative_titles: vec![],
            platform: Platform {
                id: String::new(),
                name: String::new(),
                short_name: String::new(),
            },
            description: String::new(),
            publisher: None,
            developer: None,
            release_date: None,
            genres: vec![],
            players: None,
            rating: None,
            roms: vec![],
            media: Media { covers, logos, ..Default::default() },
            source: ScrapeSource::SteamGridDB,
        })
    }
}

fn url_encode_sgdb(s: &str) -> String {
    let mut buf = [0u8; 4];
    s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            c.to_string()
        } else if c == ' ' {
            "%20".to_string()
        } else {
            let encoded = c.encode_utf8(&mut buf);
            encoded.bytes().map(|b| format!("%{:02X}", b)).collect()
        }
    }).collect()
}
