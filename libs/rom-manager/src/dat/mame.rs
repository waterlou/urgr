use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{Error, Result};
use crate::models::{ParsedGame, ParsedRom, ParseStats};

/// Helper: parse a "yes"/"no" MAME attribute into an Option<bool>.
fn parse_bool_attr(val: Option<&str>) -> Option<bool> {
    match val {
        Some("yes") => Some(true),
        Some("no") => Some(false),
        _ => None,
    }
}

pub fn parse_mame_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let file = std::fs::File::open(path.as_ref())?;
    let reader = BufReader::new(file);
    parse_mame_reader(reader)
}

pub fn parse_mame_reader<R: BufRead>(reader: R) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut games = Vec::new();
    let mut errors = Vec::new();
    let mut sampleof_refs = HashSet::new();

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(ref e))
                if e.name().as_ref() == b"machine" || e.name().as_ref() == b"game" =>
            {
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

                let sampleof = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"sampleof"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok());

                if let Some(ref s) = sampleof {
                    sampleof_refs.insert(s.to_string());
                }

                let isbios = e
                    .attributes()
                    .any(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"isbios" && a.unescape_value().is_ok_and(|v| v == "yes")));

                let isdevice = e
                    .attributes()
                    .any(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"isdevice" && a.unescape_value().is_ok_and(|v| v == "yes")));

                let runnable = e
                    .attributes()
                    .find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == b"runnable"))
                    .and_then(|a| a.ok())
                    .and_then(|a| a.unescape_value().ok())
                    .and_then(|v| parse_bool_attr(Some(&v)));

                match parse_machine(
                    &mut xml,
                    &name,
                    cloneof.as_deref(),
                    romof.as_deref(),
                    sampleof.as_deref(),
                    isbios,
                    isdevice,
                    runnable,
                ) {
                    Ok(game) => {
                        games.push(game);
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

    // Generate stub entries for sampleof references that don't have a machine
    let game_names: HashSet<String> = games.iter().map(|g| g.name.clone()).collect();
    for ref_name in &sampleof_refs {
        if !game_names.contains(ref_name) {
            games.push(ParsedGame {
                name: ref_name.clone(),
                description: format!("Samples for {}", ref_name),
                year: None,
                manufacturer: None,
                cloneof: None,
                romof: None,
                sampleof: None,
                platform: String::new(),
                isbios: false,
                isdevice: true,
                runnable: None,
                driver_status: None,
                driver_emulation: None,
                roms: Vec::new(),
            });
        }
    }

    let stats = ParseStats {
        total_games: games.len(),
        total_roms: games.iter().map(|g| g.roms.len()).sum(),
        errors,
    };

    Ok((games, stats))
}

fn parse_machine<R: BufRead>(
    xml: &mut Reader<R>,
    name: &str,
    cloneof: Option<&str>,
    romof: Option<&str>,
    sampleof: Option<&str>,
    isbios: bool,
    isdevice: bool,
    runnable: Option<bool>,
) -> Result<ParsedGame> {
    let mut description = String::new();
    let mut year: Option<String> = None;
    let mut manufacturer: Option<String> = None;
    let mut roms = Vec::new();
    let mut driver_status: Option<String> = None;
    let mut driver_emulation: Option<String> = None;
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
                    b"manufacturer" => {
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
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => match e.name().as_ref() {
                b"rom" => {
                    parse_rom_attrs(e, &mut roms);
                }
                b"driver" => {
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            let val = a.unescape_value().unwrap_or_default().to_string();
                            match a.key.as_ref() {
                                b"status" => driver_status = Some(val),
                                b"emulation" => driver_emulation = Some(val),
                                _ => {}
                            }
                        }
                    }
                }
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
        isdevice,
        runnable,
        driver_status,
        driver_emulation,
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
        parse_mame_reader(std::io::Cursor::new(xml.as_bytes())).expect("mame parse")
    }

    fn generate_mame_xml(num_games: usize) -> String {
        let mut xml = String::with_capacity(num_games * 250);
        xml.push_str(r#"<?xml version="1.0"?><mame>"#);
        for i in 0..num_games {
            xml.push_str(&format!(
                r#"<machine name="g{i}" sourcefile="src/g{i}.cpp"><description>Game {i}</description><year>199{i}0</year><manufacturer>TestCorp</manufacturer><rom name="r{i}.bin" size="524288" crc="{crc:08X}" sha1="{sha1}"/></machine>"#,
                i = i,
                crc = (i as u32).wrapping_mul(0x9E3779B9),
                sha1 = format!("{:040X}", i.wrapping_mul(0x9E3779B9)),
            ));
        }
        xml.push_str(r#"</mame>"#);
        xml
    }

    #[test]
    fn test_mame_perf_1k() { perf_mame(1_000); }
    #[test]
    fn test_mame_perf_10k() { perf_mame(10_000); }
    #[test]
    fn test_mame_perf_50k() { perf_mame(50_000); }

    fn perf_mame(num_games: usize) {
        let xml = generate_mame_xml(num_games);
        let xml_size = xml.len();
        let start = Instant::now();
        let (games, stats) = parse(&xml);
        let elapsed = start.elapsed();

        let games_per_sec = num_games as f64 / elapsed.as_secs_f64();
        let mb_per_sec = (xml_size as f64 / 1_048_576.0) / elapsed.as_secs_f64();

        let total_roms: usize = games.iter().map(|g| g.roms.len()).sum();

        eprintln!(
            "  MAME perf: {} games, {} ROMs, {:.2} MB XML, {:.2}s, {:.0} games/s, {:.1} MB/s",
            stats.total_games,
            stats.total_roms,
            xml_size as f64 / 1_048_576.0,
            elapsed.as_secs_f64(),
            games_per_sec,
            mb_per_sec,
        );

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

        let (games, stats) = parse(xml);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].name, "sf2");
        assert_eq!(games[0].description, "Street Fighter II");
        assert_eq!(games[0].year.as_deref(), Some("1991"));
        assert_eq!(games[0].manufacturer.as_deref(), Some("Capcom"));
        assert!(games[0].cloneof.is_none());
        assert!(!games[0].isbios);
        assert!(!games[0].isdevice);
        assert!(games[0].runnable.is_none());
        assert!(games[0].driver_status.is_none());
        assert!(games[0].driver_emulation.is_none());
        assert_eq!(games[0].roms[0].filename, "sf2.03");
        assert_eq!(games[0].roms[0].size, Some(524288));
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("3F47A0D8"));
        assert_eq!(games[0].roms[0].sha1.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
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

        let (games, _) = parse(xml);
        assert_eq!(games[0].cloneof.as_deref(), Some("sf2"));
        assert_eq!(games[0].romof.as_deref(), Some("sf2"));
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

        let (games, _) = parse(xml);
        let roms = &games[0].roms;
        assert_eq!(roms.len(), 2);

        assert_eq!(roms[0].filename, "r1");
        assert_eq!(roms[0].sha1.as_deref(), Some("EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"));
        assert_eq!(roms[0].status, "nodump");
        assert!(roms[0].merge_target.is_none());
        assert_eq!(roms[0].crc32.as_deref(), Some("ABCD1234"));

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

        let (games, _) = parse(xml);
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

        let (games, stats) = parse(xml);
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

        let (games, stats) = parse(xml);
        assert!(games.is_empty());
        assert!(games.iter().all(|g| g.roms.is_empty()));
        assert_eq!(stats.total_games, 0);
        assert!(stats.errors.is_empty());
    }

    #[test]
    fn test_mame_machine_attributes() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="nes" sourcefile="src/mess/drivetime/nes.cpp" isdevice="no" isbios="no" runnable="yes">
    <description>Nintendo Entertainment System / Famicom</description>
    <year>1983</year>
    <manufacturer>Nintendo</manufacturer>
    <driver status="good" emulation="good"/>
    <softwarelist name="nes"/>
    <softwarelist name="famicom"/>
    <rom name="nes.rom" size="1024" crc="12345678"/>
  </machine>
</mame>"#;

        let (games, _) = parse(xml);
        let g = &games[0];
        assert_eq!(g.name, "nes");
        assert!(!g.isbios);
        assert!(!g.isdevice);
        assert_eq!(g.runnable, Some(true));
        assert_eq!(g.driver_status.as_deref(), Some("good"));
        assert_eq!(g.driver_emulation.as_deref(), Some("good"));
    }

    #[test]
    fn test_mame_bios_device() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="neogeo" sourcefile="src/mame/drivers/neogeo.cpp" isdevice="no" isbios="yes" runnable="yes">
    <description>Neo Geo BIOS</description>
    <year>1990</year>
    <manufacturer>SNK</manufacturer>
  </machine>
  <machine name="some_device" isdevice="yes" runnable="no">
    <description>A Device</description>
  </machine>
