use std::collections::HashMap;
use std::path::Path;

/// Result of CRC verification on a downloaded zip.
#[derive(Debug)]
pub struct CrcResult {
    pub match_count: usize,
    pub mismatch_count: usize,
    pub mismatches: Vec<CrcMismatch>,
}

#[derive(Debug)]
pub struct CrcMismatch {
    pub entry_name: String,
    pub expected: String,
    pub got: String,
}

/// Open a zip file at `path` and compare entry CRCs against `expected`.
/// `expected` is a map of entry filename (lowercase) -> 8-char hex CRC string (uppercase).
/// An entry CRC matches if the expected map contains its name and the CRCs are equal.
/// Returns the number of matched and mismatched entries.
pub fn verify_zip_crc(path: &Path, expected: &HashMap<String, String>) -> Result<CrcResult, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open zip for CRC verification: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip for CRC verification: {}", e))?;

    if expected.is_empty() {
        return Ok(CrcResult { match_count: 0, mismatch_count: 0, mismatches: vec![] });
    }

    let mut match_count = 0usize;
    let mut mismatches = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;
        if entry.is_dir() { continue; }

        let entry_name = entry.name().to_lowercase();
        let entry_crc = format!("{:08X}", entry.crc32());

        if let Some(expected_crc) = expected.get(&entry_name) {
            if entry_crc == *expected_crc {
                match_count += 1;
            } else {
                mismatches.push(CrcMismatch {
                    entry_name: entry.name().to_string(),
                    expected: expected_crc.clone(),
                    got: entry_crc,
                });
            }
        }
    }

    let mismatch_count = mismatches.len();
    Ok(CrcResult { match_count, mismatch_count, mismatches })
}
