import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { dataDir } from './paths.js';

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
};

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4'];

const CACHE_SOURCES = [
  {
    name: 'arcadedb',
    hostPattern: 'adb.arcadeitalia.net',
    cacheDir: path.join(dataDir, 'media', 'arcadedb'),
    mountPrefix: '/media/arcadedb/',
    timeout: 15000,
  },
  {
    name: 'libretro-thumbnails',
    hostPattern: 'thumbnails.libretro.com',
    cacheDir: path.join(dataDir, 'media', 'libretro-thumbnails'),
    mountPrefix: '/media/libretro-thumbnails/',
    timeout: 10000,
  },
  {
    name: 'sony-store',
    hostPattern: 'playstation',
    cacheDir: path.join(dataDir, 'media', 'sony-store'),
    mountPrefix: '/media/sony-store/',
    timeout: 10000,
  },
  {
    name: 'igdb',
    hostPattern: 'images.igdb.com',
    cacheDir: path.join(dataDir, 'media', 'igdb'),
    mountPrefix: '/media/igdb/',
    timeout: 10000,
  },
  {
    name: 'mobygames',
    hostPattern: 'mobygames.com',
    cacheDir: path.join(dataDir, 'media', 'mobygames'),
    mountPrefix: '/media/mobygames/',
    timeout: 15000,
  },
  {
    name: 'retroachievements',
    hostPattern: 'retroachievements.org',
    cacheDir: path.join(dataDir, 'media', 'retroachievements'),
    mountPrefix: '/media/retroachievements/',
    timeout: 15000,
  },
  {
    name: 'steamgriddb',
    hostPattern: 'steamgriddb.com',
    cacheDir: path.join(dataDir, 'media', 'steamgriddb'),
    mountPrefix: '/media/steamgriddb/',
    timeout: 10000,
  },
];

async function findLocalFile(cacheDir, gameName, mediaType) {
  const dir = path.join(cacheDir, gameName);
  try {
    await fsp.access(dir);
  } catch {
    return null;
  }
  for (const ext of EXTENSIONS) {
    const fp = path.join(dir, mediaType + ext);
    try {
      await fsp.access(fp);
      return fp;
    } catch { continue; }
  }
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
  return { data, mime: MIME_MAP[ext] || 'application/octet-stream' };
}

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

export async function getMedia(url, gameName, mediaType) {
  // Direct mount-prefix match: resolve the full relative path from the URL
  for (const source of CACHE_SOURCES) {
    if (url.startsWith(source.mountPrefix)) {
      const relativePath = url.slice(source.mountPrefix.length);
      const filePath = path.join(source.cacheDir, relativePath);
      try {
        await fsp.access(filePath);
        return readCached(filePath);
      } catch {}
    }
  }

  for (const source of CACHE_SOURCES) {
    if (typeof url === 'string' && url.includes(source.hostPattern)) {
      // Try cache with flat structure (legacy files)
      const cached = await findLocalFile(source.cacheDir, gameName, mediaType);
      if (cached) {
        const relPath = path.relative(source.cacheDir, cached);
        const localData = await readCached(cached);
        return { ...localData, localUrl: source.mountPrefix + relPath };
      }

      // For libretro-thumbnails, also try structured path from URL
      if (source.name === 'libretro-thumbnails') {
        try {
          const parsed = new URL(url);
          const urlPath = parsed.pathname.replace(/^\//, '');
          const structuredPath = path.join(source.cacheDir, urlPath);
          await fsp.access(structuredPath);
          const data = await readCached(structuredPath);
          return { ...data, localUrl: source.mountPrefix + urlPath };
        } catch {}
      }

      const result = await fetchWithTimeout(url, source.timeout);
      if (result) {
        const { buf, contentType } = result;
        const ext = extFromContentType(contentType);

        // For libretro-thumbnails, preserve the full URL path structure
        if (source.name === 'libretro-thumbnails') {
          try {
            const parsed = new URL(url);
            const urlPath = parsed.pathname.replace(/^\//, '');
            const cachedPath = path.join(source.cacheDir, urlPath);
            await fsp.mkdir(path.dirname(cachedPath), { recursive: true });
            await fsp.writeFile(cachedPath, buf);
            return {
              data: buf,
              mime: MIME_MAP[ext] || contentType || 'application/octet-stream',
              localUrl: source.mountPrefix + urlPath,
            };
          } catch {}
        }

        // Default flat structure: {cacheDir}/{gameName}/{mediaType}.{ext}
        const gameDir = path.join(source.cacheDir, gameName);
        const cachedPath = path.join(gameDir, mediaType + ext);
        try {
          await fsp.mkdir(gameDir, { recursive: true });
          await fsp.writeFile(cachedPath, buf);
        } catch {
          return { data: buf, mime: MIME_MAP[ext] || contentType || 'application/octet-stream' };
        }
        return {
          data: buf,
          mime: MIME_MAP[ext] || contentType || 'application/octet-stream',
          localUrl: source.mountPrefix + gameName + '/' + mediaType + ext,
        };
      }
    }
  }

  const result = await fetchWithTimeout(url, 10000);
  if (result) {
    return { data: result.buf, mime: result.contentType || 'application/octet-stream' };
  }

  return null;
}

export { CACHE_SOURCES, findLocalFile };
