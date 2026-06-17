pub mod dat;
pub mod db;
pub mod error;
pub mod models;
pub mod scanner;
pub mod verifier;
pub mod builder;

pub use db::Database;
pub use error::{Error, Result};
pub use models::*;
pub use db::NpsGame;
pub use db::NpsRom;
pub use scanner::{scan_directory, scan_nps_directory, extract_title_id, ScanMatch};
pub use verifier::verify_version;
pub use builder::{build_version, compute_game_roms, explain_missing_from_dir, read_zip_crc_by_filename, scan_samples, BuildProgress, BuildResult};
pub use models::{MissingGame, MissingReason, RomDetail, SampleResult};
