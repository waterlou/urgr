import fs from 'fs';
import path from 'path';
import { getDb, saveDb } from './db.js';
import { all, get, run, runNow } from './helpers.js';

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

  const gameMap = new Map();

  for (const row of allGames) {
    if (shouldIgnore(row.Name || '')) continue;
    const titleId = row['Title ID'] || row.title_id || '';
    const name = row.Name || row.name || '';
    const region = row.Region || row.region || '';
    const pkgUrl = row['PKG direct link'] || row.pkg_url || '';
    const contentId = row['Content ID'] || row.content_id || '';
    const fileSize = parseInt(row['File size'] || row.file_size || '0', 10);
    const sha256 = row.SHA256 || row.sha256 || '';

    const existing = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ?', [versionId, name]);
    if (existing) continue;

    run('INSERT INTO game_entries (version_id, name, description, platform, title_id, content_id) VALUES (?, ?, ?, ?, ?, ?)',
      [versionId, name, region, info.folder, titleId, contentId]);

    const gameEntry = get('SELECT id FROM game_entries WHERE version_id = ? AND name = ?', [versionId, name]);
    if (!gameEntry) continue;

    if (pkgUrl) {
      run('INSERT INTO rom_entries (game_entry_id, filename, size, sha1, subtype) VALUES (?, ?, ?, ?, ?)',
        [gameEntry.id, `${titleId}.pkg`, fileSize || 0, sha256, 'game']);
      romsImported++;
    }

    gameMap.set(titleId, gameEntry.id);
    gamesImported++;
  }

  for (const row of allDlcs) {
    if (shouldIgnore(row.Name || '')) continue;
    const titleId = row['Title ID'] || row.title_id || '';
    const name = row.Name || row.name || '';
    const pkgUrl = row['PKG direct link'] || row.pkg_url || '';
    const fileSize = parseInt(row['File size'] || row.file_size || '0', 10);
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
    const fileSize = parseInt(row['File size'] || row.file_size || '0', 10);
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
  const db = getDb();
  const games = all('SELECT id, name, title_id FROM game_entries WHERE version_id = ?', [versionId]);
  const gameMap = new Map();
  for (const g of games) {
    gameMap.set(g.title_id, g.id);
    gameMap.set(g.name, g.id);
  }

  const found = new Set();
  if (!fs.existsSync(dir)) return { found: 0 };

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.pkg')) continue;
      const titleId = entry.name.replace('.pkg', '').split('_')[0];
      if (gameMap.has(titleId)) found.add(gameMap.get(titleId));
    }
  }
  walk(dir);

  runNow(`
    INSERT INTO game_state (game_entry_id, available, updated_at)
    SELECT ge.id, 0, datetime('now') FROM game_entries ge WHERE ge.version_id = ?
    ON CONFLICT(game_entry_id) DO UPDATE SET available = 0, updated_at = datetime('now')
  `, [versionId]);

  for (const entryId of found) {
    runNow(`
      INSERT INTO game_state (game_entry_id, available, updated_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')
    `, [entryId]);
  }

  return { found: found.size, total: games.length };
}

export async function buildNps(collectionDir, versionId, inputDir, onProgress) {
  const db = getDb();
  const games = all(`
    SELECT g.id, g.name, g.title_id, g.platform,
           r.filename, r.subtype, r.size as rom_size, r.sha1 as rom_sha1
    FROM game_entries g
    LEFT JOIN rom_entries r ON r.game_entry_id = g.id
    WHERE g.version_id = ?
  `, [versionId]);

  const gameGroups = new Map();
  for (const row of games) {
    if (!gameGroups.has(row.id)) {
      gameGroups.set(row.id, { ...row, roms: [] });
    }
    if (row.filename) {
      gameGroups.get(row.id).roms.push({
        filename: row.filename,
        subtype: row.subtype,
        size: row.rom_size,
        sha1: row.rom_sha1,
      });
    }
  }

  let built = 0;
  let skipped = 0;
  let total = 0;

  for (const [, game] of gameGroups) {
    for (const rom of game.roms) {
      total++;
      const subtypeDir = rom.subtype === 'dlc' ? 'DLCs' : rom.subtype === 'update' ? 'Updates' : 'Games';
      const destDir = path.join(collectionDir, game.platform || 'Games', subtypeDir);
      fs.mkdirSync(destDir, { recursive: true });

      const destFile = path.join(destDir, rom.filename);
      const srcFile = inputDir ? path.join(inputDir, rom.filename) : null;

      if (fs.existsSync(destFile)) {
        skipped++;
        continue;
      }

      if (srcFile && fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, destFile);
        built++;
        if (onProgress) onProgress({ built, skipped, total, msg: `Copied ${rom.filename}` });
      } else if (rom.size && rom.size > 0) {
        const gameInfo = get('SELECT content_id FROM game_entries WHERE id = ?', [game.id]);
        if (gameInfo && gameInfo.content_id) {
          try {
            const url = `https://d2wy0z66aukln1.cloudfront.net/${gameInfo.content_id}/${rom.filename}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (resp.ok) {
              const buffer = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(destFile, buffer);
              built++;
              if (onProgress) onProgress({ built, skipped, total, msg: `Downloaded ${rom.filename}` });
            } else {
              skipped++;
            }
          } catch {
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
  }

  return { built, skipped, total };
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

export { NPS_PLATFORMS, NPS_PLATFORM_MAP };
