/// Minimal ZIP entry info parsed from central directory
#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub crc32: Option<u32>,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_offset: u64,
}

/// Reads a remote ZIP's central directory via HTTP Range requests.
pub struct RemoteZip {
    url: String,
    client: reqwest::Client,
}

impl RemoteZip {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Create a RemoteZip with an authenticated client (cookie jar included)
    pub fn new_with_client(url: &str, client: reqwest::Client) -> Self {
        Self {
            url: url.to_string(),
            client,
        }
    }

    /// Fetch a byte range from the remote file, following IA redirects
    async fn fetch_range(&mut self, start: u64, end: u64) -> Result<Vec<u8>, String> {
        for _ in 0..5 {
            let resp = self
                .client
                .get(&self.url)
                .header("Range", format!("bytes={}-{}", start, end))
                .header("User-Agent", "GameManager/0.1")
                .send()
                .await
                .map_err(|e| format!("HTTP error: {}", e))?;

            if resp.status().is_redirection() {
                if let Some(location) = resp.headers().get("location") {
                    if let Ok(loc) = location.to_str() {
                        self.url = loc.to_string();
                        continue;
                    }
                }
            }
            if !resp.status().is_success() && resp.status().as_u16() != 206 {
                return Err(format!("Range request returned HTTP {}", resp.status()));
            }
            return resp
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| format!("Read error: {}", e));
        }
        Err("Too many redirects".into())
    }

    async fn get_size(&mut self) -> Result<u64, String> {
        for _ in 0..5 {
            let resp = self
                .client
                .get(&self.url)
                .header("Range", "bytes=0-0")
                .header("User-Agent", "GameManager/0.1")
                .send()
                .await
                .map_err(|e| format!("HTTP error: {}", e))?;

            if resp.status().is_redirection() {
                if let Some(location) = resp.headers().get("location") {
                    if let Ok(loc) = location.to_str() {
                        self.url = loc.to_string();
                        continue;
                    }
                }
            }
            if let Some(val) = resp.headers().get("content-range") {
                let s = val.to_str().map_err(|_| "Bad content-range header")?;
                let total = s.rsplit('/').next().unwrap_or("0");
                return total.parse::<u64>().map_err(|_| "Bad content-range value".into());
            }
            return Err("No content-range header".into());
        }
        Err("Too many redirects".into())
    }

    /// Parse the central directory and return all zip entries.
    pub async fn list_entries(&mut self) -> Result<Vec<ZipEntry>, String> {
        let size = self.get_size().await?;
        let read_size = std::cmp::min(size, 131072);
        let tail = self.fetch_range(size - read_size, size - 1).await?;

        let eocd_offset = tail
            .windows(4)
            .enumerate()
            .rev()
            .find(|(_, w)| *w == [0x50, 0x4b, 0x05, 0x06])
            .map(|(pos, _)| pos);

        let (cd_offset, _num_entries) = match eocd_offset {
            Some(pos) => {
                let cd_offset = u64::from_le_bytes([
                    tail[pos + 20], tail[pos + 21], tail[pos + 22], tail[pos + 23],
                    0, 0, 0, 0,
                ]);
                let num = u64::from_le_bytes([
                    tail[pos + 12], tail[pos + 13], tail[pos + 14], tail[pos + 15],
                    0, 0, 0, 0,
                ]);
                (cd_offset, num)
            }
            None => return Err("Could not find EOCD record".into()),
        };

        // Read central directory size from EOCD
        let cd_size_pos = eocd_offset.unwrap();
        let cd_size = u64::from_le_bytes([
            tail[cd_size_pos + 16], tail[cd_size_pos + 17],
            tail[cd_size_pos + 18], tail[cd_size_pos + 19],
            0, 0, 0, 0,
        ]);

        let cd_data = self.fetch_range(cd_offset, cd_offset + cd_size - 1).await?;

        let mut entries = Vec::new();
        let mut pos = 0usize;

        while pos + 46 <= cd_data.len() {
            let sig = &cd_data[pos..pos + 4];
            if sig != &[0x50, 0x4b, 0x01, 0x02] {
                break;
            }

            let crc = u32::from_le_bytes([
                cd_data[pos + 16], cd_data[pos + 17],
                cd_data[pos + 18], cd_data[pos + 19],
            ]);
            let comp_size = u32::from_le_bytes([
                cd_data[pos + 20], cd_data[pos + 21],
                cd_data[pos + 22], cd_data[pos + 23],
            ]);
            let uncomp_size = u32::from_le_bytes([
                cd_data[pos + 24], cd_data[pos + 25],
                cd_data[pos + 26], cd_data[pos + 27],
            ]);
            let name_len = u16::from_le_bytes([cd_data[pos + 28], cd_data[pos + 29]]) as usize;
            let extra_len = u16::from_le_bytes([cd_data[pos + 30], cd_data[pos + 31]]) as usize;
            let _comment_len = u16::from_le_bytes([cd_data[pos + 32], cd_data[pos + 33]]) as usize;
            let local_offset = u32::from_le_bytes([
                cd_data[pos + 42], cd_data[pos + 43],
                cd_data[pos + 44], cd_data[pos + 45],
            ]);

            if name_len > 0 && pos + 46 + name_len <= cd_data.len() {
                let name_bytes = &cd_data[pos + 46..pos + 46 + name_len];
                let name = String::from_utf8_lossy(name_bytes).to_string();
                entries.push(ZipEntry {
                    name,
                    crc32: Some(crc),
                    compressed_size: comp_size as u64,
                    uncompressed_size: uncomp_size as u64,
                    local_offset: local_offset as u64,
                });
            }

            pos += 46 + name_len + extra_len + _comment_len;
        }

        Ok(entries)
    }

    pub fn find_entry<'a>(&self, entries: &'a [ZipEntry], name: &str) -> Option<&'a ZipEntry> {
        entries.iter().find(|e| {
            e.name == name || e.name.ends_with(&format!("/{}", name))
                || e.name.ends_with(name)
        })
    }

    pub async fn extract_entry(&mut self, entry: &ZipEntry) -> Result<Vec<u8>, String> {
        let header_size = 30u64;
        let header = self.fetch_range(entry.local_offset, entry.local_offset + header_size + 200).await?;
        let name_len = u16::from_le_bytes([header[26], header[27]]) as u64;
        let extra_len = u16::from_le_bytes([header[28], header[29]]) as u64;
        let data_start = entry.local_offset + 30 + name_len + extra_len;
        let data_end = data_start + entry.compressed_size - 1;
        let data = self.fetch_range(data_start, data_end).await?;
        Ok(data)
    }
}
