import fs from 'fs';
import fsp from 'fs/promises';
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

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4'];

// Find a locally cached file by game name and media type, probing extensions
async function findLocalFile(gameName, mediaType) {
  const dir = path.join(ARCADEDB_CACHE, gameName);
  try {
    await fsp.access(dir);
  } catch {
    return null;
  }
  // Try exact match from list first
  for (const ext of EXTENSIONS) {
    const fp = path.join(dir, mediaType + ext);
    try {
      await fsp.access(fp);
      return fp;
    } catch { continue; }
  }
  // Fallback: scan directory
  try {
    const entries = await fsp.readdir(dir);
    const entry = entries.find(f => f.startsWith(mediaType + '.'));
    return entry ? path.join(dir, entry) : null;
  } catch {
    return null;
  }
}

async function readCached(localPath) {
  const data = await fsp.readFile(localPath);
  const ext = path.extname(localPath).toLowerCase();
  return { data, mime: MIME_MAP[ext] || 'application/octet-stream', cachedPath: localPath };
}

// Fetch a URL with a timeout, returning the buffer and content-type
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return { buf, contentType: resp.headers.get('content-type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extFromContentType(contentType) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('mp4') || contentType.includes('video')) return '.mp4';
  return '.jpg';
}

// Get media: returns { data: Buffer, mime: string, cachedPath?: string } from cache or remote
export async function getMedia(url, gameName, mediaType) {
  // 1. Already a local path — read from cache
  if (url.startsWith('/media/arcadedb/')) {
    const localPath = await findLocalFile(gameName, mediaType);
    if (localPath) return readCached(localPath);
  }

  // 2. Remote ArcadeDB URL — check cache first, fetch on miss
  if (typeof url === 'string' && url.includes('adb.arcadeitalia.net')) {
    const cached = await findLocalFile(gameName, mediaType);
    if (cached) return readCached(cached);

    // Cache miss — fetch and save
    const result = await fetchWithTimeout(url, 15000);
    if (result) {
      const { buf, contentType } = result;
      const ext = extFromContentType(contentType);
      const cacheDir = path.join(ARCADEDB_CACHE, gameName);
      const cachedPath = path.join(cacheDir, mediaType + ext);
      try {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(cachedPath, buf);
      } catch (e) {
        // Cache write failure is non-fatal — we can still return the fetched data
        return { data: buf, mime: MIME_MAP[ext] || contentType || 'application/octet-stream' };
      }
      return { data: buf, mime: MIME_MAP[ext] || contentType || 'application/octet-stream', cachedPath };
    }
  }

  // 3. Other remote URL — fetch directly
  const result = await fetchWithTimeout(url, 10000);
  if (result) {
    return { data: result.buf, mime: result.contentType || 'application/octet-stream' };
  }

  return null;
}