</mame>"#;

        let (games, _) = parse(xml);
        assert!(games[0].isbios);
        assert!(!games[0].isdevice);
        assert_eq!(games[0].runnable, Some(true));
        assert!(games[1].isdevice);
        assert_eq!(games[1].runnable, Some(false));
        assert!(!games[1].isbios);
    }

    #[test]
    fn test_mame_driver_emulation() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="imperfect" isdevice="no" runnable="yes">
    <description>Imperfect Driver</description>
    <driver status="imperfect" emulation="preliminary"/>
  </machine>
  <machine name="preliminary" isdevice="no" runnable="yes">
    <description>Preliminary Driver</description>
    <driver status="preliminary" emulation="good"/>
  </machine>
</mame>"#;

        let (games, _) = parse(xml);
        assert_eq!(games[0].driver_status.as_deref(), Some("imperfect"));
        assert_eq!(games[0].driver_emulation.as_deref(), Some("preliminary"));
        assert_eq!(games[1].driver_status.as_deref(), Some("preliminary"));
        assert_eq!(games[1].driver_emulation.as_deref(), Some("good"));
    }

    #[test]
    fn test_mame_game_tag_compatibility() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <game name="old_game" isbios="no" runnable="yes">
    <description>Old Style Game</description>
    <driver status="good" emulation="good"/>
  </game>
