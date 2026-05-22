use std::path::Path;

use crate::hasher::RomHashes;
use crate::sources::ScraperRegistry;

pub async fn match_rom_by_path(
    path: &Path,
    registry: &ScraperRegistry,
) -> crate::Result<Option<crate::Game>> {
    let hashes = crate::hasher::compute_hashes(path)?;
    match_rom_by_hashes(&hashes, registry).await
}

pub async fn match_rom_by_hashes(
    hashes: &RomHashes,
    registry: &ScraperRegistry,
) -> crate::Result<Option<crate::Game>> {
    registry.search_by_hashes(hashes, None).await
}

pub fn parse_filename(filename: &str) -> Option<FilenameInfo> {
    let stem = Path::new(filename).file_stem()?.to_str()?;

    let mut info = FilenameInfo {
        title: String::new(),
        region: None,
        version: None,
        tags: Vec::new(),
    };

    let mut remaining = stem;
    let mut found_tag = false;

    loop {
        let paren_start = remaining.find('(');
        let bracket_start = remaining.find('[');

        let (start, end) = match (paren_start, bracket_start) {
            (Some(p), Some(b)) if p < b => (p, remaining[p..].find(')').map(|i| p + i)),
            (Some(_), Some(b)) => (b, remaining[b..].find(']').map(|i| b + i)),
            (Some(p), None) => (p, remaining[p..].find(')').map(|i| p + i)),
            (None, Some(b)) => (b, remaining[b..].find(']').map(|i| b + i)),
            (None, None) => break,
        };

        if !found_tag {
            info.title = remaining[..start].trim().to_string();
            found_tag = true;
        }

        if let Some(end) = end {
            let content = &remaining[start + 1..end];
            for part in content.split(',') {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                let lower = part.to_lowercase();
                if is_region_code(part) {
                    info.region = Some(part.to_string());
                } else if lower.starts_with("rev") || lower.starts_with("v") {
                    info.version = Some(part.to_string());
                } else {
                    info.tags.push(part.to_string());
                }
            }
            remaining = &remaining[end + 1..];
        } else {
            break;
        }
    }

    if !found_tag {
        info.title = stem.to_string();
    }

    Some(info)
}

#[derive(Debug, Clone)]
pub struct FilenameInfo {
    pub title: String,
    pub region: Option<String>,
    pub version: Option<String>,
    pub tags: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_filename() {
        let info = parse_filename("Super Mario Bros (USA).nes").unwrap();
        assert_eq!(info.title, "Super Mario Bros");
        assert_eq!(info.region.unwrap(), "USA");
        assert!(info.version.is_none());
    }

    #[test]
    fn test_parse_with_revision() {
        let info = parse_filename("Legend of Zelda (USA) (Rev 1).sfc").unwrap();
        assert_eq!(info.title, "Legend of Zelda");
        assert_eq!(info.region.unwrap(), "USA");
        assert_eq!(info.version.unwrap(), "Rev 1");
    }

    #[test]
    fn test_parse_multiregion() {
        let info = parse_filename("Sonic (USA, Europe).md").unwrap();
        assert_eq!(info.title, "Sonic");
        assert_eq!(info.region.unwrap(), "USA");
    }

    #[test]
    fn test_parse_no_parenthesis() {
        let info = parse_filename("SimpleName.pce").unwrap();
        assert_eq!(info.title, "SimpleName");
        assert!(info.region.is_none());
    }

    #[test]
    fn test_parse_with_brackets() {
        let info = parse_filename("Game [!].nes").unwrap();
        assert_eq!(info.title, "Game");
        assert_eq!(info.tags, vec!["!"]);
    }
}

fn is_region_code(s: &str) -> bool {
    let upper = s.to_uppercase();
    matches!(
        upper.as_str(),
        "USA"
            | "EUR"
            | "JPN"
            | "JAP"
            | "PAL"
            | "NTSC"
            | "NTSC-U"
            | "NTSC-J"
            | "GER"
            | "FRA"
            | "UK"
            | "AUS"
            | "ASI"
            | "KOR"
            | "BRA"
            | "CHN"
            | "TWN"
            | "SPA"
            | "ITA"
            | "MEX"
            | "CAN"
            | "WORLD"
            | "WLD"
            | "UNK"
            | "US"
            | "EU"
            | "JP"
            | "DE"
            | "FR"
            | "GB"
            | "ES"
            | "IT"
            | "NL"
            | "AU"
            | "SE"
            | "NO"
            | "DK"
            | "FI"
            | "RU"
            | "CZ"
            | "PL"
            | "HU"
            | "PT"
            | "GR"
            | "TR"
            | "HK"
            | "SG"
            | "IN"
            | "TH"
            | "PH"
            | "ID"
            | "MY"
            | "VN"
            | "ZA"
            | "IL"
            | "SA"
            | "AE"
            | "AR"
            | "CL"
            | "CO"
            | "PE"
            | "NZ"
            | "AT"
            | "CH"
            | "BE"
            | "BG"
            | "HR"
            | "CY"
            | "EE"
            | "IS"
            | "IE"
            | "LV"
            | "LI"
            | "LT"
            | "LU"
            | "MT"
            | "MC"
            | "ME"
            | "RO"
            | "SK"
            | "SI"
            | "UA"
            | "VA"
            | "RS"
            | "BA"
            | "AL"
            | "MK"
            | "BY"
            | "MD"
            | "AM"
            | "AZ"
            | "GE"
            | "KZ"
            | "UZ"
            | "TM"
            | "KG"
            | "TJ"
            | "REGIONFREE"
    )
}
