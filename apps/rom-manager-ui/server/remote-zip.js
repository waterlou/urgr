// Remote ZIP reader — list and extract files from a ZIP archive over HTTP
// without downloading the whole file. Uses HTTP Range requests.

export class RemoteZip {
  constructor(url) {
    this.url = url;
    this._size = null;
    this._entries = null;
  }

  async _fetchRange(start, end) {
    let resp = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: 'manual',
    });
    // Handle IA's redirect to CDN
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('Redirect without location');
      this.url = location;
      resp = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
    }
    if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} requesting range ${start}-${end}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async size() {
    if (this._size) return this._size;
    // GET first byte to detect file size (more reliable than HEAD for IA redirects)
    const resp = await fetch(this.url, {
      headers: { Range: 'bytes=0-0' },
    });
    if (resp.status !== 206 && !resp.ok) throw new Error(`HTTP ${resp.status} for ${this.url}`);
    const s = parseInt(resp.headers.get('content-range')?.split('/')[1] || resp.headers.get('content-length'), 10);
    if (!s) throw new Error('Could not determine file size');
    this._size = s;
    return s;
  }

  async readU32(arr, off) { return (arr[off] | (arr[off + 1] << 8) | (arr[off + 2] << 16) | (arr[off + 3] << 24)) >>> 0; }
  async readU16(arr, off) { return (arr[off] | (arr[off + 1] << 8)) >>> 0; }
  async readU64(arr, off) {
    const low = (arr[off] | (arr[off + 1] << 8) | (arr[off + 2] << 16) | (arr[off + 3] << 24)) >>> 0;
    const high = (arr[off + 4] | (arr[off + 5] << 8) | (arr[off + 6] << 16) | (arr[off + 7] << 24)) >>> 0;
    return low + high * 0x100000000;
  }

  async _loadCentralDir() {
    const totalSize = await this.size();

    // Read last 128KB to find EOCD and ZIP64 locator
    const tailLen = Math.min(totalSize, 131072);
    const tail = await this._fetchRange(totalSize - tailLen, totalSize - 1);
    const tailOff = totalSize - tailLen;

    let cdOffset, cdSize, cdCount;

    // Try ZIP64 first: find PK\x06\x07 (ZIP64 End of Central Directory Locator)
    let zip64LocOff = -1;
    for (let i = tail.length - 20; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x06 && tail[i + 3] === 0x07) {
        zip64LocOff = tailOff + i;
        break;
      }
    }
    if (zip64LocOff >= 0) {
      const z64local = zip64LocOff - tailOff;
      const z64EocdOff = await this.readU64(tail, z64local + 8);
      // Download ZIP64 EOCD (fixed 56 bytes + variable size)
      const z64Eocd = await this._fetchRange(z64EocdOff, z64EocdOff + 63);
      const z64EocdSize = await this.readU64(z64Eocd, 4); // size of ZIP64 EOCD
      cdCount = await this.readU64(z64Eocd, 24); // total entries
      cdSize = await this.readU64(z64Eocd, 40); // central directory size
      cdOffset = await this.readU64(z64Eocd, 48); // central directory offset
    } else {
      // Fallback to standard EOCD
      let eocdOff = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
          eocdOff = tailOff + i;
          break;
        }
      }
      if (eocdOff === -1) throw new Error('EOCD not found');
      const eocdLocalOff = eocdOff - tailOff;
      cdOffset = await this.readU32(tail, eocdLocalOff + 16);
      cdSize = await this.readU32(tail, eocdLocalOff + 12);
      cdCount = await this.readU16(tail, eocdLocalOff + 8);
    }

    // Download central directory
    const cd = await this._fetchRange(cdOffset, cdOffset + cdSize - 1);

    // Parse entries
    const entries = [];
    let pos = 0;
    for (let i = 0; i < cdCount; i++) {
      if (cd[pos] !== 0x50 || cd[pos + 1] !== 0x4b || cd[pos + 2] !== 0x01 || cd[pos + 3] !== 0x02) break;
      const versionMadeBy = await this.readU16(cd, pos + 4);
      const versionNeeded = await this.readU16(cd, pos + 6);
      const flags = await this.readU16(cd, pos + 8);
      const compMethod = await this.readU16(cd, pos + 10);
      const lastMod = await this.readU16(cd, pos + 12);
      const crc32 = await this.readU32(cd, pos + 16);
      const compSize = await this.readU32(cd, pos + 20);
      const uncompSize = await this.readU32(cd, pos + 24);
      const nameLen = await this.readU16(cd, pos + 28);
      const extraLen = await this.readU16(cd, pos + 30);
      const commentLen = await this.readU16(cd, pos + 32);
      const localOff = await this.readU32(cd, pos + 42);
      const nameBytes = cd.slice(pos + 46, pos + 46 + nameLen);
      const name = new TextDecoder().decode(nameBytes);

      // Check ZIP64 extra field for large values
      let actualLocalOff = localOff;
      let actualCompSize = compSize;
      let actualUncompSize = uncompSize;
      if (localOff === 0xFFFFFFFF || compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) {
        const extra = cd.slice(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
        let epos = 0;
        while (epos < extra.length - 3) {
          const eid = await this.readU16(extra, epos);
          const esize = await this.readU16(extra, epos + 2);
          if (eid === 0x0001) { // ZIP64 extended information
            let dp = epos + 4;
            if (actualUncompSize === 0xFFFFFFFF) { actualUncompSize = await this.readU64(extra, dp); dp += 8; }
            if (actualCompSize === 0xFFFFFFFF) { actualCompSize = await this.readU64(extra, dp); dp += 8; }
            if (actualLocalOff === 0xFFFFFFFF) { actualLocalOff = await this.readU64(extra, dp); dp += 8; }
            break;
          }
          epos += 4 + esize;
        }
      }

      entries.push({
        name,
        localOffset: actualLocalOff,
        compressedSize: actualCompSize,
        uncompressedSize: actualUncompSize,
        method: compMethod,
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    this._entries = entries;
    return entries;
  }

  async listFiles(pattern) {
    const entries = this._entries || (await this._loadCentralDir());
    if (!pattern) return entries;
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return entries.filter(e => re.test(e.name));
  }

  async extractToFile(entryName, destPath) {
    const entries = this._entries || (await this._loadCentralDir());
    const entry = entries.find(e => e.name === entryName);
    if (!entry) throw new Error(`Entry "${entryName}" not found in remote zip`);

    // Read local file header + data
    const headerLen = 30; // minimum local header size
    const nameLen = entry.name.length;
    const localHeader = await this._fetchRange(entry.localOffset, entry.localOffset + headerLen + nameLen - 1);
    const extraLen = await this.readU16(localHeader, 28);
    const dataStart = entry.localOffset + headerLen + nameLen + extraLen;

    // Download data
    const data = await this._fetchRange(dataStart, dataStart + entry.compressedSize - 1);

    // Decompress if needed
    let finalData = data;
    if (entry.method === 8) {
      const zlib = await import('zlib');
      finalData = await new Promise((resolve, reject) => {
        zlib.inflateRaw(data, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    } else if (entry.method !== 0) {
      throw new Error(`Unsupported compression method: ${entry.method}`);
    }

    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(finalData));
    return { name: entryName, size: finalData.length };
  }
}
