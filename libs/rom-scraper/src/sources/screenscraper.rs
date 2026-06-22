use std::collections::HashMap;
use async_trait::async_trait;
use serde_json::Value;

use crate::client::HttpClient;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::models::{
    Game, HashType, Media, MediaItem, MediaType, Platform, RomInfo, ScrapeSource,
};
use crate::sources::GameScraper;

const API_BASE: &str = "https://api.screenscraper.fr/api2";
const MAX_RESULTS: usize = 20;

pub struct ScreenScraper {
    client: HttpClient,
    dev_id: String,
    dev_password: String,
    username: Option<String>,
    password: Option<String>,
    soft_name: String,
    priority: u32,
}

impl ScreenScraper {
    pub fn new(config: &Config) -> Self {
        let ss = config.screenscraper.as_ref().expect("ScreenScraper config");

        let priority = config
            .source_priority
            .iter()
            .find(|e| e.source == ScrapeSource::ScreenScraper)
            .map(|e| e.priority)
            .unwrap_or(100);

        Self {
            client: HttpClient::new(),
            dev_id: ss.dev_id.clone(),
            dev_password: ss.dev_password.clone(),
            username: ss.username.clone(),
            password: ss.password.clone(),
            soft_name: "GameManager".to_string(),
            priority,
        }
    }

    fn build_url(&self, endpoint: &str, extra: &[(&str, &str)]) -> String {
        let mut params = vec![
            ("devid", self.dev_id.as_str()),
            ("devpassword", self.dev_password.as_str()),
            ("softname", self.soft_name.as_str()),
            ("output", "json"),
        ];
        if let Some(ref u) = self.username {
            params.push(("ssid", u.as_str()));
        }
        if let Some(ref p) = self.password {
            params.push(("sspassword", p.as_str()));
        }
        for (k, v) in extra {
            params.push((k, v));
        }

        let query: String = params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
            .collect::<Vec<_>>()
            .join("&");

        format!("{}/{}?{}", API_BASE, endpoint, query)
    }

    async fn api_get(&self, endpoint: &str, extra: &[(&str, &str)]) -> Result<Value> {
        let url = self.build_url(endpoint, extra);
        let text = self.client.get_text(&url).await?;
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| Error::Parse(format!("JSON parse error: {}", e)))?;

        if let Some(err_msg) = parsed
            .pointer("/response/error")
            .and_then(|v| v.as_str())
        {
            if !err_msg.trim().is_empty() {
                return Err(Error::Source(format!("ScreenScraper error: {}", err_msg)));
            }
        }

