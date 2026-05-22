use crate::models::ScrapeSource;

#[derive(Debug, Clone)]
pub struct Config {
    pub screenscraper: Option<ScreenScraperConfig>,
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
pub struct SourceEntry {
    pub source: ScrapeSource,
    pub priority: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            screenscraper: None,
            cache_dir: None,
            source_priority: vec![SourceEntry {
                source: ScrapeSource::ScreenScraper,
                priority: 100,
            }],
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

    pub fn with_cache_dir(mut self, path: std::path::PathBuf) -> Self {
        self.cache_dir = Some(path);
        self
    }

    pub fn with_source_priority(mut self, entries: Vec<SourceEntry>) -> Self {
        self.source_priority = entries;
        self
    }
}
