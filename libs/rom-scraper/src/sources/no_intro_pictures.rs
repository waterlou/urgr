use async_trait::async_trait;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

const RAW_BASE: &str = "https://raw.githubusercontent.com/teeedubb/no-intro-pictures/master";

pub struct NoIntroPictures {
    client: HttpClient,
    priority: u32,
}

impl NoIntroPictures {
    pub fn new(config: &Config) -> Self {
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::NoIntroPictures)
            .map(|e| e.priority)
            .unwrap_or(400);
        Self { client: HttpClient::new(), priority }
    }

    /// Map internal platform slugs to no-intro-pictures folder names
    fn platform_to_folder(platform: &str) -> String {
        match platform.to_lowercase().as_str() {
            "nes" | "nintendo entertainment system" => "Nintendo - Nintendo Entertainment System".into(),
            "snes" | "super nintendo" | "super nintendo entertainment system" => "Nintendo - Super Nintendo Entertainment System".into(),
            "n64" | "nintendo 64" => "Nintendo - Nintendo 64".into(),
            "gameboy" | "gb" => "Nintendo - Game Boy".into(),
            "gbc" | "game boy color" => "Nintendo - Game Boy Color".into(),
            "gba" | "game boy advance" => "Nintendo - Game Boy Advance".into(),
            "nds" | "nintendo ds" => "Nintendo - Nintendo DS".into(),
            "3ds" | "nintendo 3ds" => "Nintendo - Nintendo 3DS".into(),
            "megadriv" | "megadrive" | "genesis" | "mega drive" => "Sega - Mega Drive - Genesis".into(),
            "sms" | "master system" | "sega master system" => "Sega - Master System - Mark III".into(),
            "gamegear" | "game gear" => "Sega - Game Gear".into(),
            "saturn" | "sega saturn" => "Sega - Saturn".into(),
            "dreamcast" | "sega dreamcast" => "Sega - Dreamcast".into(),
            "psx" | "ps1" | "playstation" => "Sony - PlayStation".into(),
            "ps2" | "playstation 2" => "Sony - PlayStation 2".into(),
            "psp" | "playstation portable" => "Sony - PlayStation Portable".into(),
            "pce" | "pc engine" | "turbografx" | "turbografx-16" | "tg16" | "turbografx16" => "NEC - PC Engine - TurboGrafx 16".into(),
            "sgx" | "supergrafx" => "NEC - SuperGrafx".into(),
            "coleco" | "colecovision" => "Coleco - ColecoVision".into(),
            "msx" | "msx1" | "msx 1" => "Microsoft - MSX".into(),
            "msx2" => "Microsoft - MSX2".into(),
            "zxspectrum" | "zx spectrum" => "Sinclair - ZX Spectrum".into(),
            "channelf" | "fairchild channel f" => "Fairchild - Channel F".into(),
            "sg1000" => "Sega - SG-1000".into(),
            "ngp" | "neogeo pocket" | "neo geo pocket" => "SNK - Neo Geo Pocket".into(),
            "ngpc" | "neogeo pocket color" => "SNK - Neo Geo Pocket Color".into(),
            "wonderswan" | "ws" => "Bandai - WonderSwan".into(),
            "wonderswan color" | "wsc" => "Bandai - WonderSwan Color".into(),
            "fds" | "famicom disk system" => "Nintendo - Famicom Disk System".into(),
            "arcade" => "Arcade".into(),
            // Fallback: use as-is
            _ => {
                // Capitalize first letter of each word
                let pascal: String = platform
                    .split(|c: char| c == '-' || c == ' ' || c == '_')
                    .filter(|s| !s.is_empty())
                    .map(|w| {
                        let mut c = w.chars();
                        match c.next() {
                            None => String::new(),
                            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                if pascal.is_empty() { platform.to_string() } else { pascal }
            }
        }
    }
}

#[async_trait]
impl crate::sources::GameScraper for NoIntroPictures {
    fn name(&self) -> &str {
        "no-intro-pictures"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::NoIntroPictures
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    /// search_by_name: no search API available.
    /// Return a placeholder result so the caller can use get_game_detail
    async fn search_by_name(&self, query: &str, platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![Game {
            id: format!("{}/{}", platform.unwrap_or("unknown"), query),
            title: query.to_string(),
            alternative_titles: vec![],
            platform: Platform {
                id: platform.unwrap_or("unknown").to_string(),
                name: Self::platform_to_folder(platform.unwrap_or("unknown")),
                short_name: platform.unwrap_or("unknown").to_string(),
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
            source: ScrapeSource::NoIntroPictures,
        }])
    }

    /// search_by_hash: not supported
    async fn search_by_hash(
        &self,
        _hash: &str,
        _hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    /// get_game_detail: fetch cover/screenshot from GitHub raw URLs
    /// game_id format: "{platform}/{game_name}"
    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let (platform, game_name) = game_id.split_once('/')
            .ok_or_else(|| Error::Config("Invalid game_id format. Expected 'platform/name'".into()))?;

        let folder = Self::platform_to_folder(platform);
        let encoded_folder = Self::url_encode(&folder);
        let encoded_name = Self::url_encode(game_name);

        let mut covers = Vec::new();
        let mut screenshots = Vec::new();
        let mut logos = Vec::new();
        let base_url = format!("{RAW_BASE}/{encoded_folder}");

        // Try Named_Boxarts, Named_Snaps, Named_Titles for each extension
        for subdir in &["Named_Boxarts", "Named_Snaps", "Named_Titles"] {
            for ext in &["png", "jpg"] {
                let url = format!("{base_url}/{subdir}/{encoded_name}.{ext}");
                if self.client.head(&url).await.is_ok() {
                    match *subdir {
                        "Named_Boxarts" => covers.push(MediaItem { url, kind: MediaType::Cover2D }),
                        "Named_Snaps" => screenshots.push(MediaItem { url, kind: MediaType::Screenshot }),
                        "Named_Titles" => logos.push(MediaItem { url, kind: MediaType::Logo }),
                        _ => {}
                    }
                    break; // one match per subdir is enough
                }
            }
        }

        Ok(Game {
            id: game_id.to_string(),
            title: game_name.to_string(),
            alternative_titles: vec![],
            platform: Platform {
                id: platform.to_string(),
                name: folder.clone(),
                short_name: platform.to_string(),
            },
            description: String::new(),
            publisher: None,
            developer: None,
            release_date: None,
            genres: vec![],
            players: None,
            rating: None,
            roms: vec![],
            media: Media { screenshots, covers, logos, ..Default::default() },
            source: ScrapeSource::NoIntroPictures,
        })
    }
}

impl NoIntroPictures {
    fn url_encode(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
                ' ' => "%20".to_string(),
                _ => {
                    let mut s = String::new();
                    for b in c.to_string().bytes() {
                        s.push_str(&format!("%{:02X}", b));
                    }
                    s
                }
            })
            .collect()
    }
}