        Ok(parsed)
    }

    fn parse_game_json(&self, game_val: &Value) -> Option<Game> {
        let id = game_val.get("id").and_then(|v| v.as_str())?;
        let title = game_val
            .get("nom")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        let mut alt_titles = Vec::new();
        let mut region_titles = HashMap::new();
        if let Some(noms) = game_val.get("noms") {
            // Array format: { "nom": [{"text": "...", "region": "us", "langue": "en"}, ...] }
            if let Some(nom_arr) = noms.get("nom").and_then(|v| v.as_array()) {
                for n in nom_arr {
                    if let Some(text) = n.get("text").and_then(|v| v.as_str()) {
                        let region = n.get("region").and_then(|v| v.as_str()).unwrap_or("");
                        if text != title {
                            alt_titles.push(text.to_string());
                        }
                        if !region.is_empty() {
                            region_titles.entry(region.to_string()).or_insert_with(|| text.to_string());
                        }
                    } else if let Some(t) = n.as_str() {
                        if t != title {
                            alt_titles.push(t.to_string());
                        }
                    }
                }
            }
            // Flat key format: { "nom_us": "Super Mario Bros.", "nom_jp": "スーパーマリオブラザーズ", ... }
            if let Some(obj) = noms.as_object() {
                for (key, val) in obj {
                    if let Some(region) = key.strip_prefix("nom_") {
                        if region != "nom" && region != "ss" {
                            if let Some(text) = val.as_str() {
                                region_titles.entry(region.to_string()).or_insert_with(|| text.to_string());
                            }
                        }
                    }
                }
            }
        }

        let description = game_val
            .get("synopsis")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let publisher = game_val
            .get("editeur")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let developer = game_val
            .get("developpeur")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let release_date = game_val
            .get("date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let players = game_val
            .get("joueurs")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u8>().ok());

        let rating = game_val
            .get("note")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f32>().ok());

        let mut genres = Vec::new();
        if let Some(genres_val) = game_val.get("genres") {
            let genre_container = genres_val.get("genre").unwrap_or(genres_val);
            let list: Vec<&Value> = if let Some(arr) = genre_container.as_array() {
                arr.iter().collect()
            } else {
                vec![genre_container]
            };
            for g in &list {
                if let Some(noms) = g.get("noms") {
                    if let Some(nom_arr) = noms.get("nom").and_then(|v| v.as_array()) {
                        for n in nom_arr {
                            if let Some(t) = n.as_str() {
                                genres.push(t.to_string());
                            }
                        }
                    }
                }
            }
        }

        let roms = self.parse_roms(game_val);
        let media = self.parse_media(game_val);

        let platform = self.parse_platform(game_val);

        Some(Game {
            id: id.to_string(),
            title: title.to_string(),
            alternative_titles: alt_titles,
            region_titles,
            platform,
            description,
            publisher,
            developer,
            release_date,
            genres,
            players,
            rating,
            roms,
            media,
            source: ScrapeSource::ScreenScraper,
        })
    }

    fn parse_platform(&self, game_val: &Value) -> Platform {
        let sys_id = game_val
            .pointer("/systeme/id")
            .and_then(|v| v.as_str())
            .unwrap_or("0");
        let sys_name = game_val
            .pointer("/systeme/nom")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let short = platform_id_to_short(sys_id);
        Platform {
            id: sys_id.to_string(),
            name: sys_name.to_string(),
            short_name: short,
        }
    }

    fn parse_roms(&self, game_val: &Value) -> Vec<RomInfo> {
        let mut roms = Vec::new();
        if let Some(roms_val) = game_val.get("roms") {
            if let Some(rom_arr) = roms_val.get("rom").and_then(|v| v.as_array()) {
                for r in rom_arr {
                    let rom = RomInfo {
                        filename: r.get("nom").and_then(|v| v.as_str()).map(String::from),
                        size: r
                            .get("size")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u64>().ok()),
                        crc32: r
                            .get("crc")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_uppercase()),
                        md5: r
                            .get("md5")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_uppercase()),
                        sha1: r
                            .get("sha1")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_uppercase()),
                        region: r.get("region").and_then(|v| v.as_str()).map(String::from),
                        version: r
                            .get("version")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    };
                    roms.push(rom);
                }
            }
        }
        roms
    }

    fn parse_media(&self, game_val: &Value) -> Media {
        let mut media = Media::default();
        if let Some(medias_val) = game_val.get("medias") {
            if let Some(media_arr) = medias_val.get("media").and_then(|v| v.as_array()) {
                for m in media_arr {
                    let url = match m.get("url").and_then(|v| v.as_str()) {
                        Some(u) => u.to_string(),
                        None => continue,
                    };
                    let kind = m
                        .get("type")
                        .and_then(|v| v.as_str())
                        .map(MediaType::from_str)
                        .unwrap_or(MediaType::Other("unknown".to_string()));

                    let item = MediaItem { url, kind };

                    match item.kind {
                        MediaType::Screenshot => media.screenshots.push(item),
                        MediaType::Cover2D | MediaType::Cover3D => media.covers.push(item),
                        MediaType::Logo => media.logos.push(item),
                        MediaType::Marquee => media.marquees.push(item),
                        MediaType::Fanart => media.fanarts.push(item),
                        MediaType::Video => media.videos.push(item),
                        MediaType::Other(_) => {
                            media.screenshots.push(item);
                        }
                    }
                }
            }
        }
        media
    }

    fn extract_game_list(&self, root: &Value) -> Vec<Game> {
        let response = root.get("response");
        let jeux_container = response.and_then(|r| {
            r.get("jeux")
                .or_else(|| r.get("jeu").map(|j| j as &Value))
        });

        let game_values: Vec<&Value> = match jeux_container {
            Some(container) => {
                if let Some(arr) = container.as_array() {
                    arr.iter().collect()
                } else if let Some(val) = container.get("jeu") {
                    if let Some(arr) = val.as_array() {
                        arr.iter().collect()
                    } else {
                        vec![val]
                    }
                } else if container.get("id").is_some() {
                    vec![container]
                } else {
                    Vec::new()
                }
            }
            None => {
                if let Some(jeu) = response.and_then(|r| r.get("jeu")) {
                    vec![jeu]
                } else {
                    Vec::new()
                }
            }
        };

        game_values
            .iter()
            .filter_map(|g| self.parse_game_json(g))
            .take(MAX_RESULTS)
            .collect()
    }
}

