use std::io::{BufRead, BufReader};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{Error, Result};
use crate::models::{GameEntry, ParseStats, RomEntry};

pub fn parse_logiqx_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<GameEntry>, Vec<RomEntry>, ParseStats)> {
    let file = std::fs::File::open(path.as_ref())?;
    let reader = BufReader::new(file);
    parse_logiqx_reader(reader)
}

pub fn parse_logiqx_reader<R: BufRead>(reader: R) -> Result<(Vec<GameEntry>, Vec<RomEntry>, ParseStats)> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut games = Vec::new();
    let mut all_roms = Vec::new();
    let mut errors = Vec::new();

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) if e.name().as_ref() == b"game" || e.name().as_ref() == b"machine" => {
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

                match parse_game(&mut xml, &name, cloneof.as_deref()) {
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
                            platform: String::new(),
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

type GameData = (String, String, Option<String>, Option<String>, Option<String>);
type RomRecord = (String, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

fn parse_game<R: BufRead>(
    xml: &mut Reader<R>,
    name: &str,
    cloneof: Option<&str>,
) -> Result<(GameData, Vec<RomRecord>)> {
    let mut description = String::new();
    let mut year: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    let mut roms: Vec<RomRecord> = Vec::new();
    let mut depth = 1;

    loop {
        let mut buf = Vec::new();
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
                    b"manufacturer" | b"publisher" => {
                        if let Ok(Event::Text(t)) = xml.read_event_into(&mut Vec::new()) {
                            manufacturer = Some(t.unescape().unwrap_or_default().to_string());
                        }
                    }
                    b"rom" => {
                        parse_rom_attrs(e, &mut roms);
                    }
                    b"disk" => {}
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => match e.name().as_ref() {
                b"rom" => parse_rom_attrs(e, &mut roms),
                b"disk" => {}
                _ => {}
            },
            Ok(Event::End(ref _e)) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xml(format!("Parse error: {}", e))),
            _ => {}
        }
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
                b"crc" | b"crc32" => {
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
                b"status" => {
                    status = Some(val.to_lowercase());
                }
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
    use std::time::Instant;

    fn parse(xml: &str) -> (Vec<GameEntry>, Vec<RomEntry>, ParseStats) {
        parse_logiqx_reader(std::io::Cursor::new(xml.as_bytes())).expect("logiqx parse")
    }

    fn generate_logiqx_xml(num_games: usize) -> String {
        let mut xml = String::with_capacity(num_games * 200);
        xml.push_str(r#"<?xml version="1.0"?><datafile>"#);
        for i in 0..num_games {
            xml.push_str(&format!(
                r#"<game name="g{i}"><description>Game {i}</description><year>199{i}0</year><publisher>TestCorp</publisher><rom name="r{i}.bin" size="524288" crc="{crc:08X}" sha1="{sha1}"/></game>"#,
                i = i,
                crc = (i as u32).wrapping_mul(0x9E3779B9),
                sha1 = format!("{:040X}", i.wrapping_mul(0x9E3779B9)),
            ));
        }
        xml.push_str(r#"</datafile>"#);
        xml
    }

    #[test]
    fn test_logiqx_perf_1k() { perf_logiqx(1_000); }
    #[test]
    fn test_logiqx_perf_10k() { perf_logiqx(10_000); }
    #[test]
    fn test_logiqx_perf_50k() { perf_logiqx(50_000); }

    fn perf_logiqx(num_games: usize) {
        let xml = generate_logiqx_xml(num_games);
        let xml_size = xml.len();
        let start = Instant::now();
        let (games, roms, stats) = parse(&xml);
        let elapsed = start.elapsed();

        let games_per_sec = num_games as f64 / elapsed.as_secs_f64();
        let mb_per_sec = (xml_size as f64 / 1_048_576.0) / elapsed.as_secs_f64();

        eprintln!(
            "  Logiqx perf: {} games, {} ROMs, {:.2} MB XML, {:.2}s, {:.0} games/s, {:.1} MB/s",
            stats.total_games,
            stats.total_roms,
            xml_size as f64 / 1_048_576.0,
            elapsed.as_secs_f64(),
            games_per_sec,
            mb_per_sec,
        );

        assert_eq!(games.len(), num_games);
        assert_eq!(roms.len(), num_games);
        assert!(stats.errors.is_empty());
        // Parse should be faster than 10µs per game for large datasets
        let max_allowed = (num_games as u128) * 10_000; // 10µs per game = 100K games/s
        assert!(
            elapsed.as_micros() < max_allowed,
            "Parse took {}µs (limit was {}µs for {} games)",
            elapsed.as_micros(), max_allowed, num_games
        );
    }

    #[test]
    fn test_logiqx_basic_game() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <header><name>FB Neo</name><version>1.0.0.29</version></header>
  <game name="sf2">
    <description>Street Fighter II (World 910214)</description>
    <year>1991</year>
    <publisher>Capcom</publisher>
    <rom name="sf2.03" size="524288" crc="3f47a0d8" sha1="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/>
  </game>
</datafile>"#;

        let (games, roms, stats) = parse(xml);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].name, "sf2");
        assert_eq!(games[0].description, "Street Fighter II (World 910214)");
        assert_eq!(games[0].year.as_deref(), Some("1991"));
        assert_eq!(games[0].manufacturer.as_deref(), Some("Capcom"));
        assert!(games[0].cloneof.is_none());
        assert_eq!(roms[0].filename, "sf2.03");
        assert_eq!(roms[0].size, Some(524288));
        assert_eq!(roms[0].crc32.as_deref(), Some("3F47A0D8"));
        assert_eq!(roms[0].sha1.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn test_logiqx_cloneof() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="sf2j" cloneof="sf2">
    <description>Street Fighter II (Japan 910214)</description>
    <year>1991</year>
    <publisher>Capcom</publisher>
  </game>
</datafile>"#;

        let (games, _, _) = parse(xml);
        assert_eq!(games[0].cloneof.as_deref(), Some("sf2"));
    }

    #[test]
    fn test_logiqx_manufacturer_vs_publisher() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="test">
    <description>Test</description>
    <manufacturer>Atari</manufacturer>
  </game>
</datafile>"#;

        let (games, _, _) = parse(xml);
        assert_eq!(games[0].manufacturer.as_deref(), Some("Atari"));
    }

    #[test]
    fn test_logiqx_rom_with_crc32() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="test">
    <description>Test</description>
    <rom name="rom1" size="2048" crc32="deadbeef" sha1="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/>
  </game>
</datafile>"#;

        let (_, roms, _) = parse(xml);
        assert_eq!(roms[0].crc32.as_deref(), Some("DEADBEEF"));
    }

    #[test]
    fn test_logiqx_disk_skip() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="test">
    <description>Test</description>
    <rom name="r1" size="512" crc="1111" sha1="cccccccccccccccccccccccccccccccccccccccc"/>
    <disk name="d1" sha1="dddddddddddddddddddddddddddddddddddddddd"/>
  </game>
</datafile>"#;

        let (_, roms, stats) = parse(xml);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(roms.len(), 1);
        assert_eq!(roms[0].filename, "r1");
    }

    #[test]
    fn test_logiqx_status_lowercase() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="test">
    <description>Test</description>
    <rom name="r1" size="256" crc="2222" sha1="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" status="baddump"/>
  </game>
</datafile>"#;

        let (_, roms, _) = parse(xml);
        assert_eq!(roms[0].status, "baddump");
    }

    #[test]
    fn test_logiqx_multiple_games() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="a"><description>A</description></game>
  <game name="b"><description>B</description></game>
</datafile>"#;

        let (games, _, stats) = parse(xml);
        assert_eq!(games.len(), 2);
        assert_eq!(stats.total_games, 2);
    }

    #[test]
    fn test_logiqx_empty() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
</datafile>"#;

        let (games, roms, stats) = parse(xml);
        assert!(games.is_empty());
        assert!(roms.is_empty());
        assert_eq!(stats.total_games, 0);
        assert!(stats.errors.is_empty());
    }
}
