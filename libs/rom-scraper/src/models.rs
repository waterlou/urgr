use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub alternative_titles: Vec<String>,
    pub region_titles: HashMap<String, String>,
    pub platform: Platform,
    pub description: String,
    pub publisher: Option<String>,
    pub developer: Option<String>,
    pub release_date: Option<String>,
    pub genres: Vec<String>,
    pub players: Option<u8>,
    pub rating: Option<f32>,
    pub roms: Vec<RomInfo>,
    pub media: Media,
    pub source: ScrapeSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Platform {
    pub id: String,
    pub name: String,
    pub short_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RomInfo {
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub crc32: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub region: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Media {
    pub screenshots: Vec<MediaItem>,
    pub covers: Vec<MediaItem>,
    pub logos: Vec<MediaItem>,
    pub marquees: Vec<MediaItem>,
    pub fanarts: Vec<MediaItem>,
    pub videos: Vec<MediaItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub url: String,
    pub kind: MediaType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MediaType {
    Screenshot,
    Cover2D,
    Cover3D,
    Logo,
    Marquee,
    Fanart,
    Video,
    Other(String),
}

impl MediaType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "ss" | "screenshot" => Self::Screenshot,
            "box-2D" | "box-2d" | "box2D" => Self::Cover2D,
            "box-3D" | "box-3d" | "box3D" => Self::Cover3D,
            "logo" => Self::Logo,
            "marquee" | "wheel" => Self::Marquee,
            "fanart" | "support" => Self::Fanart,
            "video" => Self::Video,
            other => Self::Other(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ScrapeSource {
    ScreenScraper,
    TheGamesDb,
    Igdb,
    Local,
    NoIntroPictures,
    SonyStore,
    Vgmuseum,
    ArcadeDb,
    LibretroThumbnails,
    MobyGames,
    RetroAchievements,
    SteamGridDB,
}

impl std::fmt::Display for ScrapeSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScreenScraper => write!(f, "screenscraper"),
            Self::TheGamesDb => write!(f, "thegamesdb"),
            Self::Igdb => write!(f, "igdb"),
            Self::Local => write!(f, "local"),
            Self::NoIntroPictures => write!(f, "no-intro-pictures"),
            Self::SonyStore => write!(f, "sony-store"),
            Self::Vgmuseum => write!(f, "vgmuseum"),
            Self::ArcadeDb => write!(f, "arcadedb"),
            Self::LibretroThumbnails => write!(f, "libretro-thumbnails"),
            Self::MobyGames => write!(f, "mobygames"),
            Self::RetroAchievements => write!(f, "retroachievements"),
            Self::SteamGridDB => write!(f, "steamgriddb"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HashType {
    Crc32,
    Md5,
    Sha1,
}

impl HashType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "crc32" | "crc" => Some(Self::Crc32),
            "md5" => Some(Self::Md5),
            "sha1" => Some(Self::Sha1),
            _ => None,
        }
    }
}

impl std::fmt::Display for HashType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Crc32 => write!(f, "crc32"),
            Self::Md5 => write!(f, "md5"),
            Self::Sha1 => write!(f, "sha1"),
        }
    }
}
