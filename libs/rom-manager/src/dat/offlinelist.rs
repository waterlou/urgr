use std::io::{BufRead, BufReader};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::Result;
use crate::models::{ParsedGame, ParsedRom, ParseStats};

/// Parse an OfflineList XML DAT (used by No-Intro nointro.free.fr).
///
/// Format:
/// ```xml
/// <dat>
///   <configuration>
///     <datName>Official No-Intro Nintendo Gameboy</datName>
///     <system>Nintendo - Game Boy</system>
///   </configuration>
///   <games>
///     <game>
///       <title>Game Name</title>
///       <romSize>131072</romSize>
///       <publisher>Publisher</publisher>
///       <files><romCRC extension=".gb">B61CD120</romCRC></files>
///     </game>
///   </games>
/// </dat>
/// ```
pub fn parse_offlinelist_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let file = std::fs::File::open(path.as_ref())?;
    let reader = BufReader::new(file);
    parse_offlinelist_reader(reader)
}

pub fn parse_offlinelist_reader<R: BufRead>(reader: R) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut games = Vec::new();
    let mut errors = Vec::new();
    let mut system = String::new();
    let mut in_configuration = false;
    let mut in_games = false;
    let mut current_element = String::new();

    // State for the current game being parsed
    let mut in_game = false;
    let mut in_files = false;
    let mut title = String::new();
    let mut publisher = String::new();
    let mut rom_size_str = String::new();
    let mut current_crc_ext = String::new();
    let mut current_roms = Vec::new();

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match tag.as_str() {
                    "configuration" => in_configuration = true,
                    "system" if in_configuration => current_element = tag,
                    "games" => in_games = true,
                    "game" if in_games => {
                        in_game = true;
                        in_files = false;
                        title.clear();
                        publisher.clear();
                        rom_size_str.clear();
                        current_roms.clear();
                    }
                    "files" if in_game => in_files = true,
                    "romCRC" if in_files => {
                        let ext = e
                            .attributes()
                            .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"extension"))
                            .and_then(|a| a.ok())
                            .and_then(|a| a.unescape_value().ok())
                            .map(|v| v.to_string())
                            .unwrap_or_default();
                        current_crc_ext = ext;
                        current_element = tag;
                    }
                    "title" | "publisher" | "romSize" if in_game => {
                        current_element = tag;
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                let text = t.unescape().unwrap_or_default().to_string();
                match current_element.as_str() {
                    "system" if in_configuration => system = text,
                    "title" if in_game => title = text,
                    "publisher" if in_game => publisher = text,
                    "romSize" if in_game => rom_size_str = text,
                    "romCRC" if in_files => {
                        let crc = text.trim();
                        if !crc.is_empty() && crc != "00000000" {
                            let filename = format!("{}{}", sanitize_name(&title), current_crc_ext);
                            current_roms.push(ParsedRom {
                                filename,
                                size: rom_size_str.parse().ok(),
                                crc32: Some(crc.to_uppercase()),
                                md5: None,
                                sha1: None,
                                status: "good".to_string(),
                                merge_target: None,
                            });
                        }
                    }
                    _ => {}
                }
                current_element.clear();
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match tag.as_str() {
                    "configuration" => in_configuration = false,
                    "games" => in_games = false,
                    "game" if in_game => {
                        let game = ParsedGame {
                            name: sanitize_name(&title),
                            description: title.clone(),
                            year: None,
                            manufacturer: if publisher.is_empty() { None } else { Some(publisher.clone()) },
                            cloneof: None,
                            romof: None,
                            sampleof: None,
                            platform: system.clone(),
                            isbios: false,
                            isdevice: false,
                            runnable: Some(true),
                            driver_status: None,
                            driver_emulation: None,
                            roms: std::mem::take(&mut current_roms),
                        };
                        games.push(game);
                        in_game = false;
                        in_files = false;
                        current_element.clear();
                    }
                    "files" => {
                        in_files = false;
                        current_element.clear();
                    }
                    "title" | "publisher" | "romSize" | "system" => {
                        current_element.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if tag == "romCRC" && in_files {
                    let ext = e
                        .attributes()
                        .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"extension"))
                        .and_then(|a| a.ok())
                        .and_then(|a| a.unescape_value().ok())
                        .map(|v| v.to_string())
                        .unwrap_or_default();
                    let crc = e
                        .attributes()
                        .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"crc"))
                        .and_then(|a| a.ok())
                        .and_then(|a| a.unescape_value().ok())
                        .map(|v| v.to_string())
                        .unwrap_or_default();
                    if !crc.is_empty() && crc != "00000000" {
                        let filename = format!("{}{}", sanitize_name(&title), ext);
                        current_roms.push(ParsedRom {
                            filename,
                            size: rom_size_str.parse().ok(),
                            crc32: Some(crc.to_uppercase()),
                            md5: None,
                            sha1: None,
                            status: "good".to_string(),
                            merge_target: None,
                        });
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                errors.push(format!("XML error: {}", e));
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    let stats = ParseStats {
        total_games: games.len(),
        total_roms: games.iter().map(|g| g.roms.len()).sum(),
        errors,
    };

    Ok((games, stats))
}

