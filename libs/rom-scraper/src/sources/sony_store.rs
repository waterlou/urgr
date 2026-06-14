use async_trait::async_trait;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::Result;
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

pub struct SonyStore {
    client: HttpClient,
    priority: u32,
}

impl SonyStore {
    pub fn new(config: &Config) -> Self {
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::SonyStore)
            .map(|e| e.priority)
            .unwrap_or(500);
        Self { client: HttpClient::new(), priority }
    }
}

#[async_trait]
impl crate::sources::GameScraper for SonyStore {
    fn name(&self) -> &str {
        "sony-store"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::SonyStore
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    async fn search_by_name(&self, query: &str, _platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![Game {
            id: query.to_string(),
            title: query.to_string(),
            alternative_titles: vec![],
            platform: Platform {
                id: "psn".into(),
                name: "PlayStation Network".into(),
                short_name: "psn".into(),
            },
            description: String::new(),
            publisher: None,
            developer: None,
            release_date: None,
            genres: vec![],
            players: None,
            rating: None,
            roms: vec![],
            media: Media::default(),
            source: ScrapeSource::SonyStore,
        }])
    }

    async fn search_by_hash(
        &self,
        _hash: &str,
        _hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    /// get_game_detail: fetch screenshots from Sony PlayStation Store API
    /// game_id format: the content_id (e.g. "UP4395-PCSE00890_00-10SECNINJAVITAUS")
    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let mut screenshots = Vec::new();

        let regions: &[(&str, &str, &str)] = &[
            ("US", "US", "en"),
            ("EU", "GB", "en"),
            ("JP", "JP", "ja"),
            ("ASIA", "SG", "en"),
        ];

        let timestamp = "1534563384000";

        for (region_name, country, lang) in regions {
            let url = format!(
                "https://store.playstation.com/store/api/chihiro/00_09_000/container/{}/{}/19/{}/{}",
                country, lang, game_id, timestamp
            );
            match self.client.get_json::<serde_json::Value>(&url).await {
                Ok(data) => {
                    if let Some(images) = data.get("images").and_then(|i| i.as_array()) {
                        for img in images {
                            if let Some(url) = img.get("url").and_then(|u| u.as_str()) {
                                screenshots.push(MediaItem {
                                    url: url.to_string(),
                                    kind: MediaType::Screenshot,
                                });
                            }
                        }
                    }
                    if !screenshots.is_empty() {
                        screenshots.truncate(5);
                        break;
                    }
                }
                Err(_) => continue,
            }
        }

        Ok(Game {
            id: game_id.to_string(),
            title: String::new(),
            alternative_titles: vec![],
            platform: Platform {
                id: "psn".into(),
                name: "PlayStation Network".into(),
                short_name: "psn".into(),
            },
            description: String::new(),
            publisher: None,
            developer: None,
            release_date: None,
            genres: vec![],
            players: None,
            rating: None,
            roms: vec![],
            media: Media { screenshots, ..Default::default() },
            source: ScrapeSource::SonyStore,
        })
    }
}
