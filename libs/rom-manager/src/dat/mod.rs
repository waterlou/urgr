mod clrmamepro;
mod logiqx;
mod mame;
mod offlinelist;
pub mod write;

use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::error::Result;
use crate::models::{DatFormat, ParsedGame, ParseStats};

pub use clrmamepro::parse_clrmamepro_dat;
pub use logiqx::parse_logiqx_dat;
pub use mame::parse_mame_dat;
pub use offlinelist::parse_offlinelist_dat;

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

    let first = read_nonblank_line(&mut reader)?;
    if first.is_empty() {
        return Err(crate::error::Error::Parse(format!(
            "Empty file: {}",
            path.as_ref().display()
        )));
    }

    // If the file starts with <?xml, skip it and scan up to 10 lines for the root element
    let check_lines: Vec<String> = if first.trim_start().starts_with("<?xml") {
        let mut lines = Vec::new();
        for _ in 0..10 {
            match read_nonblank_line(&mut reader) {
                Ok(l) if !l.is_empty() => lines.push(l),
                _ => break,
            }
        }
        lines
    } else {
        vec![first]
    };

    for line in &check_lines {
        if line.contains("<mame") || line.contains("DOCTYPE mame") {
            return Ok(DatFormat::MameListXml);
        }
        if line.contains("<datafile") || line.contains("DOCTYPE datafile") {
            return Ok(DatFormat::Logiqx);
        }
        if line.to_lowercase().contains("clrmamepro") {
            return Ok(DatFormat::ClrmamePro);
        }
        if line.contains("<dat") {
            return Ok(DatFormat::OfflineList);
        }
    }

    Err(crate::error::Error::Parse(format!(
        "Unknown DAT format: {}",
        path.as_ref().display()
    )))
}

pub fn parse_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let fmt = detect_format(&path)?;
    match fmt {
        DatFormat::MameListXml => parse_mame_dat(path),
        DatFormat::Logiqx => parse_logiqx_dat(path),
        DatFormat::ClrmamePro => parse_clrmamepro_dat(path),
        DatFormat::OfflineList => parse_offlinelist_dat(path),
    }
}
