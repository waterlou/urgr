use async_trait::async_trait;
use serde::Deserialize;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{
    Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource,
};
use crate::sources::GameScraper;

const API_BASE: &str = "https://api.thegamesdb.net/v1.3";

pub struct TheGamesDb {
    client: HttpClient,
    api_key: String,
    priority: u32,
}

#[derive(Deserialize)]
struct TgdbResponse<T> {
    data: Option<T>,
}

#[derive(Deserialize)]
struct GameData {
    games: Option<Vec<TgdbGame>>,
}

#[derive(Deserialize)]
struct GameDetailData {
    games: Option<Vec<TgdbGameDetail>>,
}

#[derive(Deserialize, Debug)]
struct TgdbGame {
    id: u64,
    #[serde(default)]
    game_title: String,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    platform: Option<u64>,
    #[serde(default)]
    rating: Option<String>,
}

#[derive(Deserialize, Debug)]
struct TgdbGameDetail {
    id: u64,
    #[serde(default)]
    game_title: String,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    rating: Option<String>,
    #[serde(default)]
    platform: Option<u64>,
    #[serde(default)]
    players: Option<String>,
}

#[derive(Deserialize)]
struct BoxartData {
    boxart: Option<Vec<TgdbBoxart>>,
}

#[derive(Deserialize, Debug)]
struct TgdbBoxart {
    filename: String,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    thumb: Option<String>,
}

impl TheGamesDb {
    pub fn new(config: &Config) -> Self {
        let tg = config.thegamesdb.as_ref().expect("TheGamesDB config");

        let priority = config
            .source_priority
            .iter()
            .find(|e| e.source == ScrapeSource::TheGamesDb)
            .map(|e| e.priority)
            .unwrap_or(300);

        Self {
            client: HttpClient::new(),
            api_key: tg.api_key.clone(),
            priority,
        }
    }

    fn build_url(&self, endpoint: &str, params: &[(&str, &str)]) -> String {
        let mut query = format!("apikey={}", self.api_key);
        for (k, v) in params {
            query.push('&');
            query.push_str(k);
            query.push('=');
            query.push_str(&urlencode(v));
        }
        format!("{}/{}?{}", API_BASE, endpoint, query)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, endpoint: &str, params: &[(&str, &str)]) -> Result<TgdbResponse<T>> {
        let url = self.build_url(endpoint, params);
        self.client.get_json(&url).await
            .map_err(|e| Error::Source(format!("TheGamesDB API error: {}", e)))
    }

    fn images_base() -> &'static str {
        "https://cdn.thegamesdb.net/images"
    }

    fn boxart_url(filename: &str, thumb: &Option<String>) -> String {
        if let Some(t) = thumb {
            format!("{}/{}", Self::images_base(), t)
        } else {
            format!("{}/{}", Self::images_base(), filename)
        }
    }
}

