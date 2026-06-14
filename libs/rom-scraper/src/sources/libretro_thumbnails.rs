use async_trait::async_trait;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{Game, HashType, Media, MediaItem, MediaType, Platform, ScrapeSource};

const RETRO_BASE: &str = "https://thumbnails.libretro.com";

pub struct LibretroThumbnails {
    client: HttpClient,
    priority: u32,
}

impl LibretroThumbnails {
    pub fn new(config: &Config) -> Self {
        let priority = config.source_priority.iter()
            .find(|e| e.source == ScrapeSource::LibretroThumbnails)
            .map(|e| e.priority)
            .unwrap_or(350);
        Self { client: HttpClient::new(), priority }
    }

    fn platform_to_folder(platform: &str) -> Option<&'static str> {
        match platform.to_lowercase().as_str() {
            "nes" | "nintendo entertainment system" | "nintendo" => Some("Nintendo - Nintendo Entertainment System"),
            "famicom" | "fds" | "famicom disk system" => Some("Nintendo - Famicom Disk System"),
            "snes" | "super nintendo" | "super nintendo entertainment system" | "super famicom" | "sfc" => Some("Nintendo - Super Nintendo Entertainment System"),
            "n64" | "nintendo 64" => Some("Nintendo - Nintendo 64"),
            "gamecube" | "ngc" => Some("Nintendo - GameCube"),
            "wii" => Some("Nintendo - Wii"),
            "gb" | "game boy" | "gameboy" => Some("Nintendo - Game Boy"),
            "gbc" | "game boy color" => Some("Nintendo - Game Boy Color"),
            "gba" | "game boy advance" => Some("Nintendo - Game Boy Advance"),
            "nds" | "nintendo ds" => Some("Nintendo - Nintendo DS"),
            "3ds" | "nintendo 3ds" => Some("Nintendo - Nintendo 3DS"),
            "vb" | "virtual boy" => Some("Nintendo - Virtual Boy"),
            "megadriv" | "megadrive" | "genesis" | "mega drive" | "sega genesis" | "sega mega drive" => Some("Sega - Mega Drive - Genesis"),
            "sms" | "master system" | "sega master system" | "sega mark iii" => Some("Sega - Master System - Mark III"),
            "gamegear" | "game gear" | "sega game gear" => Some("Sega - Game Gear"),
            "saturn" | "sega saturn" => Some("Sega - Saturn"),
            "dreamcast" | "sega dreamcast" => Some("Sega - Dreamcast"),
            "sega 32x" | "32x" => Some("Sega - 32X"),
            "sega cd" | "segacd" | "mega cd" | "megacd" => Some("Sega - Mega-CD - Sega CD"),
            "psx" | "ps1" | "playstation" => Some("Sony - PlayStation"),
            "ps2" | "playstation 2" => Some("Sony - PlayStation 2"),
            "psp" | "playstation portable" => Some("Sony - PlayStation Portable"),
            "ps3" | "playstation 3" | "psn" => Some("Sony - PlayStation 3"),
            "psv" | "ps vita" | "playstation vita" => Some("Sony - PlayStation Vita"),
            "pce" | "pc engine" | "turbografx" | "turbografx-16" | "tg16" | "turbografx16" => Some("NEC - PC Engine - TurboGrafx 16"),
            "sgx" | "supergrafx" => Some("NEC - SuperGrafx"),
            "ngp" | "neogeo pocket" | "neo geo pocket" => Some("SNK - Neo Geo Pocket"),
            "ngpc" | "neogeo pocket color" | "neo geo pocket color" => Some("SNK - Neo Geo Pocket Color"),
            "ng" | "neogeo" | "neo geo" | "aes" | "mvs" => Some("SNK - Neo Geo"),
            "ngcd" | "neo geo cd" => Some("SNK - Neo Geo CD"),
            "arcade" | "mame" => Some("MAME"),
            "fbneo" | "final burn neo" => Some("FBNeo - Arcade Games"),
            "coleco" | "colecovision" => Some("Coleco - ColecoVision"),
            "msx" | "msx1" | "msx 1" => Some("Microsoft - MSX"),
            "msx2" => Some("Microsoft - MSX2"),
            "zxspectrum" | "zx spectrum" => Some("Sinclair - ZX Spectrum"),
            "channelf" | "fairchild channel f" => Some("Fairchild - Channel F"),
            "sg1000" => Some("Sega - SG-1000"),
            "wonderswan" | "ws" => Some("Bandai - WonderSwan"),
            "wonderswan color" | "wsc" => Some("Bandai - WonderSwan Color"),
            "atari 2600" | "2600" | "atari2600" => Some("Atari - 2600"),
            "atari 5200" | "5200" => Some("Atari - 5200"),
            "atari 7800" | "7800" => Some("Atari - 7800"),
            "jaguar" | "atari jaguar" => Some("Atari - Jaguar"),
            "lynx" | "atari lynx" => Some("Atari - Lynx"),
            "c64" | "commodore 64" => Some("Commodore - 64"),
            "amiga" | "commodore amiga" => Some("Commodore - Amiga"),
            "dos" => Some("DOS"),
            "atomiswave" => Some("Atomiswave"),
            _ => None,
        }
    }
}

