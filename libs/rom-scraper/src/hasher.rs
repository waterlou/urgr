use std::io::Read;
use std::path::Path;

use md5::Digest as _;

const READ_BUF_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct RomHashes {
    pub crc32: String,
    pub md5: String,
    pub sha1: String,
    pub size: u64,
}

pub fn compute_hashes(path: &Path) -> crate::Result<RomHashes> {
    let mut file = std::fs::File::open(path)?;

    let mut crc32 = crc32fast::Hasher::new();
    let mut md5 = md5::Md5::new();
    let mut sha1 = sha1::Sha1::new();

    let mut buf = vec![0u8; READ_BUF_SIZE];
    let mut total: u64 = 0;

    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        crc32.update(&buf[..n]);
        md5.update(&buf[..n]);
        sha1.update(&buf[..n]);
        total += n as u64;
    }

    let crc32_result = format!("{:08X}", crc32.finalize());
    let md5_result = format!("{:032X}", md5.finalize());
    let sha1_result = format!("{:040X}", sha1.finalize());

    Ok(RomHashes {
        crc32: crc32_result,
        md5: md5_result,
        sha1: sha1_result,
        size: total,
    })
}

pub fn compute_hashes_from_bytes(data: &[u8]) -> RomHashes {
    let mut crc32 = crc32fast::Hasher::new();
    let mut md5 = md5::Md5::new();
    let mut sha1 = sha1::Sha1::new();

    crc32.update(data);
    md5.update(data);
    sha1.update(data);

    RomHashes {
        crc32: format!("{:08X}", crc32.finalize()),
        md5: format!("{:032X}", md5.finalize()),
        sha1: format!("{:040X}", sha1.finalize()),
        size: data.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_data_hashes() {
        let hashes = compute_hashes_from_bytes(b"");
        assert_eq!(hashes.crc32, "00000000");
        assert_eq!(hashes.md5, "D41D8CD98F00B204E9800998ECF8427E");
        assert_eq!(hashes.sha1, "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709");
        assert_eq!(hashes.size, 0);
    }

    #[test]
    fn test_ascii_data_hashes() {
        let hashes = compute_hashes_from_bytes(b"hello");
        assert_eq!(hashes.size, 5);
        assert_eq!(hashes.crc32, "3610A686");
        assert_eq!(hashes.md5, "5D41402ABC4B2A76B9719D911017C592");
        assert_eq!(hashes.sha1, "AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D");
    }

    #[test]
    fn test_rom_hashes_uppercase() {
        let data = b"NES\x1a\x01\x02NES ROM IMAGE";
        let hashes = compute_hashes_from_bytes(data);
        assert!(hashes.crc32.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        assert!(hashes.md5.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        assert!(hashes.sha1.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    }
}
