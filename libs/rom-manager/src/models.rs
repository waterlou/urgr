use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct SetVersion {
    pub id: i64,
    pub source: String,
    pub version: String,
    pub dir: Option<String>,
    pub total_games: i64,
    pub total_roms: i64,
}

#[derive(Debug, Clone)]
pub struct Game {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub year: Option<String>,
    pub manufacturer: Option<String>,
    pub platform: String,
    pub parent_game_id: Option<i64>,
    pub synopsis: String,
}

#[derive(Debug, Clone)]
pub struct GameRomSet {
    pub id: i64,
    pub game_id: i64,
    pub version_id: i64,
    pub romof: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct RomFile {
    pub id: i64,
    pub rom_set_id: i64,
    pub filename: String,
    pub size: Option<i64>,
    pub crc32: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub status: String,
    pub merge_target: Option<String>,
}

/// Temporary struct used during DAT parsing (before DB insertion)
#[derive(Debug, Clone)]
pub struct ParsedGame {
    pub name: String,
    pub description: String,
    pub year: Option<String>,
    pub manufacturer: Option<String>,
    pub cloneof: Option<String>,
    pub romof: Option<String>,
    /// Platform name from the DAT (e.g. "Nintendo - Game Boy" from OfflineList
    /// `<configuration><system>` or set by the importer for FBNeo per-manufacturer dats).
    pub platform: String,
    pub roms: Vec<ParsedRom>,
}

#[derive(Debug, Clone)]
pub struct ParsedRom {
    pub filename: String,
    pub size: Option<i64>,
    pub crc32: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub status: String,
    pub merge_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatFormat {
    MameListXml,
    Logiqx,
    ClrmamePro,
    OfflineList,
}

#[derive(Debug, Clone)]
pub struct ParseStats {
    pub total_games: usize,
    pub total_roms: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct VersionDiff {
    pub version_a: String,
    pub version_b: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub unchanged: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingGame {
    pub name: String,
    pub reason: MissingReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MissingReason {
    FileNotFound,
    CrcMismatch { matched: usize, expected: usize },
}

/// Temporary struct for NPS import (games without a DAT)
#[derive(Debug, Clone, serde::Serialize)]
pub struct NpsGame {
    pub id: i64,
    pub name: String,
    pub title_id: Option<String>,
    pub content_id: Option<String>,
    pub platform: Option<String>,
    pub roms: Vec<NpsRom>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NpsRom {
    pub id: i64,
    pub filename: String,
    pub subtype: String,
    pub size: Option<i64>,
    pub sha1: Option<String>,
}
