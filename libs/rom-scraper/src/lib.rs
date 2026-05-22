pub mod client;
pub mod config;
pub mod error;
pub mod hasher;
pub mod matcher;
pub mod models;
pub mod sources;

pub use client::HttpClient;
pub use config::Config;
pub use error::{Error, Result};
pub use hasher::{compute_hashes, compute_hashes_from_bytes, RomHashes};
pub use matcher::{match_rom_by_hashes, match_rom_by_path, parse_filename, FilenameInfo};
pub use models::{
    Game, HashType, Media, MediaItem, MediaType, Platform, RomInfo, ScrapeSource,
};
pub use sources::{GameScraper, ScraperRegistry, ScreenScraper};
