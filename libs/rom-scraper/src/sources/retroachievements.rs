use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::Mutex;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};
use crate::rate_limiter::RateLimiter;

const RA_URL: &str = "https://retroachievements.org/API";

fn platform_to_console_id(platform: &str) -> Option<i32> {
    match platform.to_lowercase().as_str() {
        "megadriv" | "megadrive" | "genesis" | "mega drive" => Some(1),
        "nes" | "nintendo entertainment system" | "nintendo" | "famicom" => Some(7),
        "snes" | "super nintendo" | "super nintendo entertainment system" | "super famicom" | "sfc" => Some(3),
        "n64" | "nintendo 64" => Some(2),
        "gamecube" | "ngc" => Some(14),
        "wii" => Some(16),
        "gb" | "game boy" | "gameboy" => Some(4),
        "gbc" | "game boy color" => Some(5),
        "gba" | "game boy advance" => Some(6),
        "nds" | "nintendo ds" => Some(17),
        "vb" | "virtual boy" => Some(11),
        "psx" | "ps1" | "playstation" => Some(8),
        "ps2" | "playstation 2" => Some(9),
        "psp" | "playstation portable" => Some(15),
        "ps3" | "playstation 3" | "psn" => Some(26),
        "psv" | "ps vita" | "playstation vita" => Some(38),
        "saturn" | "sega saturn" => Some(22),
        "dreamcast" | "sega dreamcast" => Some(23),
        "sms" | "master system" | "sega master system" | "sega mark iii" => Some(20),
        "gamegear" | "game gear" | "sega game gear" => Some(21),
        "sega 32x" | "32x" => Some(24),
        "sega cd" | "segacd" | "mega cd" | "megacd" => Some(25),
        "arcade" | "mame" | "fbneo" | "final burn neo" => Some(23),
        "ng" | "neogeo" | "neo geo" | "aes" | "mvs" => Some(13),
        "ngp" | "neogeo pocket" | "neo geo pocket" => Some(32),
        "ngpc" | "neogeo pocket color" | "neo geo pocket color" => Some(33),
        "pce" | "pc engine" | "turbografx" | "turbografx-16" | "tg16" | "turbografx16" => Some(10),
        "sgx" | "supergrafx" => Some(36),
        "wonderswan" | "ws" => Some(44),
        "wonderswan color" | "wsc" => Some(45),
        "coleco" | "colecovision" => Some(27),
        "atari 2600" | "2600" | "atari2600" => Some(28),
        "atari 5200" | "5200" => Some(30),
        "atari 7800" | "7800" => Some(29),
        "jaguar" | "atari jaguar" => Some(31),
        "lynx" | "atari lynx" => Some(34),
        "c64" | "commodore 64" => Some(37),
        "amiga" | "commodore amiga" => Some(49),
        "dos" => Some(55),
        "channelf" | "fairchild channel f" => Some(42),
        "zxspectrum" | "zx spectrum" => Some(46),
        "msx" | "msx1" | "msx 1" => Some(48),
        "msx2" => Some(50),
        "sg1000" => Some(52),
        "atomiswave" => Some(53),
        "ngcd" | "neo geo cd" => Some(58),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Default)]
