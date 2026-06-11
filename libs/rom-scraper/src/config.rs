use crate::models::ScrapeSource;

#[derive(Debug, Clone)]
pub struct Config {
    pub screenscraper: Option<ScreenScraperConfig>,
    pub igdb: Option<IgdbConfig>,
    pub thegamesdb: Option<TheGamesDbConfig>,
    pub cache_dir: Option<std::path::PathBuf>,
    pub source_priority: Vec<SourceEntry>,
}

#[derive(Debug, Clone)]
pub struct ScreenScraperConfig {
    pub dev_id: String,
    pub dev_password: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct IgdbConfig {
    pub client_id: String,
    pub client_secret: String,
}

pub const DEFAULT_TGDB_API_KEY: &str = "e96eddebbe2ead66d6e80a996d9a2e4958964d8363b59de15dc5f282c3a23aae";

#[derive(Debug, Clone)]
pub struct TheGamesDbConfig {
    pub api_key: String,
}

#[derive(Debug, Clone)]
pub struct SourceEntry {
    pub source: ScrapeSource,
    pub priority: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            screenscraper: None,
            igdb: None,
            thegamesdb: Some(TheGamesDbConfig {
                api_key: DEFAULT_TGDB_API_KEY.to_string(),
            }),
            cache_dir: None,
            source_priority: vec![
                SourceEntry { source: ScrapeSource::TheGamesDb, priority: 100 },
                SourceEntry { source: ScrapeSource::ScreenScraper, priority: 200 },
                SourceEntry { source: ScrapeSource::Igdb, priority: 300 },
                SourceEntry { source: ScrapeSource::NoIntroPictures, priority: 400 },
                SourceEntry { source: ScrapeSource::Vgmuseum, priority: 450 },
                SourceEntry { source: ScrapeSource::SonyStore, priority: 500 },
            ],
        }
    }
}

impl Config {
    pub fn with_screenscraper(mut self, dev_id: &str, dev_password: &str) -> Self {
        self.screenscraper = Some(ScreenScraperConfig {
            dev_id: dev_id.to_string(),
            dev_password: dev_password.to_string(),
            username: None,
            password: None,
        });
        self
    }

    pub fn with_screenscraper_auth(
        mut self,
        dev_id: &str,
        dev_password: &str,
        username: &str,
        password: &str,
    ) -> Self {
        self.screenscraper = Some(ScreenScraperConfig {
            dev_id: dev_id.to_string(),
            dev_password: dev_password.to_string(),
            username: Some(username.to_string()),
            password: Some(password.to_string()),
        });
        self
    }

    pub fn with_igdb(mut self, client_id: &str, client_secret: &str) -> Self {
        self.igdb = Some(IgdbConfig {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
        });
        self
    }

    pub fn with_thegamesdb(mut self, api_key: &str) -> Self {
        self.thegamesdb = Some(TheGamesDbConfig {
            api_key: api_key.to_string(),
        });
        self
    }

    pub fn with_cache_dir(mut self, path: std::path::PathBuf) -> Self {
        self.cache_dir = Some(path);
        self
    }

    pub fn with_source_priority(mut self, entries: Vec<SourceEntry>) -> Self {
        self.source_priority = entries;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_igdb() {
        let cfg = Config::default().with_igdb("client123", "secret456");
        let ig = cfg.igdb.unwrap();
        assert_eq!(ig.client_id, "client123");
        assert_eq!(ig.client_secret, "secret456");
    }

    #[test]
    fn test_config_thegamesdb() {
        let cfg = Config::default().with_thegamesdb("apikey789");
        let tg = cfg.thegamesdb.unwrap();
        assert_eq!(tg.api_key, "apikey789");
    }

    #[test]
    fn test_config_multi_source() {
        let cfg = Config::default()
            .with_screenscraper("dev1", "pwd1")
            .with_igdb("cid", "csecret")
            .with_thegamesdb("key");
        assert!(cfg.screenscraper.is_some());
        assert!(cfg.igdb.is_some());
        assert!(cfg.thegamesdb.is_some());
    }

    #[test]
    fn test_config_default_has_thegamesdb() {
        let cfg = Config::default();
        assert!(cfg.screenscraper.is_none());
        assert!(cfg.igdb.is_none());
        assert!(cfg.thegamesdb.is_some());
        assert_eq!(cfg.thegamesdb.unwrap().api_key, DEFAULT_TGDB_API_KEY);
    }
}
