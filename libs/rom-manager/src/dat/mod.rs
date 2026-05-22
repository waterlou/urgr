mod logiqx;
mod mame;

use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::error::Result;
use crate::models::{DatFormat, GameEntry, ParseStats, RomEntry};

pub use logiqx::parse_logiqx_dat;
pub use mame::parse_mame_dat;

fn read_nonblank_line(reader: &mut BufReader<std::fs::File>) -> std::io::Result<String> {
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(line);
        }
        if !line.trim().is_empty() {
            return Ok(line);
        }
    }
}

pub fn detect_format<P: AsRef<Path>>(path: P) -> Result<DatFormat> {
    let file = std::fs::File::open(path.as_ref())?;
    let mut reader = BufReader::new(file);

    // Read first non-blank line
    let first = read_nonblank_line(&mut reader)?;
    if first.is_empty() {
        return Err(crate::error::Error::Parse(format!(
            "Empty file: {}",
            path.as_ref().display()
        )));
    }

    // If first non-blank is an XML declaration, skip it
    let check_line = if first.trim_start().starts_with("<?xml") {
        read_nonblank_line(&mut reader)?
    } else {
        first
    };

    if check_line.contains("<mame") {
        Ok(DatFormat::MameListXml)
    } else if check_line.contains("<datafile") {
        Ok(DatFormat::Logiqx)
    } else {
        // DOCTYPE lines contain "datafile" without angle brackets — read next
        let third = read_nonblank_line(&mut reader)?;
        if third.contains("<datafile") || third.contains("<mame") {
            if third.contains("<mame") {
                Ok(DatFormat::MameListXml)
            } else {
                Ok(DatFormat::Logiqx)
            }
        } else {
            Err(crate::error::Error::Parse(format!(
                "Unknown DAT format: {}",
                path.as_ref().display()
            )))
        }
    }
}

pub fn parse_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<GameEntry>, Vec<RomEntry>, ParseStats)> {
    let fmt = detect_format(&path)?;
    match fmt {
        DatFormat::MameListXml => parse_mame_dat(path),
        DatFormat::Logiqx => parse_logiqx_dat(path),
    }
}
