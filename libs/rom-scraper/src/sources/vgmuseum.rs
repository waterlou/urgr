use async_trait::async_trait;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::Result;
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

const VGM_BASE: &str = "https://www.vgmuseum.com/images";
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub struct Vgmuseum {
    client: HttpClient,
    priority: u32,
}

impl Vgmuseum {
    pub fn new(config: &Config) -> Self {
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::Vgmuseum)
            .map(|e| e.priority)
            .unwrap_or(400);
        let client = HttpClient::new().with_user_agent(BROWSER_UA);
        Self { client, priority }
    }

    fn platform_to_slug(platform: &str) -> Option<&'static str> {
        match platform.to_lowercase().as_str() {
            "nes" | "nintendo entertainment system" => Some("nes"),
            "snes" | "super nintendo" | "supernes" | "super-nes" => Some("snes"),
            "n64" | "nintendo 64" => Some("n64"),
            "genesis" | "megadrive" | "mega drive" | "md" => Some("genesis"),
            "gb" | "gameboy" | "game boy" => Some("gb"),
            "gba" | "game boy advance" => Some("gba"),
            "gbc" | "game boy color" => Some("gbc"),
            "psx" | "ps1" | "playstation" => Some("psx"),
            "ps2" | "playstation 2" => Some("ps2"),
            "psp" => Some("psp"),
            "saturn" | "sega saturn" => Some("saturn"),
            "dc" | "dreamcast" | "sega dreamcast" => Some("dc"),
            "tg16" | "turbografx" | "turbografx-16" | "pcengine" | "pce" => Some("tg16"),
            "ng" | "neogeo" | "neo geo" | "aes" | "mvs" => Some("ng"),
            "ngcd" | "neo geo cd" => Some("ngcd"),
            "ngp" | "neo geo pocket" => Some("ngp"),
            "ngpc" | "neo geo pocket color" => Some("ngpc"),
            "gg" | "gamegear" | "game gear" | "sega game gear" => Some("gg"),
            "sms" | "master system" | "sega master system" => Some("sms"),
            "arcade" | "mame" => Some("arcade"),
            "atari" | "atari 2600" | "2600" => Some("atari"),
            "atari 5200" | "5200" => Some("5200"),
            "atari 7800" | "7800" => Some("7800"),
            "jaguar" | "atari jaguar" => Some("jaguar"),
            "lynx" | "atari lynx" => Some("lynx"),
            "c64" | "commodore 64" | "commodore-64" => Some("c64"),
            "amiga" | "commodore amiga" => Some("amiga"),
            "32x" | "sega 32x" => Some("32x"),
            "segacd" | "sega cd" | "scd" => Some("scd"),
            "fds" | "famicom disk system" => Some("fds"),
            "vb" | "virtual boy" => Some("vb"),
            "coleco" | "colecovision" => Some("coleco"),
            "msx" | "msx1" => Some("msx"),
            "msx2" => Some("msx2"),
            "zx spectrum" | "zx" | "zxspectrum" => Some("zx"),
            "sg1000" | "sg-1000" => Some("sg1000"),
            "wonderswan" | "ws" => Some("ws"),
            "wonderswan color" | "wsc" => Some("wsc"),
            "nds" | "nintendo ds" => Some("nds"),
            "3do" => Some("3do"),
            "cdi" | "phillips cdi" | "philips cd-i" => Some("cdi"),
            "vectrex" => Some("vectrex"),
            "intellivision" => Some("intellivision"),
            _ => None,
        }
    }
}

#[async_trait]
impl crate::sources::GameScraper for Vgmuseum {
    fn name(&self) -> &str {
        "vgmuseum"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::Vgmuseum
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    async fn search_by_name(&self, query: &str, platform: Option<&str>) -> Result<Vec<Game>> {
        let slug = match platform.and_then(Self::platform_to_slug) {
            Some(s) => s,
            None => return Ok(vec![]),
        };

        let url = format!("{VGM_BASE}/{slug}_b.html");
        let html = self.client.get_text(&url).await?;

        let query_lower = query.to_lowercase();
        let mut games = Vec::new();
        let mut pos = 0;

        while let Some(entry_start) = html[pos..].find("<li><a href=\"") {
            let start = pos + entry_start + 13;
            let Some(quote_end) = html[start..].find('"') else { break };
            let href = &html[start..start + quote_end];
            let after_quote = start + quote_end + 1;
            let Some(gt) = html[after_quote..].find('>') else { break };
            let text_start = after_quote + gt + 1;
            let remaining = &html[text_start..];
            let close_a = remaining.find("</a>").unwrap_or(usize::MAX);
            let close_br = remaining.find("<br>").unwrap_or(usize::MAX);
            let text_end = close_a.min(close_br);
            if text_end == usize::MAX || text_end == 0 { break }
            let title = remaining[..text_end].trim();

            if !title.is_empty() && title.to_lowercase().contains(&query_lower) {
                let game_id = href.strip_suffix(".html").unwrap_or(href);
                let game_id = game_id.strip_prefix('/').unwrap_or(game_id);
                games.push(Game {
                    id: game_id.to_string(),
                    title: title.to_string(),
                    alternative_titles: vec![],
                    platform: Platform {
                        id: slug.to_string(),
                        name: slug.to_string(),
                        short_name: slug.to_string(),
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
                    source: ScrapeSource::Vgmuseum,
                });
            }
            pos = text_start + text_end;
        }

        Ok(games)
    }

    async fn search_by_hash(
        &self,
        _hash: &str,
        _hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let url = format!("{VGM_BASE}/{game_id}.html");
        let html = self.client.get_text(&url).await?;

        // Base URL for resolving relative image paths
        let base_url = if let Some(last_slash) = game_id.rfind('/') {
            format!("{VGM_BASE}/{}/", &game_id[..last_slash])
        } else {
            format!("{VGM_BASE}/")
        };

        let platform = game_id.split('/').next().unwrap_or("unknown");
        let mut screenshots = Vec::new();
        let html_lower = html.to_lowercase();
        let mut pos = 0;

        while let Some(img_offset) = html_lower[pos..].find("<img") {
            let tag_pos = pos + img_offset;
            let Some(src_offset) = html_lower[tag_pos..].find("src=\"") else { break };
            let src_start = tag_pos + src_offset + 5;
            let Some(quote_end) = html_lower[src_start..].find('"') else { break };
            let src = &html[src_start..src_start + quote_end];
            if !src.is_empty() {
                let url = if src.contains("://") {
                    src.to_string()
                } else {
                    format!("{}{}", base_url, src)
                };
                screenshots.push(MediaItem { url, kind: MediaType::Screenshot });
            }
            pos = src_start + quote_end + 1;
        }

        Ok(Game {
            id: game_id.to_string(),
            title: String::new(),
            alternative_titles: vec![],
            platform: Platform {
                id: platform.to_string(),
                name: platform.to_string(),
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
            media: Media { screenshots, ..Default::default() },
            source: ScrapeSource::Vgmuseum,
        })
    }
}
