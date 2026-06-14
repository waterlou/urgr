use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::error::Result;
use crate::models::{ParsedGame, ParsedRom, ParseStats};

pub fn parse_clrmamepro_dat<P: AsRef<Path>>(path: P) -> Result<(Vec<ParsedGame>, ParseStats)> {
    let text = fs::read_to_string(path.as_ref())?;
    Ok(parse_clrmamepro_str(&text))
}

pub fn parse_clrmamepro_str(text: &str) -> (Vec<ParsedGame>, ParseStats) {
    let mut games = Vec::new();
    let mut errors = Vec::new();

    let stripped = text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");

    let mut pos = 0;
    while let Some(game_start) = stripped[pos..].find("game (") {
        let start = pos + game_start;
        let block = match extract_block(&stripped[start..]) {
            Some(b) => b,
            None => { errors.push("Malformed game block".into()); pos = start + 6; continue; }
        };
        pos = start + block.len();

        let kv = parse_game_block(&block);
        let name = match kv.get("name") {
            Some(n) => n.clone(),
            None => { errors.push("Game block missing name".into()); continue; }
        };

        let mut roms = Vec::new();
        if let Some(rom_blocks) = kv.get("_roms") {
            for rblock in rom_blocks.split('\n') {
                if rblock.trim().is_empty() { continue; }
                if let Some(rom) = parse_rom_entry(rblock) {
                    roms.push(rom);
                }
            }
        }

        games.push(ParsedGame {
            name,
            description: kv.get("description").cloned().unwrap_or_default(),
            year: kv.get("year").cloned(),
            manufacturer: kv.get("manufacturer").cloned(),
            cloneof: kv.get("cloneof").cloned(),
            romof: kv.get("romof").cloned(),
            platform: String::new(),
            roms,
        });
    }

    let total_roms: usize = games.iter().map(|g| g.roms.len()).sum();
    let stats = ParseStats {
        total_games: games.len(),
        total_roms,
        errors,
    };

    (games, stats)
}

fn extract_block(s: &str) -> Option<String> {
    let paren_start = s.find('(')?;
    let mut depth = 0;
    let mut end = paren_start;
    for (i, c) in s[paren_start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 { end = paren_start + i + 1; break; }
            }
            _ => {}
        }
    }
    if depth != 0 { return None; }
    Some(s[..end].to_string())
}

fn parse_game_block(block: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut rom_blocks = Vec::new();

    let inner_start = block.find('(').unwrap_or(0) + 1;
    let inner_end = block.len() - 1;
    if inner_start >= inner_end { return map; }
    let inner = &block[inner_start..inner_end];

    let chars: Vec<char> = inner.chars().collect();
    let mut idx = 0;

    while idx < chars.len() {
        while idx < chars.len() && chars[idx].is_whitespace() { idx += 1; }
        if idx >= chars.len() { break; }

        if chars[idx] == '(' {
            if let Some(close) = match_paren(&chars, idx) {
                let sub: String = chars[idx..=close].iter().collect();
                let trimmed = sub.trim();
                if trimmed.starts_with("(rom ") || trimmed.starts_with("(disk ") || trimmed.starts_with("(sample ") {
                    rom_blocks.push(trimmed.to_string());
                }
                idx = close + 1;
                continue;
            }
        }

        let mut key_end = idx;
        while key_end < chars.len() && !chars[key_end].is_whitespace() && chars[key_end] != '"' && chars[key_end] != '(' {
            key_end += 1;
        }
        let key: String = chars[idx..key_end].iter().collect();
        idx = key_end;

        while idx < chars.len() && chars[idx].is_whitespace() { idx += 1; }
        if idx >= chars.len() { break; }

        if chars[idx] == '(' {
            if let Some(close) = match_paren(&chars, idx) {
                let full: String = [key.as_str(), " ", &chars[idx..=close].iter().collect::<String>()].concat();
                let trimmed = full.trim();
                if trimmed.starts_with("rom ") || trimmed.starts_with("disk ") || trimmed.starts_with("sample ") {
                    rom_blocks.push(format!("({})", trimmed));
                }
                idx = close + 1;
            }
        } else if chars[idx] == '"' {
            let mut end = idx + 1;
            while end < chars.len() && chars[end] != '"' { end += 1; }
            let val: String = chars[idx + 1..end].iter().collect();
            idx = end + 1;
            map.insert(key, val);
        } else {
            let mut end = idx;
            while end < chars.len() && !chars[end].is_whitespace() && chars[end] != ')' { end += 1; }
            let val: String = chars[idx..end].iter().collect();
            idx = end;
            map.insert(key, val);
        }
    }

    if !rom_blocks.is_empty() {
        map.insert("_roms".into(), rom_blocks.join("\n"));
    }

    map
}

