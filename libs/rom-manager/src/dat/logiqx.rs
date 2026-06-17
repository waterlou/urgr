use std::io::{BufRead, BufReader};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{Error, Result};
use crate::models::{ParsedGame, ParsedRom, ParseStats};

pub fn parse_logiqx_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let file = std::fs::File::open(path.as_ref())?;
    let reader = BufReader::new(file);
    parse_logiqx_reader(reader)
}

pub fn parse_logiqx_reader<R: BufRead>(reader: R) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut games = Vec::new();
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

                let romof = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"romof"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok());

                let isbios = e
                    .attributes()
                    .any(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"isbios" && a.unescape_value().is_ok_and(|v| v == "yes")));

                let sampleof = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"sampleof"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok());

                match parse_game(&mut xml, &name, cloneof.as_deref(), romof.as_deref(), isbios, sampleof.as_deref()) {
                    Ok(parsed_game) => {
                        games.push(parsed_game);
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
        total_roms: games.iter().map(|g| g.roms.len()).sum(),
        errors,
    };

    Ok((games, stats))
}

fn parse_game<R: BufRead>(
    xml: &mut Reader<R>,
    name: &str,
    cloneof: Option<&str>,
    romof: Option<&str>,
    isbios: bool,
    sampleof: Option<&str>,
) -> Result<ParsedGame> {
    let mut description = String::new();
    let mut year: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    let mut roms = Vec::new();
    let mut depth = 1;

    loop {
        let mut buf = Vec::new();
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                match e.name().as_ref() {
                    b"description" => {
                        let mut text = String::new();
                        loop {
                            match xml.read_event_into(&mut Vec::new()) {
                                Ok(Event::Text(t)) => text.push_str(&t.unescape().unwrap_or_default()),
                                Ok(Event::End(_)) => { depth -= 1; break; }
                                Ok(Event::Eof) => break,
                                _ => {}
                            }
                        }
                        description = text;
                    }
                    b"year" => {
                        let mut text = String::new();
                        loop {
                            match xml.read_event_into(&mut Vec::new()) {
                                Ok(Event::Text(t)) => text.push_str(&t.unescape().unwrap_or_default()),
                                Ok(Event::End(_)) => { depth -= 1; break; }
                                Ok(Event::Eof) => break,
                                _ => {}
                            }
                        }
                        if !text.is_empty() { year = Some(text); }
                    }
                    b"manufacturer" | b"publisher" => {
                        let mut text = String::new();
                        loop {
                            match xml.read_event_into(&mut Vec::new()) {
                                Ok(Event::Text(t)) => text.push_str(&t.unescape().unwrap_or_default()),
                                Ok(Event::End(_)) => { depth -= 1; break; }
                                Ok(Event::Eof) => break,
                                _ => {}
                            }
                        }
                        if !text.is_empty() { manufacturer = Some(text); }
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

    Ok(ParsedGame {
        name: name.to_string(),
        description,
        year,
        manufacturer,
        cloneof: cloneof.map(|s| s.to_string()),
        romof: romof.map(|s| s.to_string()),
        sampleof: sampleof.map(|s| s.to_string()),
        platform: String::new(),
        isbios,
        isdevice: false,
        runnable: Some(true),
        driver_status: None,
        driver_emulation: None,
        roms,
    })
}

fn parse_rom_attrs(e: &quick_xml::events::BytesStart<'_>, roms: &mut Vec<ParsedRom>) {
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
        roms.push(ParsedRom {
            filename: rom_name,
            size,
            crc32: crc,
            md5,
            sha1,
            status: status.unwrap_or_else(|| "good".to_string()),
            merge_target: merge,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn parse(xml: &str) -> (Vec<ParsedGame>, ParseStats) {
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
        let (games, stats) = parse(&xml);
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

        let total_roms: usize = games.iter().map(|g| g.roms.len()).sum();
        assert_eq!(games.len(), num_games);
        assert_eq!(total_roms, num_games);
        assert!(stats.errors.is_empty());
        let max_allowed = (num_games as u128) * 10_000;
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

        let (games, stats) = parse(xml);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].name, "sf2");
        assert_eq!(games[0].description, "Street Fighter II (World 910214)");
        assert_eq!(games[0].year.as_deref(), Some("1991"));
        assert_eq!(games[0].manufacturer.as_deref(), Some("Capcom"));
        assert!(games[0].cloneof.is_none());
        assert_eq!(games[0].roms[0].filename, "sf2.03");
        assert_eq!(games[0].roms[0].size, Some(524288));
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("3F47A0D8"));
        assert_eq!(games[0].roms[0].sha1.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
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

        let (games, _) = parse(xml);
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

        let (games, _) = parse(xml);
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

        let (games, _) = parse(xml);
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("DEADBEEF"));
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

        let (games, stats) = parse(xml);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].roms.len(), 1);
        assert_eq!(games[0].roms[0].filename, "r1");
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

        let (games, _) = parse(xml);
        assert_eq!(games[0].roms[0].status, "baddump");
    }

    #[test]
    fn test_logiqx_multiple_games() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="a"><description>A</description></game>
  <game name="b"><description>B</description></game>
</datafile>"#;

        let (games, stats) = parse(xml);
        assert_eq!(games.len(), 2);
        assert_eq!(stats.total_games, 2);
    }

    #[test]
    fn test_logiqx_empty() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
</datafile>"#;

        let (games, stats) = parse(xml);
        assert!(games.is_empty());
        assert!(games.iter().all(|g| g.roms.is_empty()));
        assert_eq!(stats.total_games, 0);
        assert!(stats.errors.is_empty());
    }
}
