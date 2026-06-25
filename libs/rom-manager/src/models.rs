use std::fmt;
use std::str::FromStr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MergeMode {
    Split,
    Merged,
    NonMerged,
}

impl fmt::Display for MergeMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MergeMode::Split => write!(f, "split"),
            MergeMode::Merged => write!(f, "merged"),
            MergeMode::NonMerged => write!(f, "non-merged"),
        }
    }
}

impl FromStr for MergeMode {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "split" => Ok(MergeMode::Split),
            "merged" | "full" | "full-merged" => Ok(MergeMode::Merged),
            "non-merged" | "nonmerged" | "non_merged" => Ok(MergeMode::NonMerged),
            _ => Err(format!("Unknown merge mode: {}. Use split, merged, or non-merged", s)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SetVersion {
    pub id: i64,
    pub collection_id: i64,
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
    pub isbios: bool,
    pub isdevice: bool,
    pub runnable: Option<bool>,
    pub driver_status: Option<String>,
    pub driver_emulation: Option<String>,
    pub sampleof: Option<String>,
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
    pub subtype: String,
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
    pub sampleof: Option<String>,
    /// Platform name from the DAT (e.g. "Nintendo - Game Boy" from OfflineList
    /// `<configuration><system>` or set by the importer for FBNeo per-manufacturer dats).
    pub platform: String,
    /// Whether this game is a BIOS set (MAME isbios="yes", Logiqx isbios="yes").
    pub isbios: bool,
    /// Whether this machine is a device rather than a playable game (MAME isdevice="yes").
    pub isdevice: bool,
    /// Whether this machine is runnable (MAME runnable="yes"/"no").
    /// Defaults to Some(true) for non-MAME formats.
    pub runnable: Option<bool>,
    /// Driver emulation status (MAME driver status="good/imperfect/preliminary").
    pub driver_status: Option<String>,
    /// Driver emulation quality (MAME driver emulation="good/preliminary").
    pub driver_emulation: Option<String>,
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
pub struct RomDetail {
    pub filename: String,
    pub expected_crc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_crc: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingGame {
    pub name: String,
    pub game_id: i64,
    pub platform: String,
    pub reason: MissingReason,
    #[serde(default)]
    pub rom_details: Vec<RomDetail>,
    #[serde(default)]
    pub sampleof: Option<String>,
    #[serde(default)]
    pub sample_details: Vec<RomDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MissingReason {
    FileNotFound,
    CrcMismatch { matched: usize, expected: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SampleResult {
    #[serde(default)]
    pub samples_found: usize,
    #[serde(default)]
    pub samples_missing: usize,
    #[serde(default)]
    pub missing_samples: Vec<String>,
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