/// Sanitize a game title into a valid filename:
/// replace characters that are invalid in filenames with underscores.
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_offlinelist_basic() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<dat>
  <configuration>
    <datName>Official No-Intro Nintendo Gameboy</datName>
    <system>Nintendo - Game Boy</system>
  </configuration>
  <games>
    <game>
      <title>Game One</title>
      <romSize>131072</romSize>
      <publisher>Publisher A</publisher>
      <files>
        <romCRC extension=".gb">B61CD120</romCRC>
      </files>
    </game>
    <game>
      <title>Game Two</title>
      <romSize>65536</romSize>
      <publisher>Publisher B</publisher>
      <files>
        <romCRC extension=".gb">CAFE0D2B</romCRC>
      </files>
    </game>
  </games>
</dat>"#;

        let (games, stats) = parse_offlinelist_reader(std::io::Cursor::new(xml.as_bytes())).unwrap();
        assert_eq!(stats.total_games, 2);
        assert_eq!(stats.total_roms, 2);
        assert!(stats.errors.is_empty());

        assert_eq!(games[0].name, "Game One");
        assert_eq!(games[0].description, "Game One");
        assert_eq!(games[0].manufacturer.as_deref(), Some("Publisher A"));
        assert_eq!(games[0].platform, "Nintendo - Game Boy");
        assert!(games[0].cloneof.is_none());

        assert_eq!(games[0].roms[0].filename, "Game One.gb");
        assert_eq!(games[0].roms[0].size, Some(131072));
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("B61CD120"));
        assert!(games[0].roms[0].md5.is_none());
        assert!(games[0].roms[0].sha1.is_none());

        assert_eq!(games[1].name, "Game Two");
        assert_eq!(games[1].roms[0].filename, "Game Two.gb");
        assert_eq!(games[1].roms[0].crc32.as_deref(), Some("CAFE0D2B"));
    }

    #[test]
    fn test_offlinelist_sanitize_name() {
        assert_eq!(sanitize_name("Game: One"), "Game_ One");
        assert_eq!(sanitize_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_name("normal name"), "normal name");
    }

    #[test]
    fn test_offlinelist_multiple_extensions() {
        let xml = r#"<?xml version="1.0"?>
<dat>
  <configuration><system>Test</system></configuration>
  <games>
    <game>
      <title>Multi</title>
      <files>
        <romCRC extension=".gba">AAAAAAAA</romCRC>
        <romCRC extension=".bin">BBBBBBBB</romCRC>
      </files>
    </game>
  </games>
</dat>"#;

        let (games, _stats) = parse_offlinelist_reader(std::io::Cursor::new(xml.as_bytes())).unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].roms.len(), 2);
        assert_eq!(games[0].roms[0].filename, "Multi.gba");
        assert_eq!(games[0].roms[1].filename, "Multi.bin");
    }
}
