mod igdb;
mod screenscraper;
mod thegamesdb;

use async_trait::async_trait;

use crate::config::Config;
use crate::error::Result;
use crate::hasher::RomHashes;
use crate::models::{Game, HashType, ScrapeSource};

pub use igdb::Igdb;
pub use screenscraper::ScreenScraper;
pub use thegamesdb::TheGamesDb;

#[async_trait]
pub trait GameScraper: Send + Sync {
    fn name(&self) -> &str;
    fn source_type(&self) -> ScrapeSource;
    fn priority(&self) -> u32;

    async fn search_by_name(
        &self,
        query: &str,
        platform: Option<&str>,
    ) -> Result<Vec<Game>>;

    async fn search_by_hash(
        &self,
        hash: &str,
        hash_type: HashType,
        platform: Option<&str>,
    ) -> Result<Vec<Game>>;

    async fn get_game_detail(&self, game_id: &str) -> Result<Game>;
}

pub struct ScraperRegistry {
    scrapers: Vec<Box<dyn GameScraper>>,
}

impl ScraperRegistry {
    pub fn new(config: &Config) -> Self {
        let mut scrapers: Vec<Box<dyn GameScraper>> = Vec::new();

        if config.screenscraper.is_some() {
            scrapers.push(Box::new(ScreenScraper::new(config)));
        }
        if config.igdb.is_some() {
            scrapers.push(Box::new(Igdb::new(config)));
        }
        if config.thegamesdb.is_some() {
            scrapers.push(Box::new(TheGamesDb::new(config)));
        }

        let mut registry = Self { scrapers };

        let mut priority_map: std::collections::HashMap<ScrapeSource, u32> =
            std::collections::HashMap::new();
        for entry in &config.source_priority {
            priority_map.insert(entry.source.clone(), entry.priority);
        }
        registry.scrapers.sort_by_key(|s| {
            priority_map
                .get(&s.source_type())
                .copied()
                .unwrap_or(50)
        });

        registry
    }

    pub fn scrapers(&self) -> &[Box<dyn GameScraper>] {
        &self.scrapers
    }

    pub async fn search_by_name(
        &self,
        query: &str,
        platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        for scraper in &self.scrapers {
            match scraper.search_by_name(query, platform).await {
                Ok(games) if !games.is_empty() => return Ok(games),
                Ok(_) => continue,
                Err(e) => {
                    tracing::debug!(
                        "Scraper {} search_by_name failed: {}",
                        scraper.name(),
                        e
                    );
                    continue;
                }
            }
        }
        Ok(Vec::new())
    }

    pub async fn search_by_hashes(
        &self,
        hashes: &RomHashes,
        platform: Option<&str>,
    ) -> Result<Option<Game>> {
        let hash_entries: [(HashType, &str); 3] = [
            (HashType::Sha1, &hashes.sha1),
            (HashType::Md5, &hashes.md5),
            (HashType::Crc32, &hashes.crc32),
        ];

        for (hash_type, hash_value) in &hash_entries {
            for scraper in &self.scrapers {
                match scraper.search_by_hash(hash_value, *hash_type, platform).await {
                    Ok(games) if !games.is_empty() => return Ok(Some(games[0].clone())),
                    Ok(_) => continue,
                    Err(e) => {
                        tracing::debug!(
                            "Scraper {} {} lookup failed: {}",
                            scraper.name(),
                            hash_type,
                            e
                        );
                        continue;
                    }
                }
            }
        }

        Ok(None)
    }

    pub async fn search_by_hashes_from_source(
        &self,
        hashes: &RomHashes,
        source: &ScrapeSource,
        platform: Option<&str>,
    ) -> Result<Option<Game>> {
        let hash_entries: [(HashType, &str); 3] = [
            (HashType::Sha1, &hashes.sha1),
            (HashType::Md5, &hashes.md5),
            (HashType::Crc32, &hashes.crc32),
        ];
        for (hash_type, hash_value) in &hash_entries {
            for scraper in &self.scrapers {
                if &scraper.source_type() != source {
                    continue;
                }
                match scraper.search_by_hash(hash_value, *hash_type, platform).await {
                    Ok(games) if !games.is_empty() => return Ok(Some(games[0].clone())),
                    Ok(_) => continue,
                    Err(e) => {
                        tracing::debug!(
                            "Scraper {} {} lookup failed: {}",
                            scraper.name(),
                            hash_type,
                            e
                        );
                        continue;
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn search_by_name_from_source(
        &self,
        query: &str,
        source: &ScrapeSource,
        platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        for scraper in &self.scrapers {
            if &scraper.source_type() != source {
                continue;
            }
            return scraper.search_by_name(query, platform).await;
        }
        Err(crate::Error::Config(format!(
            "Scraper '{}' is not configured", source
        )))
    }

    pub async fn get_game_detail(
        &self,
        game_id: &str,
        source: &ScrapeSource,
    ) -> Result<Option<Game>> {
        for scraper in &self.scrapers {
            if &scraper.source_type() != source {
                continue;
            }
            return scraper.get_game_detail(game_id).await.map(Some);
        }
        Ok(None)
    }
}