#[async_trait]
impl GameScraper for ScreenScraper {
    fn name(&self) -> &str {
        "screenscraper"
    }

    fn source_type(&self) -> ScrapeSource {
        ScrapeSource::ScreenScraper
    }

    fn priority(&self) -> u32 {
        self.priority
    }

    async fn search_by_name(
        &self,
        query: &str,
        platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        let mut params: Vec<(&str, String)> = vec![("recherche", query.to_string())];
        if let Some(plat) = platform {
            if let Some(ss_id) = platform_to_screenscraper_id(plat) {
                params.push(("systemeid", ss_id.to_string()));
            }
        }

        let params_refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let root = self.api_get("jeuRecherche.php", &params_refs).await?;
        Ok(self.extract_game_list(&root))
    }

    async fn search_by_hash(
        &self,
        hash: &str,
        hash_type: HashType,
        _platform: Option<&str>,
    ) -> Result<Vec<Game>> {
        let param_key = match hash_type {
            HashType::Crc32 => "crc",
            HashType::Md5 => "md5",
            HashType::Sha1 => "sha1",
        };

        let root = self
            .api_get("jeuInfos.php", &[(param_key, hash)])
            .await?;

        let games = self.extract_game_list(&root);
        if games.is_empty() {
            return Ok(Vec::new());
        }
        Ok(games)
    }

    async fn get_game_detail(&self, game_id: &str) -> Result<Game> {
        let root = self
            .api_get("jeuInfos.php", &[("jeuid", game_id)])
            .await?;

        let mut games = self.extract_game_list(&root);
        games.pop().ok_or_else(|| {
            Error::Source(format!("Game detail not found for id: {}", game_id))
        })
    }
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            other => format!(
                "%{:02X}",
                other as u32
            ),
        })
        .collect()
}

