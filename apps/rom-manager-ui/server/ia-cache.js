// IA item cache — persists (source, version) → IA item identifier mappings
// Uses a simple JSON file at data/ia-cache.json

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', '..', '..', 'data', 'ia-cache.json');

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      cache = JSON.parse(raw);
    }
  } catch (e) {
    console.error('[ia-cache] read error:', e.message);
  }
  cache = cache || {};
  return cache;
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[ia-cache] write error:', e.message);
  }
}

export function getCachedId(source, version) {
  const c = loadCache();
  const key = `${source}:${version || ''}`;
  const entry = c[key];
  if (!entry) return null;
  return entry.identifier;
}

export function setCachedId(source, version, identifier) {
  const c = loadCache();
  const key = `${source}:${version || ''}`;
  c[key] = { identifier, updated_at: new Date().toISOString() };
  saveCache();
}
