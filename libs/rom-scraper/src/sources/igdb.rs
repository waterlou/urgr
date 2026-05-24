use async_trait::async_trait;
use serde::Deserialize;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{
    Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource,
};
use crate::sources::GameScraper;

fn unix_ts_to_date(ts: i64) -> String {
    let secs_per_day: i64 = 86400;
    let mut days = ts / secs_per_day;
    let mut y = 1970i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        y += 1;
    }
    let months = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    for (i, &days_in_month) in months.iter().enumerate() {
        if days < days_in_month {
            m = i + 1;
            break;
        }
        days -= days_in_month;
    }
    if m == 0 {
        m = 12;
    }
    let d = days + 1;
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const API_BASE: &str = "https://api.igdb.com/v4";

pub struct Igdb {
    client: HttpClient,
    client_id: String,
    client_secret: String,
    access_token: tokio::sync::OnceCell<String>,
    priority: u32,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    #[allow(dead_code)]
    expires_in: u64,
}

#[derive(Deserialize, Debug)]
struct IgdbGame {
    id: u64,
    name: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    first_release_date: Option<i64>,
    #[serde(default)]
    rating: Option<f64>,
    #[serde(default)]
    cover: Option<IgdbCover>,
    #[serde(default)]
    genres: Option<Vec<IgdbGenre>>,
    #[serde(default)]
    platforms: Option<Vec<IgdbPlatform>>,
    #[serde(default)]
    involved_companies: Option<Vec<IgdbCompany>>,
}

#[derive(Deserialize, Debug)]
struct IgdbCover {
    #[serde(default)]
    image_id: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize, Debug)]
struct IgdbGenre {
    name: String,
}

#[derive(Deserialize, Debug)]
struct IgdbPlatform {
    name: String,
}

#[derive(Deserialize, Debug)]
struct IgdbCompany {
    company: Option<IgdbCompanyName>,
    developer: Option<bool>,
    publisher: Option<bool>,
}

#[derive(Deserialize, Debug)]
struct IgdbCompanyName {
    name: String,
}

impl Igdb {
    pub fn new(config: &Config) -> Self {
        let ig = config.igdb.as_ref().expect("IGDB config");

        let priority = config
            .source_priority
            .iter()
            .find(|e| e.source == ScrapeSource::Igdb)
            .map(|e| e.priority)
            .unwrap_or(200);

        Self {
            client: HttpClient::new(),
            client_id: ig.client_id.clone(),
            client_secret: ig.client_secret.clone(),
            access_token: tokio::sync::OnceCell::new(),
            priority,
        }
    }

    async fn ensure_token(&self) -> Result<&str> {
        self.access_token
            .get_or_try_init(|| async {
                let params: &[(&str, &str)] = &[
                    ("client_id", self.client_id.as_str()),
                    ("client_secret", self.client_secret.as_str()),
                    ("grant_type", "client_credentials"),
                ];
                let resp: TokenResponse = self.client.post_form_json(TOKEN_URL, params).await.map_err(|e| {
                    Error::Source(format!("IGDB auth failed: {}", e))
                })?;
                Ok::<_, Error>(resp.access_token)
            })
            .await
            .map(|s| s.as_str())
    }

