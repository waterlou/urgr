use std::io::{BufRead, BufReader};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{Error, Result};
use crate::models::{GameEntry, ParseStats, RomEntry};

pub fn parse_mame_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<GameEntry>, Vec<RomEntry>, ParseStats)> {
    let file = std::fs::File::open(path.as_ref())?;
    let reader = BufReader::new(file);
    parse_mame_reader(reader)
}

pub fn parse_mame_reader<R: BufRead>(reader: R) -> Result<(Vec<GameEntry>, Vec<RomEntry>, ParseStats)> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut games = Vec::new();
    let mut all_roms = Vec::new();
    let mut errors = Vec::new();

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) if e.name().as_ref() == b"machine" => {
                let name = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"name"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok())
                    .unwrap_or_default();

                let cloneof = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"cloneof"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok());

                let romof = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"romof"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok());

                match parse_machine(&mut xml, &name, cloneof.as_deref(), romof.as_deref()) {
                    Ok((game, roms)) => {
                        let game_id = games.len() as i64;
                        let game_entry = GameEntry {
                            id: game_id,
                            version_id: 0,
                            name: game.0,
                            description: game.1,
                            year: game.2,
                            manufacturer: game.3,
                            cloneof: game.4,
                        };
                        let rom_entries: Vec<RomEntry> = roms
                            .into_iter()
                            .map(|r| RomEntry {
                                id: 0,
                                game_entry_id: game_id,
                                filename: r.0,
                                size: r.1,
                                crc32: r.2,
                                md5: r.3,
                                sha1: r.4,
                                status: r.5.unwrap_or_else(|| "good".to_string()),
                                merge_target: r.6,
                            })
                            .collect();
                        all_roms.extend(rom_entries);
                        games.push(game_entry);
                    }
                    Err(e) => {
                        errors.push(format!("{}: {}", name, e));
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
        total_roms: all_roms.len(),
        errors,
    };

    Ok((games, all_roms, stats))
}

