use async_trait::async_trait;
use serde::Deserialize;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::Result;
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

const ARCADEDB_URL: &str = "https://adb.arcadeitalia.net/service_scraper.php";

#[derive(Deserialize)]
struct ArcadeDbResponse {
    #[serde(default)]
    result: Vec<ArcadeDbGame>,
}

#[derive(Deserialize, Default)]
struct ArcadeDbGame {
    #[serde(default)]
    title: String,
    #[serde(default)]
    short_title: String,
    #[serde(default)]
    manufacturer: String,
    #[serde(default)]
    year: String,
    #[serde(default)]
    cloneof: Option<String>,
    #[serde(default)]
    romof: Option<String>,
    #[serde(default)]
    genre: String,
    #[serde(default)]
    url_image_ingame: String,
    #[serde(default)]
    url_image_title: String,
    #[serde(default)]
    url_image_marquee: String,
    #[serde(default)]
    url_video_shortplay: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    players: u8,
}

pub struct ArcadeDb {
    client: HttpClient,
    priority: u32,
}

impl ArcadeDb {
    pub fn new(config: &Config) -> Self {
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::ArcadeDb)
            .map(|e| e.priority)
            .unwrap_or(80);
        let client = HttpClient::new().with_user_agent("GameManager/scraper");
        Self { client, priority }
    }

    fn game_from_result(r: &ArcadeDbGame, query: &str) -> Game {
        let mut media = Media::default();
        if !r.url_image_ingame.is_empty() {
            media.screenshots.push(MediaItem {
                url: r.url_image_ingame.clone(),
                kind: MediaType::Screenshot,
            });
        }
        if !r.url_image_title.is_empty() {
            media.covers.push(MediaItem {
                url: r.url_image_title.clone(),
                kind: MediaType::Cover2D,
            });
        }
        if !r.url_image_marquee.is_empty() {
            media.marquees.push(MediaItem {
                url: r.url_image_marquee.clone(),
                kind: MediaType::Marquee,
            });
        }
        if !r.url_video_shortplay.is_empty() {
            media.videos.push(MediaItem {
                url: r.url_video_shortplay.clone(),
                kind: MediaType::Video,
            });
        }

        Game {
            id: query.to_string(),
            title: if r.short_title.is_empty() { r.title.clone() } else { r.short_title.clone() },
            alternative_titles: vec![r.title.clone()],
            platform: Platform {
                id: "arcade".into(),
                name: "Arcade".into(),
                short_name: "arcade".into(),
            },
            description: r.description.clone(),
            publisher: if r.manufacturer.is_empty() { None } else { Some(r.manufacturer.clone()) },
            developer: None,
            release_date: if r.year.is_empty() { None } else { Some(r.year.clone()) },
            genres: if r.genre.is_empty() { vec![] } else { vec![r.genre.clone()] },
            players: Some(r.players),
            rating: None,
            roms: vec![],
            media,
            source: ScrapeSource::ArcadeDb,
        }
    }
}

#[async_trait]
impl crate::sources::GameScraper for ArcadeDb {
    fn name(&self) -> &str { "arcadedb" }

    fn source_type(&self) -> ScrapeSource { ScrapeSource::ArcadeDb }

    fn priority(&self) -> u32 { self.priority }

    async fn search_by_name(&self, query: &str, _platform: Option<&str>) -> Result<Vec<Game>> {
        let url = format!(
            "{}?ajax=query_mame&game_name={}",
            ARCADEDB_URL, urlencoding(query)
        );
        let text = self.client.get_text(&url).await?;
        let resp: ArcadeDbResponse = serde_json::from_str(&text)
            .map_err(|e| crate::Error::Source(format!("ArcadeDB parse error: {}", e)))?;
        let games: Vec<Game> = resp.result.iter().map(|r| Self::game_from_result(r, query)).collect();
        Ok(games)
    }

    async fn search_by_hash(
        &self, _hash: &str, _hash_type: HashType, _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        // Same as search_by_name — ArcadeDB doesn't have a separate detail endpoint
        let url = format!(
            "{}?ajax=query_mame&game_name={}",
            ARCADEDB_URL, urlencoding(game_id)
        );
        let text = self.client.get_text(&url).await?;
        let resp: ArcadeDbResponse = serde_json::from_str(&text)
            .map_err(|e| crate::Error::Source(format!("ArcadeDB parse error: {}", e)))?;
        match resp.result.first() {
            Some(r) => Ok(Self::game_from_result(r, game_id)),
            None => Err(crate::Error::Source(format!("ArcadeDB: game '{}' not found", game_id))),
        }
    }
}

fn urlencoding(s: &str) -> String {
    let mut buf = [0u8; 4];
    s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            c.to_string()
        } else if c == ' ' {
            "+".to_string()
        } else {
            // Properly percent-encode multi-byte UTF-8 characters
            let encoded = c.encode_utf8(&mut buf);
            encoded.bytes().map(|b| format!("%{:02X}", b)).collect()
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_ascii() {
        assert_eq!(urlencoding("sf2"), "sf2");
        assert_eq!(urlencoding("Street Fighter II"), "Street+Fighter+II");
        assert_eq!(urlencoding("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn urlencoding_multibyte_utf8() {
        // 三 (U+4E09) is 3 bytes in UTF-8: E4 B8 89
        assert_eq!(urlencoding("三国志"), "%E4%B8%89%E5%9B%BD%E5%BF%97");
        // é (U+00E9) is 2 bytes: C3 A9
        assert_eq!(urlencoding("Pokémon"), "Pok%C3%A9mon");
    }
}
