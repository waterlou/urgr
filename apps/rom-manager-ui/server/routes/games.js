import { Router } from 'express';
import crypto, { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getDb } from '../db.js';
import { execCli, execCliStream } from '../cli.js';
import { createJob, updateProgress, doneJob, failJob } from '../jobs.js';
import { all, get, run, runNow, dbReady } from '../helpers.js';
import { getAuth } from '../ia-auth.js';
import { getCachedId, setCachedId } from '../ia-cache.js';
import { dataDir } from '../paths.js';
import { getMedia } from '../mediaCache.js';
import { syncGameAvailability } from '../operations/syncAvailability.js';

const router = Router();

// Load translations for localized game titles
let translationsData = null;
let translationsByName = null;
let translationsByDesc = null;

function loadTranslations() {
  const p = path.join(dataDir, 'translations.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    translationsData = raw;
    translationsByName = raw;
    translationsByDesc = {};
    for (const [name, entry] of Object.entries(raw)) {
      if (entry.description) {
        translationsByDesc[entry.description] = name;
      }
    }
  } catch {
    translationsData = {};
    translationsByName = {};
    translationsByDesc = {};
  }
}

function getTranslations(name, description) {
  let entry = translationsByName?.[name];
  if (!entry && description) {
    const n = translationsByDesc?.[description];
    if (n) entry = translationsByName[n];
  }
  return entry?.translations || null;
}

// Load on startup
loadTranslations();

function gameRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    synopsis: row.synopsis || '',
    year: row.year,
    manufacturer: row.manufacturer,
    cloneof: row.cloneof || null,
    parent_game_id: row.parent_game_id,
    platform: row.platform || '',
    version_id: row.version_id,
    source: row.source || '',
    version: row.version,
    region: '',
  };
}

// Attach covers/screenshots from game_media by game name + platform
function attachMedia(games) {
  if (!games || games.length === 0) return games;
  const names = [...new Set(games.flatMap(g => [g.name, g.cloneof].filter(Boolean)))];
  const ph = names.map(() => '?').join(',');
  const mediaRows = all(`SELECT gm.name, gm.platform, gm.covers, gm.screenshots, gm.fanarts, gm.videos FROM game_media gm WHERE gm.name IN (${ph})`, names);
  const mediaMap = {};
  for (const m of mediaRows) {
    let covers = []; let screenshots = []; let fanarts = []; let videos = [];
    try { covers = JSON.parse(m.covers) || []; } catch {}
    try { screenshots = JSON.parse(m.screenshots) || []; } catch {}
    try { fanarts = JSON.parse(m.fanarts) || []; } catch {}
    try { videos = JSON.parse(m.videos) || []; } catch {}
    mediaMap[m.name + '|||' + (m.platform || '')] = { covers, screenshots, fanarts, videos };
  }
  const psDir = path.join(dataDir, 'media', 'progettosnaps');

  return games.map(g => {
    let covers, screenshots;
    const plat = (g.platform || '').trim() || 'arcade';

    // Prefer progettosnaps pre-downloaded files over scraped URLs
    try {
      if (fs.existsSync(path.join(psDir, 'title', g.name + '.png'))) {
        covers = [`/media/progettosnaps/title/${g.name}.png`];
      }
    } catch {}
    try {
      if (fs.existsSync(path.join(psDir, 'snap', g.name + '.png'))) {
        screenshots = [`/media/progettosnaps/snap/${g.name}.png`];
      }
    } catch {}
    const mediaKey = g.name + '|||' + plat;
    const cloneofKey = g.cloneof ? g.cloneof + '|||' + plat : null;
    if (!covers) covers = mediaMap[mediaKey]?.covers || (cloneofKey ? mediaMap[cloneofKey]?.covers : null) || [];
    if (!screenshots) screenshots = mediaMap[mediaKey]?.screenshots || (cloneofKey ? mediaMap[cloneofKey]?.screenshots : null) || [];

    return {
      ...g,
      covers,
      screenshots,
      fanarts: mediaMap[mediaKey]?.fanarts || (cloneofKey ? mediaMap[cloneofKey]?.fanarts : null) || [],
      videos: mediaMap[mediaKey]?.videos || (cloneofKey ? mediaMap[cloneofKey]?.videos : null) || [],
    };
  });
}

// Build versions_tags and versions array from comma-separated GROUP_CONCAT
function parseVersions(g) {
  const vt = g.versions_tags || '';
  const pairs = vt ? vt.split(',').filter(Boolean) : [];
  const versions = pairs.map(p => { const [src, ver] = p.split('||'); return ver || p; });
  return { ...g, versions, versions_tags: undefined };
}

// Get the scrape_mode for a version's collection.
// 'parent' (default): for clones, search by parent name — all clones share parent's media
// 'individual': search by each game's own name — each variant gets its own search
function getScrapeMode(versionId) {
  if (!versionId) return 'parent';
  const col = get(`SELECT scrape_mode FROM collections c
    JOIN set_versions sv ON sv.collection_id = c.id
    WHERE sv.id = ?`, [versionId]);
  return col?.scrape_mode || 'parent';
}

// Compute the canonical name used for game_media lookups.
// In 'parent' mode (default), clones share their parent's media.
// In 'individual' mode, each game is scraped separately.
function canonicalName(game, scrapeMode) {
  return (scrapeMode === 'individual') ? game.name : (game.cloneof || game.name);
}

// Get the set of enabled scrape sources for a collection (based on scrape_source_priority).
// Returns null if not configured (all sources allowed), or an empty Set if all disabled.
function getEnabledSourceSet(collectionId) {
  if (!collectionId) return null;
  const col = get('SELECT scrape_source_priority FROM collections WHERE id = ?', [collectionId]);
  if (!col?.scrape_source_priority) return null;
  try {
    const arr = JSON.parse(col.scrape_source_priority);
    return Array.isArray(arr) ? new Set(arr) : null;
  } catch { return null; }
}

// Fetch a game with its rom_set and version joined — INNER JOIN variant.
// Returns null if the game has no rom_set (e.g. game exists but is not in any version).
// Used by routes that require a rom_set: availability, play, download-ia.
function fetchGameWithRomSet(gameId, versionId) {
  const params = [gameId];
  let versionClause = '';
  if (versionId) {
    versionClause = 'AND grs.version_id = ?';
    params.push(versionId);
  }
  return get(`
    SELECT g.*, parent_g.name as cloneof,
      grs.version_id, grs.romof, sv.version, c.dataset_preset as source
    FROM games g
    JOIN collections c ON c.id = g.collection_id
    LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
    JOIN game_rom_sets grs ON grs.game_id = g.id
    JOIN set_versions sv ON sv.id = grs.version_id
    WHERE g.id = ? ${versionClause}
    ORDER BY grs.version_id ASC LIMIT 1
  `, params);
}

