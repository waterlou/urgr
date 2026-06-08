import fs from 'fs';
import path from 'path';
import { getDb, saveDb } from './db.js';
import { all, get, run, runNow } from './helpers.js';
import { execCli } from './cli.js';

const NPS_BASE_URL = 'https://nopaystation.com/tsv';
const NPS_PLATFORMS = ['PSV', 'PS3', 'PSP', 'PSX', 'PSM'];

const NPS_PLATFORM_MAP = {
  PSV: { name: 'PlayStation Vita', folder: 'PSV', hasDlcs: true, hasUpdates: true },
  PS3: { name: 'PlayStation 3', folder: 'PS3', hasDlcs: true, hasUpdates: true },
  PSP: { name: 'PlayStation Portable', folder: 'PSP', hasDlcs: true, hasUpdates: true },
  PSX: { name: 'PlayStation', folder: 'PSX', hasDlcs: false, hasUpdates: false },
  PSM: { name: 'PlayStation Mobile', folder: 'PSM', hasDlcs: false, hasUpdates: false },
};

function getTsvUrls(platform) {
  const urls = [`${NPS_BASE_URL}/${platform}_GAMES.tsv`];
  const info = NPS_PLATFORM_MAP[platform];
  if (info.hasDlcs) urls.push(`${NPS_BASE_URL}/${platform}_DLCS.tsv`);
  if (info.hasUpdates) urls.push(`${NPS_BASE_URL}/${platform}_UPDATES.tsv`);
  return urls;
}

function parseTsvLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === '\t' && !inQuotes) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseTsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseTsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseTsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (vals[j] || '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

function shouldIgnore(name) {
  const lower = name.toLowerCase();
  return lower.includes('theme') || lower.includes('demo');
}

// Strip firmware/version suffixes for grouping: "(3.61+!) [3.63]" -> ""
function normalizeForGroup(name) {
  return name.replace(/\s*\([\d.]+\+?!\)\s*/g, '').replace(/\s*\[[\d.]+\]\s*/g, '').trim();
}

async function fetchTsv(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return await resp.text();
}

export async function importNps(platform, versionId) {
  const db = getDb();
  const info = NPS_PLATFORM_MAP[platform];
  if (!info) throw new Error(`Unknown NPS platform: ${platform}`);

  const urls = getTsvUrls(platform);
  const allGames = [];
  const allDlcs = [];
  const allUpdates = [];

  for (const url of urls) {
    try {
      const text = await fetchTsv(url);
      const rows = parseTsv(text);
      const type = url.includes('_GAMES') ? 'games' : url.includes('_DLCS') ? 'dlcs' : 'updates';
      if (type === 'games') allGames.push(...rows);
      else if (type === 'dlcs') allDlcs.push(...rows);
      else allUpdates.push(...rows);
    } catch (e) {
      console.error(`Failed to fetch ${url}: ${e.message}`);
    }
  }

  if (allGames.length === 0) {
    throw new Error(`No games found for platform ${platform}`);
  }

  let gamesImported = 0;
  let romsImported = 0;

  // Group by normalized name — strip firmware suffixes like "(3.61+!) [3.63]"
  // Each group becomes: 1 parent (cloneof=NULL) + N clones (one per regional variant)
  const grouped = new Map();
  for (const row of allGames) {
    if (shouldIgnore(row.Name || '')) continue;
    const pkgUrl = row['PKG direct link'] || row.pkg_url || '';
    if (!pkgUrl || pkgUrl === 'MISSING') continue;

    const name = row.Name || row.name || '';
    const groupKey = normalizeForGroup(name);
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        variants: [],
        originalName: row['Original Name'] || row.original_name || '',
      });
    }
    const g = grouped.get(groupKey);
    // Split multi-region TSV values into individual variants (one region each)
    const rawRegion = row.Region || row.region || '';
    const regions = rawRegion.split(/,\s*/).map(r => r.trim()).filter(Boolean);
    for (const region of regions) {
      g.variants.push({
        name,
        titleId: row['Title ID'] || '',
        contentId: row['Content ID'] || '',
        region,
        pkgUrl,
        pkgFilename: pkgUrl.split('/').pop() || `${row['Title ID'] || ''}.pkg`,
        fileSize: parseInt(row['File Size'] || row.file_size || '0', 10),
        sha256: row.SHA256 || row.sha256 || '',
        originalName: row['Original Name'] || row.original_name || '',
      });
    }
    if (!g.originalName) g.originalName = row['Original Name'] || row.original_name || '';
  }

  for (const [groupKey, g] of grouped) {
    const parentName = groupKey;

    // Determine preferred parent region: US first, then JP, then first available
    let parentVariant = g.variants.find(v => v.region === 'US');
    if (!parentVariant) parentVariant = g.variants.find(v => v.region === 'JP');
    if (!parentVariant) parentVariant = g.variants[0];

    // Skip if parent already exists
    const existing = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ? AND region = ? AND cloneof IS NULL', [versionId, parentName, parentVariant.region]);
    if (existing) continue;

    // Create parent game — one region only (parent's region)
    run('INSERT INTO game_entries (version_id, name, description, year, platform, title_id, content_id, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [versionId, parentName, g.originalName, '', info.folder, parentVariant.titleId, parentVariant.contentId, parentVariant.region]);
    gamesImported++;

    // Create ROM for parent
    const parentId = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ? AND cloneof IS NULL', [versionId, parentName])?.id;
    if (parentId) {
      run('INSERT INTO rom_entries (game_entry_id, filename, size, sha1, subtype) VALUES (?, ?, ?, ?, ?)',
        [parentId, parentVariant.pkgFilename, parentVariant.fileSize || 0, parentVariant.sha256, 'game']);
      romsImported++;
    }

    // Create clones for other variants
    if (g.variants.length <= 1) continue;

    const clonesSeen = new Set();
    for (const v of g.variants) {
      if (v === parentVariant) continue;

      // Use original TSV name (UNIQUE constraint is on name+year, so same name different region is fine)
      const cloneName = v.name;

      // Deduplicate if multiple variants share name+region
      const key = `${cloneName}|${v.region}`;
      if (clonesSeen.has(key)) continue;
      clonesSeen.add(key);

      const cloneEntry = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ? AND region = ?', [versionId, cloneName, v.region]);
      if (cloneEntry) continue;

      // Clone gets one region only
      run('INSERT INTO game_entries (version_id, name, description, year, cloneof, platform, title_id, content_id, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [versionId, cloneName, g.originalName, '', parentName, info.folder, v.titleId, v.contentId, v.region]);
      gamesImported++;

      const cloneGame = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ? AND region = ?', [versionId, cloneName, v.region]);
      if (!cloneGame) continue;

      run('INSERT INTO rom_entries (game_entry_id, filename, size, sha1, subtype) VALUES (?, ?, ?, ?, ?)',
        [cloneGame.id, v.pkgFilename, v.fileSize || 0, v.sha256, 'game']);
      romsImported++;
    }
  }

  // Map titleIds to gameEntryIds for DLC/update linking (map to clones)
  const gameMap = new Map();
  for (const row of allGames) {
    const titleId = row['Title ID'] || row.title_id || '';
    const name = row.Name || row.name || '';
    const gameEntry = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ? AND cloneof IS NOT NULL', [versionId, name]);
    if (gameEntry) gameMap.set(titleId, gameEntry.id);
  }

  for (const row of allDlcs) {
    if (shouldIgnore(row.Name || '')) continue;
    const titleId = row['Title ID'] || row.title_id || '';
    const name = row.Name || row.name || '';
    const pkgUrl = row['PKG direct link'] || row.pkg_url || '';
    const fileSize = parseInt(row['File Size'] || row.file_size || '0', 10);
    const sha256 = row.SHA256 || row.sha256 || '';

    const gameEntryId = gameMap.get(titleId);
    if (!gameEntryId) continue;

    const existing = get('SELECT id FROM rom_entries WHERE game_entry_id = ? AND filename = ?',
      [gameEntryId, `${titleId}_dlc_${name}.pkg`]);
    if (existing) continue;

    run('INSERT INTO rom_entries (game_entry_id, filename, size, sha1, subtype) VALUES (?, ?, ?, ?, ?)',
      [gameEntryId, `${titleId}_dlc_${name}.pkg`, fileSize || 0, sha256, 'dlc']);
    romsImported++;
  }

  for (const row of allUpdates) {
    if (shouldIgnore(row.Name || '')) continue;
    const titleId = row['Title ID'] || row.title_id || '';
    const name = row.Name || row.name || '';
    const pkgUrl = row['PKG direct link'] || row.pkg_url || '';
    const fileSize = parseInt(row['File Size'] || row.file_size || '0', 10);
    const sha256 = row.SHA256 || row.sha256 || '';

    const gameEntryId = gameMap.get(titleId);
    if (!gameEntryId) continue;

    const existing = get('SELECT id FROM rom_entries WHERE game_entry_id = ? AND filename = ?',
      [gameEntryId, `${titleId}_update_${name}.pkg`]);
    if (existing) continue;

    run('INSERT INTO rom_entries (game_entry_id, filename, size, sha1, subtype) VALUES (?, ?, ?, ?, ?)',
      [gameEntryId, `${titleId}_update_${name}.pkg`, fileSize || 0, sha256, 'update']);
    romsImported++;
  }

  return { gamesImported, romsImported, platform };
}

export function scanNpsDir(dir, versionId) {
  const result = execCli(['scan', String(versionId), dir], { binary: 'nps' });
  return { found: result.found, total: result.total };
}

export function buildNps(collectionDir, versionId, inputDir) {
  const args = ['build', String(versionId), collectionDir];
  if (inputDir) args.push('--input-dir', inputDir);
  const result = execCli(args, { binary: 'nps' });
  return { built: result.built, skipped: result.skipped, total: result.total };
}

export async function fetchSonyScreenshots(contentId, titleId) {
  if (!contentId && !titleId) return [];

  const regions = ['us', 'eu', 'jp'];
  const langs = ['en', 'en-3', 'ja'];

  for (const region of regions) {
    for (const lang of langs) {
      try {
        const url = `https://store.playstation.com/store/api/chihiro/00_09_000/container/${region}/${lang}/${contentId || titleId}`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) continue;
        const data = await resp.json();

        const screenshots = [];
        if (data?.metadata?.hero_image?.urls) {
          for (const img of data.metadata.hero_image.urls) {
            if (img.url) screenshots.push(img.url);
          }
        }
        if (data?.metadata?.screens) {
          for (const screen of data.metadata.screens) {
            if (screen.url) screenshots.push(screen.url);
          }
        }
        if (screenshots.length > 0) return screenshots.slice(0, 5);
      } catch {
        continue;
      }
    }
  }

  return [];
}

export { NPS_PLATFORMS, NPS_PLATFORM_MAP, parseTsvLine, parseTsv, shouldIgnore, normalizeForGroup };
