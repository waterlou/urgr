use std::io::Write;

use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer as XmlWriter;

use crate::error::Result;

/// A game entry ready for DAT output.
pub struct ExportGame {
    pub name: String,
    pub description: String,
    pub year: Option<String>,
    pub manufacturer: Option<String>,
    pub cloneof: Option<String>,
    pub romof: Option<String>,
    pub isbios: bool,
    pub roms: Vec<ExportRom>,
}

/// A single ROM entry ready for DAT output.
pub struct ExportRom {
    pub name: String,
    pub size: Option<i64>,
    pub crc32: Option<String>,
    pub sha1: Option<String>,
    pub status: String,
}

/// Write a Logiqx-format DAT file.
///
/// The output uses the `<datafile>` → `<game>` → `<rom>` hierarchy so it can be
/// re-imported by [`crate::dat::logiqx::parse_logiqx_reader`].
pub fn write_logiqx_dat<W: Write>(games: &[ExportGame], writer: W) -> Result<()> {
    let mut xml = XmlWriter::new_with_indent(writer, b' ', 2);

    xml.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    xml.write_event(Event::Start(BytesStart::new("datafile")))?;

    for game in games {
        write_game(&mut xml, game)?;
    }

    xml.write_event(Event::End(BytesEnd::new("datafile")))?;
    Ok(())
}

fn write_game<W: Write>(xml: &mut XmlWriter<W>, game: &ExportGame) -> Result<()> {
    let mut elem = BytesStart::new("game");
    elem.push_attribute(("name", game.name.as_str()));

    if let Some(ref cloneof) = game.cloneof {
        elem.push_attribute(("cloneof", cloneof.as_str()));
    }
    if let Some(ref romof) = game.romof {
        elem.push_attribute(("romof", romof.as_str()));
    }
    if game.isbios {
        elem.push_attribute(("isbios", "yes"));
    }

    xml.write_event(Event::Start(elem))?;

    write_text_element(xml, "description", &game.description)?;
    if let Some(ref year) = game.year {
        write_text_element(xml, "year", year)?;
    }
    if let Some(ref mfr) = game.manufacturer {
        write_text_element(xml, "manufacturer", mfr)?;
    }

    for rom in &game.roms {
        let mut r = BytesStart::new("rom");
        r.push_attribute(("name", rom.name.as_str()));
        if let Some(ref size) = rom.size {
            r.push_attribute(("size", size.to_string().as_str()));
        }
        if let Some(ref crc) = rom.crc32 {
            r.push_attribute(("crc", crc.to_lowercase().as_str()));
        }
        if let Some(ref sha1) = rom.sha1 {
            r.push_attribute(("sha1", sha1.to_lowercase().as_str()));
        }
        if rom.status != "good" {
            r.push_attribute(("status", rom.status.as_str()));
        }
        xml.write_event(Event::Empty(r))?;
    }

    xml.write_event(Event::End(BytesEnd::new("game")))?;
    Ok(())
}

fn write_text_element<W: Write>(xml: &mut XmlWriter<W>, name: &str, text: &str) -> Result<()> {
    xml.write_event(Event::Start(BytesStart::new(name)))?;
    xml.write_event(Event::Text(BytesText::new(text)))?;
    xml.write_event(Event::End(BytesEnd::new(name)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_logiqx_dat_single_game() {
        let games = vec![ExportGame {
            name: "game1".into(),
            description: "Game One".into(),
            year: Some("2024".into()),
            manufacturer: Some("Acme".into()),
            cloneof: None,
            romof: None,
            isbios: false,
            roms: vec![ExportRom {
                name: "rom1.bin".into(),
                size: Some(8192),
                crc32: Some("ABCD1234".into()),
                sha1: None,
                status: "good".into(),
            }],
        }];

        let mut buf = Vec::new();
        write_logiqx_dat(&games, &mut buf).unwrap();
        let output = String::from_utf8(buf).unwrap();

        assert!(output.contains("<?xml"));
        assert!(output.contains("<datafile>"));
        assert!(output.contains("<game name=\"game1\">"));
        assert!(output.contains("<description>Game One</description>"));
        assert!(output.contains("<year>2024</year>"));
        assert!(output.contains("<manufacturer>Acme</manufacturer>"));
        assert!(output.contains("<rom name=\"rom1.bin\" size=\"8192\" crc=\"abcd1234\"/>"));
        assert!(output.contains("</datafile>"));
    }

    #[test]
    fn test_write_logiqx_dat_bios_romof_cloneof() {
        let games = vec![ExportGame {
            name: "neogeo".into(),
            description: "NEOGEO BIOS".into(),
            year: None,
            manufacturer: None,
            cloneof: None,
            romof: Some("neogeo".into()),
            isbios: true,
            roms: vec![],
        }];

        let mut buf = Vec::new();
        write_logiqx_dat(&games, &mut buf).unwrap();
        let output = String::from_utf8(buf).unwrap();

        assert!(output.contains("romof=\"neogeo\""));
        assert!(output.contains("isbios=\"yes\""));
    }

    #[test]
    fn test_write_logiqx_dat_empty() {
        let mut buf = Vec::new();
        write_logiqx_dat(&[], &mut buf).unwrap();
        let output = String::from_utf8(buf).unwrap();
        assert!(output.contains("<datafile>"));
        assert!(output.contains("</datafile>"));
    }
}