</mame>"#;

        let (games, _) = parse(xml);
        assert_eq!(games[0].name, "old_game");
        assert!(!games[0].isbios);
        assert_eq!(games[0].runnable, Some(true));
        assert_eq!(games[0].driver_status.as_deref(), Some("good"));
    }

    #[test]
    fn test_mame_sampleof_creates_stubs() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="game1" sourcefile="src/game1.cpp" sampleof="missing_samples">
    <description>Game with missing samples</description>
    <year>1991</year>
    <manufacturer>Test</manufacturer>
  </machine>
  <machine name="game2" sourcefile="src/game2.cpp" sampleof="also_missing">
    <description>Another game with missing samples</description>
  </machine>
  <machine name="has_own_samples" sampleof="has_own_samples">
    <description>Self-referencing samples (should not create extra stub)</description>
  </machine>
</mame>"#;

        let (games, stats) = parse(xml);
        // 3 machines + 2 stubs (missing_samples, also_missing) = 5 total
        assert_eq!(stats.total_games, 5);
        assert_eq!(games.len(), 5);

        // Find the stubs
        let stub1 = games.iter().find(|g| g.name == "missing_samples").expect("missing_samples stub");
        assert_eq!(stub1.description, "Samples for missing_samples");
        assert!(stub1.isdevice);
        assert!(stub1.roms.is_empty());

        let stub2 = games.iter().find(|g| g.name == "also_missing").expect("also_missing stub");
        assert_eq!(stub2.description, "Samples for also_missing");
        assert!(stub2.isdevice);

        // Self-referencing sampleof should NOT create extra stub
        assert_eq!(games.iter().filter(|g| g.name == "has_own_samples").count(), 1);

        // Real machines are intact
        let g1 = games.iter().find(|g| g.name == "game1").unwrap();
        assert_eq!(g1.description, "Game with missing samples");
        assert!(!g1.isdevice);
    }

    #[test]
    fn test_mame_no_sampleof_no_stubs() {
        let xml = r#"<?xml version="1.0"?>
<mame>
  <machine name="a"><description>A</description></machine>
  <machine name="b"><description>B</description></machine>
</mame>"#;

        let (games, _) = parse(xml);
        assert_eq!(games.len(), 2);
    }

}