// Fetch a game with optional rom_set and version joined — LEFT JOIN variant.
// Returns the game even if it has no rom_set. version_id/source/version will be null.
// Used by routes that should still work for orphan games: detail, scrape, media.
function fetchGameOptionalRomSet(gameId, versionId) {
  const params = [gameId];
  let versionClause = '';
  if (versionId) {
    versionClause = 'AND grs.version_id = ?';
    params.push(versionId);
  }
  return get(`
    SELECT g.*, parent_g.name as cloneof,
      grs.version_id, grs.romof, sv.version, c.dataset_preset as source
    FROM games g
    LEFT JOIN collections c ON c.id = g.collection_id
    LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
    LEFT JOIN game_rom_sets grs ON grs.game_id = g.id
    LEFT JOIN set_versions sv ON sv.id = grs.version_id
    WHERE g.id = ? ${versionClause}
    ORDER BY grs.version_id ASC LIMIT 1
  `, params);
}

router.get('/', async (req, res) => {
  await dbReady;
  try {
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, collection_id, version_id, parents_only, favourites_only, roms_only, year, manufacturer } = req.query;
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    let where = ["(g.runnable != 0 OR g.runnable IS NULL)"];
    let params = [];

    if (q) {
      where.push('(g.name LIKE ? OR g.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (collection_id) {
      const vids = all('SELECT id as version_id FROM set_versions WHERE collection_id = ?', [collection_id]).map(v => v.version_id);
      if (!vids.length) return res.json({ games: [], total: 0, limit: Number(limit), offset: Number(offset) });
      const ph = vids.map(() => '?').join(',');
      where.push(`grs.version_id IN (${ph})`);
      params.push(...vids);
    }
    if (version_id) {
      where.push('grs.version_id = ?');
      params.push(version_id);
    }
    if (parents_only === 'true') {
      where.push('g.parent_game_id IS NULL');
    }
    if (favourites_only === 'true') {
      where.push('COALESCE(gs.favourite, 0) = 1');
    }
    if (roms_only === 'true') {
      where.push('COALESCE(gs.available, 0) = 1');
    }
    if (year) {
      where.push('g.year = ?');
      params.push(year);
    }
    if (manufacturer) {
      where.push('g.manufacturer = ?');
      params.push(manufacturer);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countSql = `SELECT COUNT(DISTINCT g.id) as c FROM games g
      JOIN game_rom_sets grs ON grs.game_id = g.id
      JOIN set_versions sv ON sv.id = grs.version_id
      LEFT JOIN game_state gs ON gs.game_id = g.id
      ${whereClause}`;
    const total = params.length ? get(countSql, params).c : get(countSql).c;

    const sortCol = sort === 'rating' ? 'MAX(COALESCE(gs.rating, 0))' : sort === 'play_count' ? 'MAX(COALESCE(gs.play_count, 0))' : sort === 'year' ? 'CAST(g.year AS INTEGER)' : sort === 'manufacturer' ? 'g.manufacturer' : 'g.name';
    const pageParams = [...params, Number(limit), Number(offset)];

    let games = all(`
      SELECT g.id, g.name, g.description, g.year, g.manufacturer,
        parent_g.name as cloneof, g.parent_game_id, g.platform,
        MIN(grs.version_id) as version_id,
        MIN(c.dataset_preset) as source,
        GROUP_CONCAT(c.dataset_preset || '||' || sv.version, ',') as versions_tags,
        MAX(COALESCE(gs.rating, 0)) as rating,
        MAX(COALESCE(gs.favourite, 0)) as favourite,
        MAX(COALESCE(gs.play_count, 0)) as play_count
      FROM games g
      JOIN game_rom_sets grs ON grs.game_id = g.id
      JOIN set_versions sv ON sv.id = grs.version_id
      JOIN collections c ON c.id = g.collection_id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      LEFT JOIN game_state gs ON gs.game_id = g.id
      ${whereClause}
      GROUP BY g.id
      ORDER BY ${sortCol} ${sortDir} NULLS LAST
      LIMIT ? OFFSET ?
    `, pageParams);

    games = games.map(parseVersions);
    games = attachMedia(games);

    res.json({ games, total, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scrape-jobs', async (req, res) => {
  await dbReady;
  try {
    const jobs = all('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 10');
    res.json(jobs.map(j => ({
      ...j,
      result: j.result ? JSON.parse(j.result) : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/recently-played', async (req, res) => {
  await dbReady;
  try {
    const games = all(`
      SELECT g.id, g.name, g.description, g.year, g.manufacturer,
        parent_g.name as cloneof, g.parent_game_id, g.platform,
        MIN(grs.version_id) as version_id,
        MIN(c.dataset_preset) as source,
        GROUP_CONCAT(c.dataset_preset || '||' || sv.version, ',') as versions_tags,
        rp.played_at
      FROM recently_played rp
      JOIN games g ON g.id = rp.game_id
      JOIN collections c ON c.id = g.collection_id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      LEFT JOIN game_rom_sets grs ON grs.game_id = g.id
      LEFT JOIN set_versions sv ON sv.id = grs.version_id
      GROUP BY g.id
      ORDER BY rp.played_at DESC
      LIMIT 6
    `).map(parseVersions);
    res.json({ games: attachMedia(games) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  await dbReady;
  try {
    const versionId = req.query.version_id || null;
    const game = fetchGameOptionalRomSet(req.params.id, versionId);
    if (!game) return res.status(404).json({ error: 'not found' });
    if (typeof game.synopsis === 'string') try { game.synopsis = JSON.parse(game.synopsis); } catch {}

    // Determine canonical name for game_media lookup (respects collection's scrape_mode)
    const scrapeMode = getScrapeMode(game.version_id);
    const canonical = canonicalName(game, scrapeMode);
    const mediaPlat = (game.platform || '').trim() || 'arcade';
  const enabledSet = getEnabledSourceSet(game.collection_id);
    const media = get('SELECT covers, screenshots, fanarts, videos, source, synopsis as media_synopsis FROM game_media WHERE name = ? AND platform = ?', [canonical, mediaPlat]);

    let covers = [];
    let screenshots = [];
    let fanarts = [];
    let videos = [];
    if (media) {
      if (!enabledSet || enabledSet.has(media.source || '')) {
        try { covers = JSON.parse(media.covers) || []; } catch {}
        try { screenshots = JSON.parse(media.screenshots) || []; } catch {}
        try { fanarts = JSON.parse(media.fanarts) || []; } catch {}
        try { videos = JSON.parse(media.videos) || []; } catch {}
      }
      if (!game.synopsis && media.media_synopsis) game.synopsis = media.media_synopsis;
    }

    // Prefer progettosnaps local files over scraped URLs
    if (!enabledSet || enabledSet.has('progettosnaps')) {
      try {
        if (fs.existsSync(path.join(dataDir, 'media', 'progettosnaps', 'title', game.name + '.png'))) {
          covers = [`/media/progettosnaps/title/${game.name}.png`];
        }
      } catch {}
      try {
        if (fs.existsSync(path.join(dataDir, 'media', 'progettosnaps', 'snap', game.name + '.png'))) {
          screenshots = [`/media/progettosnaps/snap/${game.name}.png`];
        }
      } catch {}
    }

    const roms = game.version_id != null ? all(`
      SELECT grf.* FROM game_rom_files grf
      JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
      WHERE grs.game_id = ? AND grs.version_id = ?
      ORDER BY grf.filename
    `, [game.id, game.version_id]) : [];

    const state = get('SELECT * FROM game_state WHERE game_id = ?', [game.id]);

    // Clones: other games that have this game as parent, within any version
    const clones = all(`
      SELECT g.id, g.name, g.description, parent_g.name as cloneof
      FROM games g
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      WHERE g.parent_game_id = ? AND g.id != ?
      ORDER BY g.name
    `, [game.parent_game_id || game.id, game.id]);

    let parent = null;
    if (game.parent_game_id) {
      const p = get('SELECT id, name FROM games WHERE id = ?', [game.parent_game_id]);
      if (p) parent = { id: p.id, name: p.name, region: '' };
    }

    res.json({
      ...gameRow(game),
      covers, screenshots, fanarts, videos, roms,
      rating: state?.rating || 0,
      favourite: state?.favourite || 0,
      available: state?.available || 0,
      play_count: state?.play_count || 0,
      clones, parent,
      translations: getTranslations(game.name, game.description),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/availability', async (req, res) => {
  await dbReady;
  try {
    const versionId = req.query.version_id || null;
    const game = fetchGameWithRomSet(req.params.id, versionId);
    if (!game) return res.status(404).json({ error: 'not found' });

    const roms = all(`
      SELECT grf.* FROM game_rom_files grf
      JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
      WHERE grs.game_id = ? AND grs.version_id = ?
    `, [game.id, game.version_id]);

    const available = {};

    const zipCrcCache = new Map();
    function getZipCrcs(zipPath) {
      if (!zipPath || !fs.existsSync(zipPath)) return null;
      if (zipCrcCache.has(zipPath)) return zipCrcCache.get(zipPath);
      const crcs = new Set();
      try {
        const output = execSync(`unzip -v "${zipPath}"`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 7 && parts[6].length === 8 && /^[0-9a-f]{8}$/i.test(parts[6])) {
            crcs.add(parts[6].toUpperCase());
          }
        }
      } catch {}
      zipCrcCache.set(zipPath, crcs);
      return crcs;
    }

    let gameZipPath = null;
    const col = get('SELECT c.folder, c.slug FROM collections c JOIN set_versions sv ON sv.collection_id = c.id WHERE sv.id = ? LIMIT 1', [game.version_id]);
    const colFolder = col?.folder || col?.slug;
    if (colFolder) {
      const romsDir = path.join(dataDir, 'roms', colFolder, game.version || '', 'roms');
      const dirs = game.platform ? [path.join(romsDir, game.platform), romsDir] : [romsDir];
      for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const entry of fs.readdirSync(d)) {
          if (entry.endsWith('.zip') && path.basename(entry, '.zip') === game.name) {
            gameZipPath = path.join(d, entry);
            break;
          }
        }
        if (gameZipPath) break;
      }
    }

    let parentPath = null;
    if (gameZipPath) {
      let currentRef = game.romof || game.cloneof;
      while (currentRef && !parentPath) {
        const pDir = path.join(dataDir, 'roms', colFolder, game.version, 'roms');
        const pDirs = game.platform ? [path.join(pDir, game.platform), pDir] : [pDir];
        for (const d of pDirs) {
          if (!fs.existsSync(d)) continue;
          for (const entry of fs.readdirSync(d)) {
            if (entry.endsWith('.zip') && path.basename(entry, '.zip') === currentRef) {
              parentPath = path.join(d, entry);
              break;
            }
          }
          if (parentPath) break;
        }
        if (!parentPath) {
          const parentGame = get(`
            SELECT parent_g.name as cloneof, grs.romof FROM games g
            LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
            JOIN game_rom_sets grs ON grs.game_id = g.id
            WHERE grs.version_id = ? AND g.name = ?
            LIMIT 1
          `, [game.version_id, currentRef]);
          currentRef = parentGame ? (parentGame.romof || parentGame.cloneof) : null;
        } else break;
      }
    }

    const gameCrcs = gameZipPath ? getZipCrcs(gameZipPath) : null;
    const parentCrcs = parentPath ? getZipCrcs(parentPath) : null;
    const state = get('SELECT available FROM game_state WHERE game_id = ?', [game.id]);

    for (const rom of roms) {
      if (!rom.crc32) {
        available[rom.id] = state?.available === 1;
        continue;
      }
      if (rom.merge_target) {
        available[rom.id] = !!gameZipPath && !!parentCrcs && parentCrcs.has(rom.crc32.toUpperCase());
      } else {
        available[rom.id] = !!gameCrcs && gameCrcs.has(rom.crc32.toUpperCase());
      }
    }

    res.json({ available });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/play', async (req, res) => {
  await dbReady;
  try {
    const versionId = req.query.version_id || null;
    const game = fetchGameWithRomSet(req.params.id, versionId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let filePath = null;

    function findInDir(dir) {
      if (!fs.existsSync(dir)) return null;
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            const found = findInDir(fullPath);
            if (found) return found;
          } else if (entry.endsWith('.zip')) {
            const stem = path.basename(entry, '.zip');
            if (stem === game.name) return fullPath;
          }
        }
      } catch {}
      return null;
    }

    const col1 = get(`SELECT c.folder, c.slug FROM collections c JOIN set_versions sv ON sv.collection_id = c.id WHERE sv.id = ? LIMIT 1`, [game.version_id]);
    const colFolder1 = col1?.folder || col1?.slug;
    if (colFolder1) {
      const vers = get('SELECT version FROM set_versions WHERE id = ?', [game.version_id]);
      if (vers) {
        const romsDir = path.join(dataDir, 'roms', colFolder1, vers.version, 'roms');
        const searchDirs = [
          ...(game.platform ? [path.join(romsDir, game.platform)] : []),
          romsDir,
        ];
        for (const d of searchDirs) {
          filePath = findInDir(d);
          if (filePath) break;
        }
      }
    }

    if (!filePath && (game.source === 'fbneo' || game.source === 'mame')) {
      if (colFolder1) {
        const versionFile = path.join(dataDir, 'roms', colFolder1, '.version');
        if (fs.existsSync(versionFile)) {
          const versions = fs.readFileSync(versionFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
          const idx = versions.indexOf(game.version);
          if (idx > 0) {
            for (const v of versions.slice(0, idx).reverse()) {
              const olderDirs = [
                ...(game.platform ? [path.join(dataDir, 'roms', colFolder1, v, 'roms', game.platform)] : []),
                path.join(dataDir, 'roms', colFolder1, v, 'roms'),
              ];
              for (const d of olderDirs) {
                filePath = findInDir(d);
                if (filePath) break;
              }
              if (filePath) break;
            }
          }
        }
      }
    }

    if (!filePath && game.source === 'nps') {
      const rom = get(`
        SELECT grf.* FROM game_rom_files grf
        JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
        WHERE grs.game_id = ? AND grs.version_id = ? AND grf.subtype = ?
        LIMIT 1
      `, [game.id, game.version_id, 'game']);
      if (rom) {
        const col = get(`SELECT c.folder, c.slug FROM collections c JOIN set_versions sv ON sv.collection_id = c.id WHERE sv.id = ? LIMIT 1`, [game.version_id]);
        const colFolder = col?.folder || col?.slug || String(game.version_id);
        const subDir = rom.subtype === 'dlc' ? 'DLCs' : rom.subtype === 'update' ? 'Updates' : 'Games';
        const candidate = path.join(dataDir, 'roms', colFolder, game.platform, subDir, rom.filename);
        if (fs.existsSync(candidate)) filePath = candidate;
      }
    }

    if (!filePath) {
      const rom = get(`
        SELECT grf.* FROM game_rom_files grf
        JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
        WHERE grs.game_id = ? AND grs.version_id = ?
        LIMIT 1
      `, [game.id, game.version_id]);
      if (rom) {
        const col = get(`SELECT c.folder, c.slug FROM collections c JOIN set_versions sv ON sv.collection_id = c.id WHERE sv.id = ? LIMIT 1`, [game.version_id]);
        const colFolder = col?.folder || col?.slug || String(game.version_id);
        const baseRomsDir = path.join(dataDir, 'roms', colFolder);
        const candidates = [
          path.join(baseRomsDir, rom.filename),
          path.join(baseRomsDir, 'Games', rom.filename),
        ];
        if (!rom.filename.endsWith('.zip')) {
          candidates.push(path.join(baseRomsDir, rom.filename + '.zip'));
          candidates.push(path.join(baseRomsDir, 'Games', rom.filename + '.zip'));
        }
        for (const c of candidates) {
          if (fs.existsSync(c)) { filePath = c; break; }
        }
      }
    }

    if (!filePath) return res.status(404).json({ error: 'ROM file not found on disk' });

    if (colFolder1) {
      const vers = get('SELECT version FROM set_versions WHERE id = ?', [game.version_id]);
      if (vers) {
        const romsDir = path.join(dataDir, 'roms', colFolder1, vers.version, 'roms');
        const searchDirs = [
          ...(game.platform ? [path.join(romsDir, game.platform)] : []),
          romsDir,
        ];

        const parentZips = [];

        let currentRef = game.romof || game.cloneof;
        while (currentRef) {
          let found = null;
          for (const d of searchDirs) {
            found = findInDir(d);
            if (found && path.basename(found, '.zip') === currentRef) break;
            found = null;
          }
          if (!found) break;
          parentZips.push(found);
          const parentGame = get(`
            SELECT parent_g.name as cloneof, grs.romof FROM games g
            LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
            JOIN game_rom_sets grs ON grs.game_id = g.id
            WHERE grs.version_id = ? AND g.name = ?
            LIMIT 1
          `, [game.version_id, currentRef]);
          currentRef = parentGame ? (parentGame.romof || parentGame.cloneof) : null;
        }

        if (parentZips.length === 0) {
          const mergeTargets = all(`
            SELECT DISTINCT grf.merge_target FROM game_rom_files grf
            JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
            WHERE grs.game_id = ? AND grs.version_id = ? AND grf.merge_target IS NOT NULL
          `, [game.id, game.version_id]);
          if (mergeTargets.length > 0) {
            const targetNames = new Set(mergeTargets.map(r => r.merge_target));
            for (const d of searchDirs) {
              if (!fs.existsSync(d)) continue;
              for (const entry of fs.readdirSync(d)) {
                if (!entry.endsWith('.zip') || entry === path.basename(filePath)) continue;
                try {
                  const listing = execSync(`unzip -l "${path.join(d, entry)}"`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
                  const lines = listing.split('\n').filter(l => l.includes('  '));
                  const hasMatch = lines.some(l => {
                    const parts = l.trim().split(/\s+/);
                    const fname = parts[parts.length - 1];
                    return targetNames.has(fname);
                  });
                  if (hasMatch) {
                    parentZips.push(path.join(d, entry));
                  }
                } catch {}
              }
            }
          }
        }

        if (parentZips.length > 0) {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rom-'));
          const mergedPath = path.join(tmpDir, path.basename(filePath));
          try {
            const mergeDir = path.join(tmpDir, 'merged');
            fs.mkdirSync(mergeDir, { recursive: true });
            for (const pz of parentZips.reverse()) {
              execSync(`unzip -o "${pz}" -d "${mergeDir}"`, { stdio: 'ignore' });
            }
            execSync(`unzip -o "${filePath}" -d "${mergeDir}"`, { stdio: 'ignore' });
            execSync(`cd "${mergeDir}" && zip -X -r "${mergedPath}" .`, { stdio: 'ignore' });
            filePath = mergedPath;
            res.on('finish', () => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
          } catch (e) {
            try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          }
        }
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.zip': 'application/zip',
      '.nes': 'application/octet-stream',
      '.sfc': 'application/octet-stream',
      '.smc': 'application/octet-stream',
      '.gb': 'application/octet-stream',
      '.gbc': 'application/octet-stream',
      '.gba': 'application/octet-stream',
      '.nds': 'application/octet-stream',
      '.n64': 'application/octet-stream',
      '.z64': 'application/octet-stream',
      '.v64': 'application/octet-stream',
      '.gen': 'application/octet-stream',
      '.md': 'application/octet-stream',
      '.sms': 'application/octet-stream',
      '.gg': 'application/octet-stream',
      '.pce': 'application/octet-stream',
      '.vb': 'application/octet-stream',
      '.iso': 'application/octet-stream',
      '.cue': 'application/octet-stream',
      '.bin': 'application/octet-stream',
      '.pkg': 'application/octet-stream',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export async function scrapeSingleGame(gameId, versionId) {
  const game = fetchGameOptionalRomSet(gameId, versionId);
  if (!game) return { scraped: false, error: 'Game not found', gameId };

  // Get collection's scrape_mode setting
  // 'parent' (default): for clones, search by parent name — all clones share media
  // 'individual': search by each game's own name — each variant gets its own search
  const scrapeMode = getScrapeMode(game.version_id);

  // In 'parent' mode, use the parent's name for searching (clones share parent's result)
  const searchName = (scrapeMode === 'parent' && game.cloneof) ? game.cloneof : game.name;
  const searchDesc = (scrapeMode === 'parent' && game.cloneof)
    ? (get('SELECT description FROM games WHERE name = ?', [game.cloneof])?.description || game.description)
    : game.description;

  const mediaPlatform = p => (p || '').trim() || 'arcade';

  const canonical = canonicalName(game, scrapeMode);
  const mediaPlat = mediaPlatform(game.platform);

  const enabledSet = getEnabledSourceSet(game.collection_id);
  const datasetPreset = game.collection_id
    ? (get('SELECT dataset_preset FROM collections WHERE id = ?', [game.collection_id])?.dataset_preset || null)
    : null;

  function trySearch(query, platform) {
    const args = ['search', query];
    if (platform) args.push('--platform', platform);
    const r = execCli(args, { binary: 'scraper' });
    if (r?.results?.length) return r;
    return null;
  }

  function searchEnabledSources(query, platform, datasetPresetVal) {
    if (!enabledSet) {
      return trySearch(query, platform);
    }
    const args = ['search', query];
    if (platform) args.push('--platform', platform);
    if (datasetPresetVal && (datasetPresetVal === 'mame' || datasetPresetVal === 'fbneo')) {
      args.push('--dataset-preset', datasetPresetVal);
    }
    for (const src of enabledSet) {
      if (src === 'progettosnaps') continue;
      const r = execCli([...args, '--source', src], { binary: 'scraper' });
      if (r?.results?.length) return r;
    }
    return null;
  }

  function normalizeTitle(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function rankResults(results, query, gameName, platform) {
    const q = normalizeTitle(query);
    const gameNorm = normalizeTitle(gameName);
    return results.map(r => {
      const t = normalizeTitle(r.title);
      let score = 0;
      if (t === q || t === gameNorm) score += 100;
      else if (t.startsWith(q) || t.startsWith(gameNorm)) score += 80;
      else if (t.includes(q) || t.includes(gameNorm)) score += 60;
      else {
        const qWords = q.split(/\w+/).filter(w => w.length > 2);
        const matchedWords = qWords.filter(w => t.includes(w));
        score += matchedWords.length * 10;
      }
      if (platform) {
        const rp = (r.platform || '').toLowerCase();
        const platNorm = normalizeTitle(platform);
        if (rp === platNorm) score += 30;
        else if (rp.includes(platNorm) || platNorm.includes(rp)) score += 15;
      }
      return { ...r, _score: score };
    }).sort((a, b) => b._score - a._score);
  }

  const candidates = [];

  if (game.platform === 'arcade' && searchName) {
    const expanded = get('SELECT description FROM games WHERE name = ? AND description IS NOT NULL AND description != name LIMIT 1', [searchName]);
    if (expanded?.description) {
      const clean = expanded.description.replace(/\s*\([^)]*\)\s*/g, '').trim();
      if (clean && !candidates.includes(clean)) candidates.unshift(clean);
    }
  }

  if (searchName && (game.platform === 'arcade' || !game.platform)) {
    if (!candidates.includes(searchName)) candidates.unshift(searchName);
  }

  if (searchDesc) {
    const stripped = searchDesc.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
    if (!candidates.includes(searchDesc)) candidates.push(searchDesc);
  }

  if (searchName) {
    const spaced = searchName.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
    if (spaced !== searchName && !candidates.includes(spaced)) candidates.push(spaced);
  }

  if (searchName) {
    const VARIANT_SUFFIXES = ['j','u','e','a','w','p','h','b','f','s','k','ja','ju','us','ua','uk','eu','hk','tw','kr','fr','de','es','it','nl','br'];
    for (const sfx of VARIANT_SUFFIXES) {
      if (searchName.endsWith(sfx) && searchName.length > sfx.length + 2) {
        const base = searchName.slice(0, -sfx.length);
        const baseSpaced = base.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
        if (!candidates.includes(baseSpaced)) candidates.push(baseSpaced);
        if (!candidates.includes(base)) candidates.push(base);
        break;
      }
    }
  }

  let searchResult = null;
  let matchedTitle = null;

  // Try ArcadeDB first with the MAME short name (only when enabled or no priority set)
  if (!enabledSet || enabledSet.has('arcadedb')) {
    if (scrapeMode === 'individual' || (game.name && (game.platform === 'arcade' || !game.platform))) {
      const r = execCli(['search', searchName, '--source', 'arcadedb'], { binary: 'scraper' });
      if (r?.results?.length) {
        const ranked = rankResults(r.results, game.name, game.name, game.platform);
        const best = ranked[0];
        searchResult = { results: [best] };
        matchedTitle = best.title;
      }
    }
  }

  if (!searchResult) for (const q of candidates) {
    const r = searchEnabledSources(q, game.platform, game.source);
    if (r) {
      const ranked = rankResults(r.results, q, searchName || game.name, game.platform);
      const best = ranked[0];
      searchResult = { results: [best] };
      matchedTitle = best.title;
      break;
    }
    if (q === searchDesc && searchDesc && searchDesc.length > 5) {
      const parts = searchDesc.split(/\s*[\/~]\s*/).filter(p => p.length > 3);
      for (const part of parts) {
        const pr = searchEnabledSources(part, game.platform, game.source);
        if (pr) {
          const ranked = rankResults(pr.results, part, searchName || game.name, game.platform);
          const best = ranked[0];
          searchResult = { results: [best] };
          matchedTitle = best.title;
          break;
        }
      }
      if (!searchResult) {
        const stripped = searchDesc.replace(/\s*\([^)]*\)\s*/g, '').trim();
        if (stripped && stripped !== searchDesc) {
          const head = stripped.split(/\s*[-–:]\s*/)[0].trim();
          if (head.length > 3) {
            const pr = searchEnabledSources(head, game.platform, game.source);
            if (pr) {
              const ranked = rankResults(pr.results, head, searchName || game.name, game.platform);
              searchResult = { results: [ranked[0]] };
              matchedTitle = ranked[0].title;
            }
          }
        }
      }
      if (searchResult) break;
    }
  }

  if (!searchResult) {
    return { scraped: false, error: 'No matches found in any provider', gameId };
  }

  const first = searchResult.results[0];
  let detailResult;
  try {
    const detailArgs = ['detail', first.id];
    if (first.source) detailArgs.push('--source', first.source);
    if (datasetPreset && (datasetPreset === 'mame' || datasetPreset === 'fbneo')) {
      detailArgs.push('--dataset-preset', datasetPreset);
    }
    detailResult = execCli(detailArgs, { binary: 'scraper' });
  } catch {
    return { scraped: false, error: 'Failed to get game details', gameId };
  }
  if (!detailResult || detailResult.error) {
    return { scraped: false, error: 'Detail fetch failed', gameId };
  }

  const synopsis = detailResult.synopsis || '';
  const rawDate = (detailResult.release_date || '').trim();
  const year = (rawDate && !rawDate.startsWith('1970')) ? rawDate.substring(0, 4) : null;
  const manufacturer = detailResult.publisher || detailResult.developer || null;

  function upgradeCovers(urls) {
    return (urls || []).map(u => {
      const s = u.startsWith('//') ? 'https:' + u : u;
      return s.replace('/t_thumb/', '/t_cover_big/');
    });
  }
  function upgradeScreenshots(urls) {
    return (urls || []).map(u => {
      const s = u.startsWith('//') ? 'https:' + u : u;
      return s.replace('/t_thumb/', '/t_screenshot_huge/');
    });
  }

  if (synopsis || year || manufacturer || detailResult.covers?.length || detailResult.screenshots?.length || detailResult.fanarts?.length || detailResult.logos?.length) {
    const updates = [];
    const upParams = [];
    if (synopsis) { updates.push('synopsis = ?'); upParams.push(synopsis); }
    if (year && !game.year) { updates.push('year = ?'); upParams.push(year); }
    if (manufacturer && !game.manufacturer) { updates.push('manufacturer = ?'); upParams.push(manufacturer); }
    if (updates.length > 0) {
      upParams.push(game.id);
      run(`UPDATE games SET ${updates.join(', ')} WHERE id = ?`, upParams);
    }
    // Merge covers and logos (logos from libretro Named_Titles). Logos first for ?type=title.
    const allCovers = [...(detailResult.logos || []), ...(detailResult.covers || [])];
    const covers = allCovers.length ? JSON.stringify(upgradeCovers(allCovers)) : '[]';
    const screenshots = detailResult.screenshots?.length ? JSON.stringify(upgradeScreenshots(detailResult.screenshots)) : '[]';
    const fanarts = detailResult.fanarts?.length ? JSON.stringify(detailResult.fanarts) : '[]';
    const videos = detailResult.videos?.length ? JSON.stringify(detailResult.videos) : '[]';
    run('INSERT OR REPLACE INTO game_media (name, platform, synopsis, covers, screenshots, fanarts, videos, source, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
      [canonical, mediaPlat, synopsis || '', covers, screenshots, fanarts, videos, first.source || '']);
  }

  // Providers without synopsis (ArcadeDB, LibretroThumbnails) — try to grab one from IGDB or TheGamesDB
  if (!synopsis && first.source && first.source !== 'screenscraper' && first.source !== 'igdb' && first.source !== 'thegamesdb') {
    for (const src of ['igdb', 'thegamesdb']) {
      if (enabledSet && !enabledSet.has(src)) continue;
      try {
        const srcSearch = execCli(['search', first.title || game.name, '--source', src], { binary: 'scraper' });
        const srcResult = srcSearch?.results?.[0];
        if (srcResult) {
          const srcDetail = execCli(['detail', srcResult.id, '--source', src], { binary: 'scraper' });
          if (srcDetail?.synopsis) {
            run(`UPDATE games SET synopsis = ? WHERE id = ?`, [srcDetail.synopsis, game.id]);
            run(`UPDATE game_media SET synopsis = ? WHERE name = ? AND platform = ?`, [srcDetail.synopsis, canonical, mediaPlat]);
            break;
          }
        }
      } catch {}
    }
  }

  if (game.source === 'nps') {
    try {
      const contentId = game.content_id || game.title_id;
      if (contentId) {
        const sonyResult = execCli(['detail', contentId, '--source', 'sony-store'], { binary: 'scraper' });
        if (sonyResult && sonyResult.fanarts?.length > 0) {
          const fanarts = JSON.stringify(sonyResult.fanarts);
          run('UPDATE game_media SET fanarts = ?, source = ?, scraped_at = datetime(\'now\') WHERE name = ? AND platform = ?',
            [fanarts, 'sony-store', canonical, mediaPlat]);
        }
      }
    } catch {}
  }

  if (!enabledSet || enabledSet.has('no-intro-pictures')) {
    if (!detailResult.covers?.length && !detailResult.screenshots?.length) {
      try {
        const colVersion = get(`SELECT c.dataset_preset FROM collections c JOIN set_versions sv ON sv.collection_id = c.id WHERE sv.id = ? LIMIT 1`, [game.version_id]);
        if (colVersion?.dataset_preset === 'DATOMATIC') {
          const gameNameForUrl = game.description || game.name;
          const nidResult = execCli(['detail', `${game.platform || 'unknown'}/${gameNameForUrl}`, '--source', 'no-intro-pictures'], { binary: 'scraper' });
          if (nidResult && !nidResult.error) {
            const covers = nidResult.covers?.length ? JSON.stringify(nidResult.covers) : '[]';
            const screenshots = nidResult.screenshots?.length ? JSON.stringify(nidResult.screenshots) : '[]';
            if (covers !== '[]' || screenshots !== '[]') {
              run('INSERT OR REPLACE INTO game_media (name, platform, covers, screenshots, source, scraped_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
                [canonical, mediaPlat, covers, screenshots, 'no-intro-pictures']);
            }
          }
        }
      } catch {}
    }
  }

  const mediaRow = get('SELECT covers, screenshots, fanarts, videos, synopsis as media_synopsis FROM game_media WHERE name = ? AND platform = ?', [canonical, mediaPlat]);
  const mediaCovers = mediaRow?.covers ? (() => { try { return JSON.parse(mediaRow.covers); } catch { return []; } })() : [];
  const mediaScreenshots = mediaRow?.screenshots ? (() => { try { return JSON.parse(mediaRow.screenshots); } catch { return []; } })() : [];
  const mediaFanarts = mediaRow?.fanarts ? (() => { try { return JSON.parse(mediaRow.fanarts); } catch { return []; } })() : [];
  const mediaVideos = mediaRow?.videos ? (() => { try { return JSON.parse(mediaRow.videos); } catch { return []; } })() : [];
  const mediaSynopsis = mediaRow?.media_synopsis || '';

  const updated = fetchGameOptionalRomSet(game.id);
  updated.covers = mediaCovers;
  updated.screenshots = mediaScreenshots;
  updated.fanarts = mediaFanarts;
  updated.videos = mediaVideos;
  if (!updated.synopsis && mediaSynopsis) updated.synopsis = mediaSynopsis;
  updated.roms = [];
  if (updated.version_id != null) {
    updated.roms = all(`
      SELECT grf.* FROM game_rom_files grf
      JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
      WHERE grs.game_id = ? AND grs.version_id = ?
      ORDER BY grf.filename
    `, [updated.id, updated.version_id]);
  }

  const hadData = synopsis || year || manufacturer || detailResult.covers?.length || detailResult.screenshots?.length || detailResult.logos?.length;
  return { scraped: true, saved: !!hadData, title: matchedTitle || first.title, game: updated, gameId };
}

router.post('/:id/scrape', async (req, res) => {
  await dbReady;
  try {
    const result = await scrapeSingleGame(req.params.id, req.body?.version_id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/batch-scrape', async (req, res) => {
  await dbReady;
  try {
    let { game_ids, overwrite, delay } = req.body;
    if (!Array.isArray(game_ids) || game_ids.length === 0) {
      return res.status(400).json({ error: 'game_ids array required' });
    }
    if (delay == null) delay = 3000;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    runNow(`INSERT INTO scrape_jobs (id, status, total_games) VALUES (?, 'running', ?)`, [jobId, game_ids.length]);

    Promise.resolve().then(async () => {
      const total = game_ids.length;
      let scraped = 0, skipped = 0, failed = 0, cancelled = false, rateLimited = false;
      const errors = [];

      function saveProgress(pct, msg) {
        updateProgress(jobId, pct, msg);
        runNow(`UPDATE scrape_jobs SET progress_msg = ?, updated_at = datetime('now') WHERE id = ?`, [msg, jobId]);
      }

      for (let i = 0; i < total; i++) {
        if (job._abort.signal.aborted) { cancelled = true; break; }
        if (rateLimited) { skipped++; continue; }
        const gid = game_ids[i];
        try {
          if (!overwrite) {
            const existing = get('SELECT manufacturer, year FROM games WHERE id = ?', [gid]);
            if (existing?.manufacturer || existing?.year) {
              skipped++;
              saveProgress(Math.round((i + 1) / total * 100), `[${i+1}/${total}] Skipped (has metadata) — #${gid}`);
              continue;
            }
          }
          const result = await scrapeSingleGame(gid);
          if (result.scraped) {
            scraped++;
            saveProgress(Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✓ ${result.title || '#'+gid}`);
          } else {
            failed++;
            errors.push({ game_id: gid, error: result.error });
            saveProgress(Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✗ #${gid} — ${result.error}`);
          }
        } catch (e) {
          const msg = e.message || '';
          if (/429|rate.?limit|too many requests|quota|allowance|508|Resource Limit/i.test(msg)) {
            rateLimited = true;
            errors.push({ game_id: gid, error: `Rate limited — ${msg}` });
            saveProgress(Math.round((i + 1) / total * 100), `[${i+1}/${total}] Rate limited — stopping`);
          } else {
            failed++;
            errors.push({ game_id: gid, error: msg });
            saveProgress(Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✗ #${gid} — ${msg}`);
          }
        }

        if (delay > 0 && !cancelled && !rateLimited) await sleep(delay);
      }

      if (job._abort.signal.aborted) {
        runNow(`UPDATE scrape_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [jobId]);
        return;
      }
      const resultPayload = { total, scraped, skipped, failed, errors, cancelled, rateLimited };
      runNow(`UPDATE scrape_jobs SET status = 'done', scraped = ?, skipped = ?, failed = ?, rate_limited = ?, result = ?, updated_at = datetime('now') WHERE id = ?`,
        [scraped, skipped, failed, rateLimited ? 1 : 0, JSON.stringify(resultPayload), jobId]);
      doneJob(jobId, resultPayload);
    });

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/rating', async (req, res) => {
  await dbReady;
  try {
    const { rating, favourite } = req.body;
    const existing = get('SELECT game_id FROM game_state WHERE game_id = ?', [req.params.id]);
    if (existing) {
      if (rating != null) run("UPDATE game_state SET rating = ?, updated_at = datetime('now') WHERE game_id = ?", [rating, req.params.id]);
      if (favourite != null) run("UPDATE game_state SET favourite = ?, updated_at = datetime('now') WHERE game_id = ?", [favourite ? 1 : 0, req.params.id]);
    } else {
      run('INSERT INTO game_state (game_id, rating, favourite) VALUES (?, ?, ?)', [req.params.id, rating ?? 0, favourite ? 1 : 0]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/play', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT id FROM games WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    run("INSERT OR REPLACE INTO recently_played (game_id, played_at) VALUES (?, datetime('now'))", [req.params.id]);
    run("DELETE FROM recently_played WHERE game_id NOT IN (SELECT game_id FROM recently_played ORDER BY played_at DESC LIMIT 6)");
    const existing = get('SELECT game_id FROM game_state WHERE game_id = ?', [req.params.id]);
    if (existing) {
      run("UPDATE game_state SET play_count = play_count + 1, updated_at = datetime('now') WHERE game_id = ?", [req.params.id]);
    } else {
      run("INSERT INTO game_state (game_id, play_count) VALUES (?, 1)", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function serveGameMedia(req, res, mediaType, dbField, opts = {}) {
  await dbReady;
  try {
    const game = fetchGameOptionalRomSet(req.params.id);
    if (!game) return res.status(404).end();
    const scrapeMode = getScrapeMode(game.version_id);
    const canonical = canonicalName(game, scrapeMode);
    const mediaPlat = (game.platform || '').trim() || 'arcade';

    const enabledSet = getEnabledSourceSet(game.collection_id);

    // Prefer progettosnaps pre-downloaded media (only if enabled)
    if (!enabledSet || enabledSet.has('progettosnaps')) {
      const PS_DIR_MAP = { title: 'title', ingame: 'snap' };
      const psSubDir = PS_DIR_MAP[mediaType];
      if (psSubDir) {
        const psPath = path.join(dataDir, 'media', 'progettosnaps', psSubDir, game.name + '.png');
        try {
          if (fs.existsSync(psPath)) {
            const data = fs.readFileSync(psPath);
            const localUrl = `/media/progettosnaps/${psSubDir}/${game.name}.png`;
            run(`UPDATE game_media SET ${dbField} = ?, source = ? WHERE name = ? AND platform = ?`,
              [JSON.stringify([localUrl]), 'progettosnaps', canonical, mediaPlat]);
            const etag = createHash('md5').update(data).digest('hex');
            res.set('ETag', `"${etag}"`);
            res.set('Cache-Control', 'public, max-age=86400');
            if (req.headers['if-none-match'] === `"${etag}"`) {
              return res.status(304).end();
            }
            res.set('Content-Type', 'image/png');
            return res.send(data);
          }
        } catch {}
      }
    }

    const media = get(`SELECT ${dbField}, source FROM game_media WHERE name = ? AND platform = ?`, [canonical, mediaPlat]);
    if (media?.[dbField]) {
      if (enabledSet && !enabledSet.has(media.source || '')) {
        // Source is not enabled — skip
      } else {
        try {
          const urls = JSON.parse(media[dbField]);
          if (urls.length > 0) {
            const result = await getMedia(urls[0], game.name, mediaType);
            if (result) {
              if (result.localUrl) {
                run(`UPDATE game_media SET ${dbField} = ? WHERE name = ? AND platform = ?`,
                  [JSON.stringify([result.localUrl]), canonical, mediaPlat]);
              }
              const etag = createHash('md5').update(result.data).digest('hex');
              res.set('ETag', `"${etag}"`);
              res.set('Cache-Control', 'public, max-age=86400');
              if (req.headers['if-none-match'] === `"${etag}"`) {
                return res.status(304).end();
              }
              res.set('Content-Type', result.mime);
              return res.send(result.data);
            }
          }
        } catch {}
      }
    }

    if (opts.fallback === 'svg') {
      const hash = createHash('md5').update(game.name).digest('hex');
      const hue = parseInt(hash.slice(0, 6), 16) % 360;
      const sat = 50 + (parseInt(hash.slice(6, 8), 16) % 30);
      const light = 30 + (parseInt(hash.slice(8, 10), 16) % 20);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
        <rect width="400" height="600" fill="hsl(${hue},${sat}%,${light}%)"/>
        <text x="200" y="300" font-family="system-ui,sans-serif" font-size="120" font-weight="bold" fill="rgba(255,255,255,0.3)" text-anchor="middle" dominant-baseline="middle">${game.name[0].toUpperCase()}</text>
      </svg>`;
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(svg);
    }
    res.status(404).end();
  } catch (e) { res.status(500).end(); }
}

router.get('/:id/media', async (req, res) => {
  const type = req.query.type || 'title';
  const dbField = type === 'ingame' ? 'screenshots' : type === 'fanart' ? 'fanarts' : 'covers';
  await serveGameMedia(req, res, type === 'fanart' ? 'fanart' : type === 'ingame' ? 'ingame' : 'title', dbField);
});

router.get('/:id/fanart', async (req, res) => {
  await serveGameMedia(req, res, 'fanart', 'fanarts');
});

router.get('/:id/cover', async (req, res) => {
  await serveGameMedia(req, res, 'title', 'covers', { fallback: 'svg' });
});

router.post('/:id/download-ia', async (req, res) => {
  await dbReady;
  try {
    const versionId = req.body.version_id || null;
    const downloadParams = [req.params.id];
    let downloadVersionClause = '';
    if (versionId) {
      downloadVersionClause = 'AND grs.version_id = ?';
      downloadParams.push(versionId);
    }
    const game = get(`
      SELECT g.*, grs.version_id, c.dataset_preset as source, sv.version
      FROM games g
      JOIN collections c ON c.id = g.collection_id
      JOIN game_rom_sets grs ON grs.game_id = g.id
      JOIN set_versions sv ON sv.id = grs.version_id
      WHERE g.id = ? ${downloadVersionClause}
      ORDER BY grs.version_id ASC LIMIT 1
    `, downloadParams);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const col = get(`SELECT id, folder, slug, name FROM collections WHERE id = ?`, [game.collection_id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    const romset = game.source.toLowerCase();
    const colFolder = col.folder || col.slug;

    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    const baseRomDir = path.resolve(dataDir, 'roms', colFolder, game.version || '', 'roms');
    const outputDir = game.platform ? path.join(baseRomDir, game.platform) : baseRomDir;
    fs.mkdirSync(outputDir, { recursive: true });

    const roms = all(`
      SELECT grf.filename, grf.crc32 FROM game_rom_files grf
      JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
      WHERE grs.game_id = ? AND grs.version_id = ? AND grf.crc32 IS NOT NULL AND grf.crc32 != ? AND grf.merge_target IS NULL
    `, [game.id, game.version_id, '']);
    const crcStr = roms.map(r => `${r.filename}:${r.crc32.toUpperCase()}`).join(',');

    const cachedId = getCachedId(romset, game.version || '');

    const args = ['find', romset, game.name, '--output', outputDir];
    if (game.version) args.push('--version', game.version);
    if (cachedId) args.push('--cached-id', cachedId);
    if (crcStr) args.push('--crc', crcStr);

    const iaAuth = getAuth();
    if (iaAuth) {
      args.push('--username', iaAuth.username);
      args.push('--password', iaAuth.password);
    }

    updateProgress(jobId, 0, `Searching for ${game.name} on Internet Archive...`);

    execCliStream(args, {
      binary: 'ia',
      signal: job._abort.signal,
      onProgress: (p) => updateProgress(jobId, p.pct || 0, p.msg || ''),
    }).then(result => {
      if (!result.ok) {
        const errMsg = result.error || 'Unknown error';
        const dlUrl = result.download_url || '';
        throw new Error(dlUrl ? `${errMsg}. Download URL: ${dlUrl}` : errMsg);
      }

      if (result.cached_id) {
        setCachedId(romset, game.version || '', result.cached_id);
      }

      run('UPDATE game_rom_sets SET available = 1 WHERE game_id = ? AND version_id = ?', [game.id, game.version_id]);
      syncGameAvailability([game.id]);

      doneJob(jobId, { ok: true, crc_match: result.crc_match, details: result });
    }).catch(e => {
      if (job._abort.signal.aborted) return;
      failJob(jobId, e.message);
    });

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
