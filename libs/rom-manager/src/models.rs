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
pub struct GameEntry {
    pub id: i64,
    pub version_id: i64,
    pub name: String,
    pub description: String,
    pub year: Option<String>,
    pub manufacturer: Option<String>,
    pub cloneof: Option<String>,
    pub romof: Option<String>,
    pub platform: String,
    pub region: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RomEntry {
    pub id: i64,
    pub game_entry_id: i64,
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