fn match_paren(chars: &[char], start: usize) -> Option<usize> {
    if start >= chars.len() || chars[start] != '(' { return None; }
    let mut depth = 0;
    for i in start..chars.len() {
        match chars[i] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 { return Some(i); }
            }
            _ => {}
        }
    }
    None
}

fn parse_rom_entry(text: &str) -> Option<ParsedRom> {
    let chars: Vec<char> = text.chars().collect();
    let mut map = HashMap::new();
    let mut idx = 0;

    while idx < chars.len() && chars[idx] != '(' { idx += 1; }
    if idx >= chars.len() { return None; }

    let close = match match_paren(&chars, idx) { Some(c) => c, None => return None };
    let inner: String = chars[idx + 1..close].iter().collect();

    let ic: Vec<char> = inner.chars().collect();
    let mut i = 0;
    while i < ic.len() {
        while i < ic.len() && ic[i].is_whitespace() { i += 1; }
        if i >= ic.len() { break; }

        let mut ke = i;
        while ke < ic.len() && !ic[ke].is_whitespace() && ic[ke] != '"' { ke += 1; }
        let key: String = ic[i..ke].iter().collect();
        i = ke;

        while i < ic.len() && ic[i].is_whitespace() { i += 1; }
        if i >= ic.len() { break; }

        if ic[i] == '"' {
            let mut e = i + 1;
            while e < ic.len() && ic[e] != '"' { e += 1; }
            let val: String = ic[i + 1..e].iter().collect();
            i = e + 1;
            map.insert(key, val);
        } else {
            let mut e = i;
            while e < ic.len() && !ic[e].is_whitespace() { e += 1; }
            let val: String = ic[i..e].iter().collect();
            i = e;
            map.insert(key, val);
        }
    }

    Some(ParsedRom {
        filename: map.get("name").cloned().unwrap_or_default(),
        size: map.get("size").and_then(|s| s.parse().ok()),
        crc32: map.get("crc").map(|s| s.to_uppercase()),
        md5: map.get("md5").map(|s| s.to_uppercase()),
        sha1: map.get("sha1").map(|s| s.to_uppercase()),
        status: map.get("status").cloned().unwrap_or_else(|| "good".into()),
        merge_target: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> (Vec<ParsedGame>, ParseStats) {
        parse_clrmamepro_str(text)
    }

    #[test]
    fn test_clrmamepro_basic_game() {
        let dat = r#"
clrmamepro (
  name "FBNeo"
  description "Final Burn Neo v1.0.0.03"
)
game (
  name "sf2"
  description "Street Fighter II"
  year "1991"
  manufacturer "Capcom"
  rom ( name "sf2.03" size 524288 crc 3F47A0D8 sha1 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA )
)
"#;
        let (games, stats) = parse(dat);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.total_roms, 1);
        assert_eq!(games[0].name, "sf2");
        assert_eq!(games[0].description, "Street Fighter II");
        assert_eq!(games[0].year.as_deref(), Some("1991"));
        assert_eq!(games[0].manufacturer.as_deref(), Some("Capcom"));
        assert!(games[0].cloneof.is_none());
        assert_eq!(games[0].roms[0].filename, "sf2.03");
        assert_eq!(games[0].roms[0].size, Some(524288));
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("3F47A0D8"));
        assert_eq!(games[0].roms[0].sha1.as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert_eq!(games[0].roms[0].status, "good");
    }

    #[test]
    fn test_clrmamepro_multiple_games() {
        let dat = r#"
clrmamepro ( name "Test" )
game ( name "a" description "A" rom ( name "a.rom" size 100 crc 00000001 ) )
game ( name "b" description "B" rom ( name "b.rom" size 200 crc 00000002 ) )
game ( name "c" description "C" )
"#;
        let (games, _) = parse(dat);
        assert_eq!(games.len(), 3);
        let total_roms: usize = games.iter().map(|g| g.roms.len()).sum();
        assert_eq!(total_roms, 2);
        assert_eq!(games[0].name, "a");
        assert_eq!(games[1].name, "b");
        assert_eq!(games[2].name, "c");
    }

    #[test]
    fn test_clrmamepro_cloneof() {
        let dat = r#"
clrmamepro ( name "Test" )
game ( name "sf2j" description "SF2 (Japan)" cloneof "sf2" rom ( name "sf2j.rom" ) )
"#;
        let (games, _) = parse(dat);
        assert_eq!(games[0].cloneof.as_deref(), Some("sf2"));
    }

    #[test]
    fn test_clrmamepro_multiple_roms() {
        let dat = r#"
clrmamepro ( name "Test" )
game (
  name "test"
  description "Test Game"
  rom ( name "r1.bin" size 512 crc AAAA1111 md5 abcdef1234567890abcdef1234567890 sha1 EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE status "nodump" )
  rom ( name "r2.bin" size 1024 crc BBBB2222 merge "t" )
)
"#;
        let (games, stats) = parse(dat);
        assert_eq!(stats.total_roms, 2);
        assert_eq!(games[0].roms.len(), 2);

        assert_eq!(games[0].roms[0].filename, "r1.bin");
        assert_eq!(games[0].roms[0].size, Some(512));
        assert_eq!(games[0].roms[0].crc32.as_deref(), Some("AAAA1111"));
        assert_eq!(games[0].roms[0].md5.as_deref(), Some("ABCDEF1234567890ABCDEF1234567890"));
        assert_eq!(games[0].roms[0].sha1.as_deref(), Some("EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"));
        assert_eq!(games[0].roms[0].status, "nodump");
        assert!(games[0].roms[0].merge_target.is_none());

        assert_eq!(games[0].roms[1].filename, "r2.bin");
        assert_eq!(games[0].roms[1].size, Some(1024));
        assert_eq!(games[0].roms[1].crc32.as_deref(), Some("BBBB2222"));
        assert_eq!(games[0].roms[1].status, "good");
        assert!(games[0].roms[1].md5.is_none());
    }

    #[test]
    fn test_clrmamepro_empty_header() {
        let dat = "game ( name \"only\" description \"Just a game\" )";
        let (games, stats) = parse(dat);
        assert_eq!(stats.total_games, 1);
        assert_eq!(games[0].name, "only");
        assert!(games[0].roms.is_empty());
    }

    #[test]
    fn test_clrmamepro_comments_and_blank_lines() {
        let dat = r#"
// This is a comment
clrmamepro ( name "FBNeo" )
# Another comment

game ( name "g1" description "G1" )

game ( name "g2" description "G2" )
"#;
        let (games, _) = parse(dat);
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].name, "g1");
        assert_eq!(games[1].name, "g2");
    }

    #[test]
    fn test_clrmamepro_empty_input() {
        let (games, stats) = parse("");
        assert!(games.is_empty());
        assert_eq!(stats.total_games, 0);
    }

    #[test]
    fn test_clrmamepro_no_header() {
        let dat = r#"
game ( name "g1" description "G1" )
game ( name "g2" description "G2" )
"#;
        let (games, stats) = parse(dat);
        assert_eq!(games.len(), 2);
        assert_eq!(stats.errors.len(), 0);
    }
}