type MachineData = (String, String, Option<String>, Option<String>, Option<String>);
type RomRecord = (String, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

fn parse_machine<R: BufRead>(
    xml: &mut Reader<R>,
    name: &str,
    cloneof: Option<&str>,
    _romof: Option<&str>,
) -> Result<(MachineData, Vec<RomRecord>)> {
    let mut description = String::new();
    let mut year: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    let mut roms: Vec<RomRecord> = Vec::new();
    let mut depth = 1;
    let mut buf = Vec::new();

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                match e.name().as_ref() {
                    b"description" => {
                        if let Ok(Event::Text(t)) = xml.read_event_into(&mut Vec::new()) {
                            description = t.unescape().unwrap_or_default().to_string();
                        }
                    }
                    b"year" => {
                        if let Ok(Event::Text(t)) = xml.read_event_into(&mut Vec::new()) {
                            year = Some(t.unescape().unwrap_or_default().to_string());
                        }
                    }
                    b"manufacturer" => {
                        if let Ok(Event::Text(t)) = xml.read_event_into(&mut Vec::new()) {
                            manufacturer = Some(t.unescape().unwrap_or_default().to_string());
                        }
                    }
                    b"rom" => {
                        parse_rom_attrs(e, &mut roms);
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => match e.name().as_ref() {
                b"rom" => {
                    parse_rom_attrs(e, &mut roms);
                }
                _ => {}
            },
            Ok(Event::End(ref e)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
                if e.name().as_ref() == b"description"
                    || e.name().as_ref() == b"year"
                    || e.name().as_ref() == b"manufacturer"
                {
                    // Text already consumed, nothing to do
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xml(format!("Parse error: {}", e))),
            _ => {}
        }
        buf.clear();
    }

    Ok((
        (
            name.to_string(),
            description,
            year,
            manufacturer,
            cloneof.map(|s| s.to_string()),
        ),
        roms,
    ))
}

fn parse_rom_attrs(e: &quick_xml::events::BytesStart<'_>, roms: &mut Vec<RomRecord>) {
    let mut rom_name = String::new();
    let mut size: Option<i64> = None;
    let mut crc: Option<String> = None;
    let mut md5: Option<String> = None;
    let mut sha1: Option<String> = None;
    let mut status: Option<String> = None;
    let mut merge: Option<String> = None;

    for attr in e.attributes() {
        if let Ok(a) = attr {
            let val = a.unescape_value().unwrap_or_default().to_string();
            match a.key.as_ref() {
                b"name" => rom_name = val,
                b"size" => size = val.parse().ok(),
                b"crc" => {
                    if !val.is_empty() && val != "0" && val != "00000000" {
                        crc = Some(val.to_uppercase());
                    }
                }
                b"md5" => {
                    if !val.is_empty() {
                        md5 = Some(val.to_uppercase());
                    }
                }
                b"sha1" => {
                    if !val.is_empty() {
                        sha1 = Some(val.to_uppercase());
                    }
                }
                b"status" => status = Some(val),
                b"merge" => merge = Some(val),
                _ => {}
            }
        }
    }

    if !rom_name.is_empty() {
        roms.push((rom_name, size, crc, md5, sha1, status, merge));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(xml: &str) -> (Vec<GameEntry>, Vec<RomEntry>, ParseStats) {
        parse_mame_reader(std::io::Cursor::new(xml.as_bytes())).expect("mame parse")
    }

    #[test]
    fn test_mame_basic_game() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="sf2">
    <description>Street Fighter II</description>
    <year>1991</year>
    <manufacturer>Capcom</manufacturer>
    <rom name="sf2.03" size="524288" crc="3f47a0d8" sha1="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/>
  </machine>
</mame>"#;

        let (games, roms, stats) = parse(xml);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].name, "sf2");
        assert_eq!(games[0].description, "Street Fighter II");
        assert_eq!(games[0].year.as_deref(), Some("1991"));
        assert_eq!(games[0].manufacturer.as_deref(), Some("Capcom"));
        assert!(games[0].cloneof.is_none());
        assert_eq!(roms[0].filename, "sf2.03");
        assert_eq!(roms[0].size, Some(524288));
        assert_eq!(roms[0].crc32.as_deref(), Some("3F47A0D8"));
        assert_eq!(roms[0].sha1.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn test_mame_cloneof() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="sf2j" cloneof="sf2" romof="sf2">
    <description>Street Fighter II (Japan)</description>
    <year>1991</year>
    <manufacturer>Capcom</manufacturer>
  </machine>
</mame>"#;

        let (games, _, _) = parse(xml);
        assert_eq!(games[0].cloneof.as_deref(), Some("sf2"));
    }

    #[test]
    fn test_mame_rom_attributes() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="test">
    <description>Test</description>
    <rom name="r1" size="512" crc="abcd1234" md5="d41d8cd98f00b204e9800998ecf8427e" sha1="EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE" status="nodump"/>
    <rom name="r2" size="1024" crc="00000000" merge="t"/>
  </machine>
</mame>"#;

        let (_, roms, _) = parse(xml);
        assert_eq!(roms.len(), 2);

        // First ROM: all attributes present
        assert_eq!(roms[0].filename, "r1");
        assert_eq!(roms[0].sha1.as_deref(), Some("EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"));
        assert_eq!(roms[0].status, "nodump");
        assert!(roms[0].merge_target.is_none());
        assert_eq!(roms[0].crc32.as_deref(), Some("ABCD1234"));

        // Second ROM: crc "00000000" should be treated as empty
        assert_eq!(roms[1].filename, "r2");
        assert!(roms[1].crc32.is_none());
        assert!(roms[1].sha1.is_none());
        assert_eq!(roms[1].merge_target.as_deref(), Some("t"));
        assert_eq!(roms[1].status, "good");
    }

    #[test]
    fn test_mame_missing_description() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="empty">
  </machine>
</mame>"#;

        let (games, _, _) = parse(xml);
        assert_eq!(games[0].description, "");
        assert!(games[0].year.is_none());
    }

    #[test]
    fn test_mame_multiple_machines() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="a"><description>A</description></machine>
  <machine name="b"><description>B</description></machine>
  <machine name="c"><description>C</description></machine>
</mame>"#;

        let (games, _, stats) = parse(xml);
        assert_eq!(games.len(), 3);
        assert_eq!(stats.total_games, 3);
        assert_eq!(games[0].name, "a");
        assert_eq!(games[1].name, "b");
        assert_eq!(games[2].name, "c");
    }

    #[test]
    fn test_mame_empty_xml() {
        let xml = r#"<?xml version="1.0"?>
<mame>
</mame>"#;

        let (games, roms, stats) = parse(xml);
        assert!(games.is_empty());
        assert!(roms.is_empty());
        assert_eq!(stats.total_games, 0);
        assert!(stats.errors.is_empty());
    }
}