fn platform_id_to_short(ss_id: &str) -> String {
    match ss_id {
        "1" => "unknown",
        "2" => "cpc",
        "3" => "nes",
        "4" => "snes",
        "5" => "n64",
        "6" => "mastersystem",
        "7" => "megadrive",
        "8" => "saturn",
        "9" => "psx",
        "10" => "gamegear",
        "11" => "dreamcast",
        "12" => "ngpc",
        "13" => "gb",
        "14" => "gbc",
        "15" => "gba",
        "16" => "nds",
        "17" => "ps2",
        "18" => "psp",
        "19" => "wii",
        "20" => "ps3",
        "21" => "xbox",
        "22" => "xbox360",
        "23" => "atari2600",
        "24" => "atari7800",
        "25" => "neogeo",
        "26" => "colecovision",
        "27" => "intellivision",
        "28" => "lynx",
        "29" => "jaguar",
        "30" => "pcengine",
        "31" => "fds",
        "32" => "vectrex",
        "33" => "c64",
        "34" => "zxspectrum",
        "35" => "amiga",
        "36" => "dos",
        "37" => "windows",
        "75" => "arcade",
        "112" => "wiiu",
        "132" => "ps4",
        "133" => "xboxone",
        "138" => "switch",
        "195" => "ps5",
        _ => ss_id,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_mapping_nes() {
        assert_eq!(platform_to_screenscraper_id("nes"), Some(3));
        assert_eq!(platform_to_screenscraper_id("NES"), Some(3));
        assert_eq!(platform_to_screenscraper_id("Nintendo Entertainment System"), Some(3));
    }

    #[test]
    fn test_platform_mapping_snes() {
        assert_eq!(platform_to_screenscraper_id("snes"), Some(4));
        assert_eq!(platform_to_screenscraper_id("Super Nintendo"), Some(4));
    }

    #[test]
    fn test_platform_mapping_genesis() {
        assert_eq!(platform_to_screenscraper_id("genesis"), Some(7));
        assert_eq!(platform_to_screenscraper_id("megadrive"), Some(7));
    }

    #[test]
    fn test_platform_mapping_mame() {
        assert_eq!(platform_to_screenscraper_id("mame"), Some(75));
        assert_eq!(platform_to_screenscraper_id("arcade"), Some(75));
        assert_eq!(platform_to_screenscraper_id("fbneo"), Some(75));
    }

    #[test]
    fn test_platform_mapping_unknown() {
        assert_eq!(platform_to_screenscraper_id("nonexistent_platform"), None);
    }

    #[test]
    fn test_platform_id_to_short() {
        assert_eq!(platform_id_to_short("3"), "nes");
        assert_eq!(platform_id_to_short("4"), "snes");
        assert_eq!(platform_id_to_short("75"), "arcade");
        assert_eq!(platform_id_to_short("999"), "999");
    }

    #[test]
    fn test_urlencode_basic() {
        assert_eq!(urlencode("hello"), "hello");
        assert_eq!(urlencode("test space"), "test+space");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }
}

pub fn platform_to_screenscraper_id(platform: &str) -> Option<u32> {
    let p = platform.to_lowercase().replace(' ', "");
    match p.as_str() {
        "nes" | "nintendoentertainmentsystem" | "famicom" | "fds" => Some(3),
        "snes" | "supernintendo" | "superfamicom" | "sfc" => Some(4),
        "n64" | "nintendo64" => Some(5),
        "genesis" | "megadrive" | "megadrive-genesis" => Some(7),
        "psx" | "ps1" | "playstation" | "sonyplaystation" => Some(9),
        "gba" | "gameboyadvance" => Some(15),
        "gb" | "gameboy" => Some(13),
        "gbc" | "gameboycolor" => Some(14),
        "nds" | "nintendods" => Some(16),
        "ps2" | "playstation2" => Some(17),
        "psp" | "playstationportable" => Some(18),
        "dreamcast" | "segadreamcast" => Some(11),
        "saturn" | "segasaturn" => Some(8),
        "mastersystem" | "segamastersystem" => Some(6),
        "gamegear" | "segagamegear" => Some(10),
        "ngpc" | "neogeopocket" | "neogeopocketcolor" => Some(12),
        "wii" | "nintendowii" => Some(19),
        "wiiu" | "nintendowiiu" => Some(112),
        "switch" | "nintendoswitch" => Some(138),
        "ps3" | "playstation3" => Some(20),
        "ps4" | "playstation4" => Some(132),
        "ps5" | "playstation5" => Some(195),
        "xbox" | "xboxclassic" => Some(21),
        "xbox360" => Some(22),
        "xboxone" => Some(133),
        "pcengine" | "pce" | "turbografx16" | "tg16" | "turbografx" => Some(30),
        "atari2600" => Some(23),
        "atari7800" => Some(24),
        "atarilynx" | "lynx" => Some(28),
        "jaguar" | "atarijaguar" => Some(29),
        "neogeoaes" | "neogeo" | "aes" | "mvs" => Some(25),
        "mame" | "arcade" | "fbneo" | "fba" | "finalburn" | "finalburnneo" => Some(75),
        "c64" | "commodore64" | "cbm64" => Some(33),
        "amiga" | "commodoreamiga" => Some(35),
        "zxspectrum" | "spectrum" | "sinclairzxspectrum" => Some(34),
        "dos" | "msdos" | "pcdos" => Some(36),
        "windows" | "pc" => Some(37),
        _ => None,
    }
}