#[async_trait]
impl crate::sources::GameScraper for LibretroThumbnails {
    fn name(&self) -> &str { "libretro-thumbnails" }

    fn source_type(&self) -> ScrapeSource { ScrapeSource::LibretroThumbnails }

    fn priority(&self) -> u32 { self.priority }

    async fn search_by_name(&self, query: &str, platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![Game {
            id: format!("{}/{}", platform.unwrap_or("unknown"), query),
            title: query.to_string(),
            alternative_titles: vec![],
            platform: Platform {
                id: platform.unwrap_or("unknown").to_string(),
                name: Self::platform_to_folder(platform.unwrap_or("unknown")).unwrap_or("unknown").to_string(),
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
            source: ScrapeSource::LibretroThumbnails,
        }])
    }

    async fn search_by_hash(&self, _hash: &str, _hash_type: HashType, _platform: Option<&str>) -> Result<Vec<Game>> {
        Ok(vec![])
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let (platform, game_name) = game_id.split_once('/')
            .ok_or_else(|| Error::Config("Invalid game_id format. Expected 'platform/name'".into()))?;

        let folder = Self::platform_to_folder(platform)
            .ok_or_else(|| Error::Config(format!("Unknown platform: {}", platform)))?;

        let encoded_name = url_encode(game_name);
        let base_url = format!("{RETRO_BASE}/{}/", url_encode(folder));

        let mut covers = Vec::new();
        let mut screenshots = Vec::new();
        let mut logos = Vec::new();

        for subdir in &["Named_Boxarts", "Named_Snaps", "Named_Titles"] {
            let url = format!("{base_url}{subdir}/{encoded_name}.png");
            if self.client.head(&url).await.is_ok() {
                match *subdir {
                    "Named_Boxarts" => covers.push(MediaItem { url, kind: MediaType::Cover2D }),
                    "Named_Snaps" => screenshots.push(MediaItem { url, kind: MediaType::Screenshot }),
                    "Named_Titles" => logos.push(MediaItem { url, kind: MediaType::Logo }),
                    _ => {}
                }
            }
        }

        Ok(Game {
            id: game_id.to_string(),
            title: game_name.to_string(),
            alternative_titles: vec![],
            platform: Platform {
                id: platform.to_string(),
                name: folder.to_string(),
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
            source: ScrapeSource::LibretroThumbnails,
        })
    }
}

fn url_encode(s: &str) -> String {
    let mut buf = [0u8; 4];
    s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ',' | '\'' | '!' | ':' | ';' | '#' | '$' | '@' | '&' | '+' | '=' | '~') {
            c.to_string()
        } else if c == ' ' {
            "%20".to_string()
        } else {
            let encoded = c.encode_utf8(&mut buf);
            encoded.bytes().map(|b| format!("%{:02X}", b)).collect()
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_ascii() {
        assert_eq!(url_encode("Final Fantasy VII"), "Final%20Fantasy%20VII");
        assert_eq!(url_encode("a-b_c.d,~'!:;#$@&+=e"), "a-b_c.d,~'!:;#$@&+=e");
    }

    #[test]
    fn url_encode_multibyte_utf8() {
        // é (U+00E9) is 2 bytes: C3 A9
        assert_eq!(url_encode("Pokémon"), "Pok%C3%A9mon");
        // あ (U+3042) is 3 bytes: E3 81 82
        assert_eq!(url_encode("あいう"), "%E3%81%82%E3%81%84%E3%81%86");
    }
}