struct PlatformHashIndex {
    games: Vec<IndexedGame>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct IndexedGame {
    id: i64,
    title: String,
    hashes: Vec<String>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct RAGameListEntry {
    #[serde(default)]
    ID: i64,
    #[serde(default)]
    Title: String,
    #[serde(default)]
    Hashes: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct RAGameExtended {
    #[serde(default)]
    ID: i64,
    #[serde(default)]
    Title: String,
    #[serde(default)]
    ImageIcon: String,
    #[serde(default)]
    ImageTitle: String,
    #[serde(default)]
    ImageIngame: String,
    #[serde(default)]
    ImageBoxArt: String,
    #[serde(default)]
    Publisher: String,
    #[serde(default)]
    Developer: String,
    #[serde(default)]
    Genre: String,
    #[serde(default)]
    Released: String,
    #[serde(default)]
    ConsoleName: String,
}

pub struct RetroAchievements {
    client: HttpClient,
    api_key: String,
    priority: u32,
    rate_limiter: RateLimiter,
    cache_dir: Option<PathBuf>,
    hash_index: Mutex<HashMap<i32, Vec<IndexedGame>>>,
}

impl RetroAchievements {
    pub fn new(config: &Config) -> Self {
        let cfg = config.retroachievements.as_ref().expect("RetroAchievements config required");
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::RetroAchievements)
            .map(|e| e.priority)
            .unwrap_or(330);
        let cache_dir = config.cache_dir.as_ref().map(|d| d.join("retroachievements"));
        Self {
            client: HttpClient::new(),
            api_key: cfg.api_key.clone(),
            priority,
            rate_limiter: RateLimiter::new(4.0),
            cache_dir,
            hash_index: Mutex::new(HashMap::new()),
        }
    }

    fn ra_url(&self, endpoint: &str) -> String {
        format!("{}/{}?y={}", RA_URL, endpoint, self.api_key)
    }

    fn cache_path(&self, console_id: i32) -> Option<PathBuf> {
        self.cache_dir.as_ref().map(|d| d.join(format!("{}.json", console_id)))
    }

    async fn ensure_hash_index(&self, console_id: i32) -> Result<()> {
        {
            let idx = self.hash_index.lock().await;
            if idx.contains_key(&console_id) {
                return Ok(());
            }
        }

        if let Some(cache_path) = self.cache_path(console_id) {
            if let Ok(body) = std::fs::read_to_string(&cache_path) {
                if let Ok(index) = serde_json::from_str::<PlatformHashIndex>(&body) {
                    let mut idx = self.hash_index.lock().await;
                    idx.insert(console_id, index.games);
                    return Ok(());
                }
            }
        }

        let url = format!("{}&i={}&h=1", self.ra_url("API_GetGameList.php"), console_id);
        self.rate_limiter.acquire().await;
        let body = self.client.get_text(&url).await?;
        let entries: Vec<RAGameListEntry> = serde_json::from_str(&body)
            .map_err(|e| Error::Source(format!("RetroAchievements game list parse error: {}", e)))?;

        let games: Vec<IndexedGame> = entries.into_iter().map(|e| IndexedGame {
            id: e.ID,
            title: e.Title,
            hashes: e.Hashes.unwrap_or_default(),
        }).collect();

        if let Some(cache_path) = self.cache_path(console_id) {
            if let Some(dir) = cache_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let index = PlatformHashIndex { games: games.clone() };
            let _ = std::fs::write(&cache_path, serde_json::to_string(&index).unwrap());
        }

        let mut idx = self.hash_index.lock().await;
        idx.insert(console_id, games);
        Ok(())
    }

    async fn fetch_detail(&self, game_id: i64) -> Result<Game> {
        let url = format!("{}&i={}", self.ra_url("API_GetGameExtended.php"), game_id);
        self.rate_limiter.acquire().await;
        let body = self.client.get_text(&url).await?;
        let detail: RAGameExtended = serde_json::from_str(&body)
            .map_err(|e| Error::Source(format!("RetroAchievements detail parse error: {}", e)))?;

        let mut covers = Vec::new();
        let mut screenshots = Vec::new();
        let mut logos = Vec::new();

        if !detail.ImageBoxArt.is_empty() {
            covers.push(MediaItem { url: normalize_ra_image(&detail.ImageBoxArt), kind: MediaType::Cover2D });
        }
        if !detail.ImageIngame.is_empty() {
            screenshots.push(MediaItem { url: normalize_ra_image(&detail.ImageIngame), kind: MediaType::Screenshot });
        }
        if !detail.ImageTitle.is_empty() {
            screenshots.push(MediaItem { url: normalize_ra_image(&detail.ImageTitle), kind: MediaType::Screenshot });
        }
        if !detail.ImageIcon.is_empty() {
            logos.push(MediaItem { url: normalize_ra_image(&detail.ImageIcon), kind: MediaType::Logo });
        }

        let genres: Vec<String> = if detail.Genre.is_empty() {
            vec![]
        } else {
            detail.Genre.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        };

        Ok(Game {
            id: detail.ID.to_string(),
            title: detail.Title,
            alternative_titles: vec![],
            platform: Platform {
                id: detail.ConsoleName.to_lowercase().replace(' ', "-"),
                name: detail.ConsoleName.clone(),
                short_name: detail.ConsoleName.to_lowercase().replace(' ', "-"),
            },
            description: String::new(),
            publisher: if detail.Publisher.is_empty() { None } else { Some(detail.Publisher) },
            developer: if detail.Developer.is_empty() { None } else { Some(detail.Developer) },
            release_date: if detail.Released.is_empty() { None } else { Some(detail.Released) },
            genres,
            players: None,
            rating: None,
            roms: vec![],
            media: Media { covers, screenshots, logos, ..Default::default() },
            source: ScrapeSource::RetroAchievements,
        })
    }
}

fn normalize_ra_image(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else if path.starts_with('/') {
        format!("https://retroachievements.org{}", path)
    } else {
        format!("https://retroachievements.org/{}", path)
    }
}

#[async_trait]
impl crate::sources::GameScraper for RetroAchievements {
    fn name(&self) -> &str { "retroachievements" }

    fn source_type(&self) -> ScrapeSource { ScrapeSource::RetroAchievements }

    fn priority(&self) -> u32 { self.priority }

    async fn search_by_name(&self, query: &str, platform: Option<&str>) -> Result<Vec<Game>> {
        let console_id = match platform.and_then(platform_to_console_id) {
            Some(id) => id,
            None => return Ok(vec![]),
        };
        self.ensure_hash_index(console_id).await?;
        let games = {
            let idx = self.hash_index.lock().await;
            idx.get(&console_id).cloned().unwrap_or_default()
        };

        let q = query.to_lowercase();
        let found_ids: Vec<i64> = games.into_iter()
            .filter(|g| g.title.to_lowercase().contains(&q))
            .take(5)
            .map(|g| g.id)
            .collect();

        let mut results = Vec::new();
        for game_id in found_ids {
            if let Ok(game) = self.fetch_detail(game_id).await {
                results.push(game);
            }
        }
        Ok(results)
    }

    async fn search_by_hash(&self, hash: &str, _hash_type: HashType, platform: Option<&str>) -> Result<Vec<Game>> {
        let console_ids: Vec<i32> = match platform.and_then(platform_to_console_id) {
            Some(id) => vec![id],
            None => vec![1, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 37, 38, 42, 44, 45, 46, 48, 49, 50, 52, 53, 55, 58],
        };

        for &console_id in &console_ids {
            self.ensure_hash_index(console_id).await?;
            let games = {
                let idx = self.hash_index.lock().await;
                idx.get(&console_id).cloned().unwrap_or_default()
            };
            for g in &games {
                if g.hashes.iter().any(|h| h.eq_ignore_ascii_case(hash)) {
                    return self.fetch_detail(g.id).await.map(|game| vec![game]);
                }
            }
        }
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let id: i64 = game_id.parse()
            .map_err(|_| Error::Config(format!("Invalid RetroAchievements game ID: {}", game_id)))?;
        self.fetch_detail(id).await
    }
}