    async fn api_post(&self, endpoint: &str, body: &str) -> Result<Vec<u8>> {
        let token = self.ensure_token().await?;
        let url = format!("{}/{}", API_BASE, endpoint);

        let resp = self
            .client
            .inner()
            .post(&url)
            .header("Client-ID", &self.client_id)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "text/plain")
            .body(body.to_string())
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Source(format!("IGDB HTTP {}: {}", status.as_u16(), text)));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    fn parse_games(&self, data: &[u8]) -> Result<Vec<IgdbGame>> {
        serde_json::from_slice(data)
            .map_err(|e| Error::Parse(format!("IGDB JSON error: {}", e)))
    }

    fn to_game(&self, g: &IgdbGame) -> Game {
        let release_date = g.first_release_date.map(|ts| unix_ts_to_date(ts));

        let developers: Vec<String> = g
            .involved_companies
            .as_ref()
            .map(|companies| {
                companies
                    .iter()
                    .filter(|c| c.developer.unwrap_or(false))
                    .filter_map(|c| c.company.as_ref().map(|cc| cc.name.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let publishers: Vec<String> = g
            .involved_companies
            .as_ref()
            .map(|companies| {
                companies
                    .iter()
                    .filter(|c| c.publisher.unwrap_or(false))
                    .filter_map(|c| c.company.as_ref().map(|cc| cc.name.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let genres: Vec<String> = g
            .genres
            .as_ref()
            .map(|list| list.iter().map(|x| x.name.clone()).collect())
            .unwrap_or_default();

        let cover_url: String = g
            .cover
            .as_ref()
            .and_then(|c| {
                if let Some(url) = &c.url {
                    Some(url.clone())
                } else if let Some(id) = &c.image_id {
                    Some(format!("https://images.igdb.com/igdb/image/upload/t_cover_big/{}.jpg", id))
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let mut media = Media::default();
        if !cover_url.is_empty() {
            media.covers.push(MediaItem {
                url: cover_url,
                kind: MediaType::Cover2D,
            });
        }

        Game {
            id: g.id.to_string(),
            title: g.name.clone(),
            alternative_titles: Vec::new(),
            platform: Platform {
                id: String::new(),
                name: g.platforms.as_ref()
                    .and_then(|p| p.first().map(|p| p.name.clone()))
                    .unwrap_or_default(),
                short_name: g.platforms.as_ref()
                    .and_then(|p| p.first().map(|p| p.name.clone()))
                    .unwrap_or_default(),
            },
            description: g.summary.clone().unwrap_or_default(),
            publisher: publishers.first().cloned(),
            developer: developers.first().cloned(),
            release_date,
            genres,
            players: None,
            rating: g.rating.map(|r| r as f32),
            roms: Vec::new(),
            media,
            source: ScrapeSource::Igdb,
        }
    }
}

#[async_trait]
impl GameScraper for Igdb {
    fn name(&self) -> &str {
        "igdb"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::Igdb
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    async fn search_by_name(
        &self,
        query: &str,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        let body = format!(
            "search \"{}\"; fields name,summary,first_release_date,cover.url,genres.name,platforms.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,rating; limit 20;",
            query.replace('"', "\\\"")
        );
        let data = self.api_post("games", &body).await?;
        let games = self.parse_games(&data)?;
        Ok(games.iter().map(|g| self.to_game(g)).collect())
    }

    async fn search_by_hash(
        &self,
        _hash: &str,
        _hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Err(Error::Source("IGDB does not support hash-based search".into()))
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let body = format!(
            "where id = {}; fields name,summary,first_release_date,cover.url,genres.name,platforms.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,rating; limit 1;",
            game_id
        );
        let data = self.api_post("games", &body).await?;
        let games = self.parse_games(&data)?;
        games.first().map(|g| self.to_game(g)).ok_or_else(|| {
            Error::Source(format!("IGDB game not found: {}", game_id))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unix_ts_epoch() {
        assert_eq!(unix_ts_to_date(0), "1970-01-01");
    }

    #[test]
    fn test_unix_ts_known_date() {
        // 1991-02-07 = 665884800
        assert_eq!(unix_ts_to_date(665884800), "1991-02-07");
    }

    #[test]
    fn test_unix_ts_2024() {
        // 2024-01-01 = 1704067200
        assert_eq!(unix_ts_to_date(1704067200), "2024-01-01");
    }

    #[test]
    fn test_unix_ts_leap_year() {
        // 2020-02-29 = 1582934400
        assert_eq!(unix_ts_to_date(1582934400), "2020-02-29");
    }
}
