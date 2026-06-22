use async_trait::async_trait;
use serde::Deserialize;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::Result;
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};
use crate::rate_limiter::RateLimiter;

const MOBYGAMES_URL: &str = "https://api.mobygames.com/v1";

#[derive(Deserialize)]
struct MobyResponse {
    #[serde(default)]
    games: Vec<MobyGame>,
}

#[derive(Deserialize, Default)]
struct MobyGame {
    #[serde(default)]
    game_id: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    sample_cover: Option<MobyCover>,
    #[serde(default)]
    sample_screenshots: Vec<MobyScreenshot>,
    #[serde(default)]
    genres: Vec<MobyGenre>,
    #[serde(default)]
    platforms: Vec<MobyPlatform>,
    #[serde(default)]
    moby_score: f64,
    #[serde(default)]
    alternate_titles: Vec<MobyAltTitle>,
}

#[derive(Deserialize, Default)]
struct MobyCover {
    #[serde(default)]
    image: String,
}

#[derive(Deserialize, Default)]
struct MobyScreenshot {
    #[serde(default)]
    image: String,
    #[serde(default)]
    caption: String,
}

#[derive(Deserialize, Default)]
struct MobyGenre {
    #[serde(default)]
    genre_name: String,
}

#[derive(Deserialize, Default)]
struct MobyPlatform {
    #[serde(default)]
    platform_name: String,
    #[serde(default)]
    first_release_date: String,
}

#[derive(Deserialize, Default)]
struct MobyAltTitle {
    #[serde(default)]
    title: String,
}

pub struct MobyGames {
    client: HttpClient,
    api_key: String,
    priority: u32,
    rate_limiter: RateLimiter,
}

impl MobyGames {
    pub fn new(config: &Config) -> Self {
        let cfg = config.mobygames.as_ref().expect("MobyGames config required");
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::MobyGames)
            .map(|e| e.priority)
            .unwrap_or(180);
        Self {
            client: HttpClient::new(),
            api_key: cfg.api_key.clone(),
            priority,
            rate_limiter: RateLimiter::new(1.0),
        }
    }

    fn game_from_response(&self, r: &MobyGame) -> Game {
        let mut covers = Vec::new();
        if let Some(ref cover) = r.sample_cover {
            if !cover.image.is_empty() {
                covers.push(MediaItem { url: cover.image.clone(), kind: MediaType::Cover2D });
            }
        }
        let mut screenshots = Vec::new();
        for s in &r.sample_screenshots {
            if !s.image.is_empty() {
                screenshots.push(MediaItem { url: s.image.clone(), kind: MediaType::Screenshot });
            }
        }

        let platform_name = r.platforms.first().map(|p| p.platform_name.as_str()).unwrap_or("Unknown");
        let release_date = r.platforms.first().and_then(|p| {
            if p.first_release_date.is_empty() { None } else { Some(p.first_release_date.clone()) }
        });

        let rating = if r.moby_score > 0.0 { Some((r.moby_score / 10.0) as f32) } else { None };

        let alt_titles: Vec<String> = r.alternate_titles.iter()
            .map(|a| a.title.clone())
            .filter(|t| !t.is_empty())
            .collect();

        Game {
            id: r.game_id.to_string(),
            title: r.title.clone(),
            alternative_titles: alt_titles,
            platform: Platform {
                id: platform_name.to_lowercase().replace(' ', "-"),
                name: platform_name.to_string(),
                short_name: platform_name.to_lowercase().replace(' ', "-"),
            },
            description: r.description.clone(),
            publisher: None,
            developer: None,
            release_date,
            genres: r.genres.iter().map(|g| g.genre_name.clone()).filter(|n| !n.is_empty()).collect(),
            players: None,
            rating,
            roms: vec![],
            media: Media { covers, screenshots, ..Default::default() },
            source: ScrapeSource::MobyGames,
        }
    }
}

#[async_trait]
impl crate::sources::GameScraper for MobyGames {
    fn name(&self) -> &str { "mobygames" }

    fn source_type(&self) -> ScrapeSource { ScrapeSource::MobyGames }

    fn priority(&self) -> u32 { self.priority }

    async fn search_by_name(&self, query: &str, _platform: Option<&str>) -> Result<Vec<Game>> {
        let url = format!("{}/games?title={}&format=normal&api_key={}",
            MOBYGAMES_URL, url_encode(query), self.api_key);
        self.rate_limiter.acquire().await;
        let text = self.client.get_text(&url).await?;
        let resp: MobyResponse = serde_json::from_str(&text)
            .map_err(|e| crate::Error::Source(format!("MobyGames parse error: {}", e)))?;
        Ok(resp.games.iter().map(|g| self.game_from_response(g)).collect())
    }

    async fn search_by_hash(&self, _hash: &str, _hash_type: HashType, _platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let url = format!("{}/games?id={}&format=normal&api_key={}",
            MOBYGAMES_URL, game_id, self.api_key);
        self.rate_limiter.acquire().await;
        let text = self.client.get_text(&url).await?;
        let resp: MobyResponse = serde_json::from_str(&text)
            .map_err(|e| crate::Error::Source(format!("MobyGames parse error: {}", e)))?;
        match resp.games.into_iter().next() {
            Some(r) => Ok(self.game_from_response(&r)),
            None => Err(crate::Error::Source(format!("MobyGames: game '{}' not found", game_id))),
        }
    }
}

fn url_encode(s: &str) -> String {
    let mut buf = [0u8; 4];
    s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            c.to_string()
        } else if c == ' ' {
            "+".to_string()
        } else {
            let encoded = c.encode_utf8(&mut buf);
            encoded.bytes().map(|b| format!("%{:02X}", b)).collect()
        }
    }).collect()
}