#[async_trait]
impl GameScraper for TheGamesDb {
    fn name(&self) -> &str {
        "thegamesdb"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::TheGamesDb
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    async fn search_by_name(
        &self,
        query: &str,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        let resp: TgdbResponse<GameData> = self.get_json(
            "Games/ByGameName",
            &[("name", query), ("include", "boxart,platform,genres,developers,publishers")],
        ).await?;

        let games = match resp.data.and_then(|d| d.games) {
            Some(g) => g,
            None => return Ok(Vec::new()),
        };

        let mut results = Vec::new();
        for g in &games {
            let mut media = Media::default();

            // fetch boxart for this game
            if let Ok(box_resp) = self.get_json::<BoxartData>(
                "Games/ByGameID",
                &[("id", &g.id.to_string()), ("include", "boxart")],
            ).await {
                if let Some(boxart) = box_resp.data.and_then(|d| d.boxart) {
                    for b in &boxart {
                        let kind = match b.side.as_deref() {
                            Some("front") => MediaType::Cover2D,
                            Some("back") => MediaType::Cover3D,
                            Some("screenshot") => MediaType::Screenshot,
                            Some("fanart") => MediaType::Fanart,
                            Some("banner") => MediaType::Marquee,
                            Some("clearlogo") => MediaType::Logo,
                            _ => MediaType::Other("unknown".into()),
                        };
                        media.covers.push(MediaItem {
                            url: Self::boxart_url(&b.filename, &b.thumb),
                            kind,
                        });
                    }
                }
            }

            results.push(Game {
                id: g.id.to_string(),
                title: g.game_title.clone(),
                alternative_titles: Vec::new(),
                platform: Platform {
                    id: g.platform.map(|p| p.to_string()).unwrap_or_default(),
                    name: String::new(),
                    short_name: String::new(),
                },
                description: String::new(),
                publisher: None,
                developer: None,
                release_date: g.release_date.clone(),
                genres: Vec::new(),
                players: None,
                rating: g.rating.as_ref().and_then(|r| r.parse::<f32>().ok()),
                roms: Vec::new(),
                media,
                source: ScrapeSource::TheGamesDb,
            });
        }

        Ok(results)
    }

    async fn search_by_hash(
        &self,
        _hash: &str,
        _hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Err(Error::Source("TheGamesDB does not support hash-based search".into()))
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let resp: TgdbResponse<GameDetailData> = self.get_json(
            "Games/ByGameID",
            &[("id", game_id), ("include", "boxart,platform,genres,developers,publishers")],
        ).await?;

        let g = resp.data
            .and_then(|d| d.games)
            .and_then(|mut g| g.pop())
            .ok_or_else(|| Error::Source(format!("TheGamesDB game not found: {}", game_id)))?;

        let mut media = Media::default();
        if let Ok(box_resp) = self.get_json::<BoxartData>(
            "Games/ByGameID",
            &[("id", game_id), ("include", "boxart")],
        ).await {
            if let Some(boxart) = box_resp.data.and_then(|d| d.boxart) {
                for b in &boxart {
                    let kind = match b.side.as_deref() {
                        Some("front") => MediaType::Cover2D,
                        Some("back") => MediaType::Cover3D,
                        Some("screenshot") => MediaType::Screenshot,
                        Some("fanart") => MediaType::Fanart,
                        Some("banner") => MediaType::Marquee,
                        Some("clearlogo") => MediaType::Logo,
                        _ => MediaType::Other("unknown".into()),
                    };
                    media.covers.push(MediaItem {
                        url: Self::boxart_url(&b.filename, &b.thumb),
                        kind,
                    });
                }
            }
        }

        let players = g.players.as_ref()
            .and_then(|p| p.trim().parse::<u8>().ok());

        Ok(Game {
            id: g.id.to_string(),
            title: g.game_title,
            alternative_titles: Vec::new(),
            platform: Platform {
                id: g.platform.map(|p| p.to_string()).unwrap_or_default(),
                name: String::new(),
                short_name: String::new(),
            },
            description: g.overview.unwrap_or_default(),
            publisher: None,
            developer: None,
            release_date: g.release_date,
            genres: Vec::new(),
            players,
            rating: g.rating.as_ref().and_then(|r| r.parse::<f32>().ok()),
            roms: Vec::new(),
            media,
            source: ScrapeSource::TheGamesDb,
        })
    }
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "%20".to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencode_basic() {
        assert_eq!(urlencode("hello"), "hello");
    }

    #[test]
    fn test_urlencode_space() {
        assert_eq!(urlencode("hello world"), "hello%20world");
    }

    #[test]
    fn test_urlencode_special() {
        assert_eq!(urlencode("Super Mario Bros."), "Super%20Mario%20Bros.");
    }

    #[test]
    fn test_urlencode_symbols() {
        let encoded = urlencode("a&b=c");
        assert!(encoded.contains("%26"));
    }
}
