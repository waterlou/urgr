import fs from 'fs';
import path from 'path';
import { dataDir } from './paths.js';

const ARCADEDB_CACHE = path.join(dataDir, 'arcadedb');

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
};

const MEDIA_TYPES = ['title', 'ingame', 'marquee', 'cabinet', 'flyer', 'icon', 'shortplay'];

// Find a locally cached file by game name and media type, probing extensions
function findLocalFile(gameName, mediaType) {
  const dir = path.join(ARCADEDB_CACHE, gameName);
  if (!fs.existsSync(dir)) return null;
  // Try exact match from list
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4']) {
    const fp = path.join(dir, mediaType + ext);
    if (fs.existsSync(fp)) return fp;
  }
  // Fallback: scan directory
  const entry = fs.readdirSync(dir).find(f => f.startsWith(mediaType + '.'));
  return entry ? path.join(dir, entry) : null;
}

// Get media: returns { data: Buffer, mime: string, cachedPath?: string } from cache or remote
export async function getMedia(url, gameName, mediaType) {
  // 1. Already local path
  if (url.startsWith('/media/arcadedb/')) {
    const localPath = findLocalFile(gameName, mediaType);
    if (localPath) {
      const ext = path.extname(localPath).toLowerCase();
      return { data: fs.readFileSync(localPath), mime: MIME_MAP[ext] || 'application/octet-stream', cachedPath: localPath };
    }
  }

  // 2. Remote ArcadeDB URL — check cache first, fetch on miss
  if (typeof url === 'string' && url.includes('adb.arcadeitalia.net')) {
    const cached = findLocalFile(gameName, mediaType);
    if (cached) {
      const ext = path.extname(cached).toLowerCase();
      return { data: fs.readFileSync(cached), mime: MIME_MAP[ext] || 'application/octet-stream', cachedPath: cached };
    }
    // Cache miss — fetch and save
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get('content-type') || '';
        const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
        // Save to cache
        const cacheDir = path.join(ARCADEDB_CACHE, gameName);
        fs.mkdirSync(cacheDir, { recursive: true });
        const cachedPath = path.join(cacheDir, mediaType + ext);
        fs.writeFileSync(cachedPath, buf);
        const mime = MIME_MAP[ext] || contentType || 'application/octet-stream';
        return { data: buf, mime, cachedPath };
      }
    } catch { clearTimeout(timeout); }
  }

  // 3. Other remote URL — fetch directly
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      return { data: buf, mime: resp.headers.get('content-type') || 'application/octet-stream' };
    }
  } catch { clearTimeout(timeout); }

  return null;
}

// Remove unused `precacheArcadeMedia` — lazy caching via getMedia is sufficient
