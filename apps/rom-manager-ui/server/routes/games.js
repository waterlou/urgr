import { Router } from 'express';
import crypto, { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getDb } from '../db.js';
import { execCli } from '../cli.js';
import { createJob, updateProgress, doneJob, failJob } from '../jobs.js';
import { all, get, run, runNow, dbReady } from '../helpers.js';
import { getAuth } from '../ia-auth.js';
import { getCachedId, setCachedId } from '../ia-cache.js';
import { dataDir } from '../paths.js';

const router = Router();

router.get('/', async (req, res) => {
  await dbReady;
  try {
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, collection_id, version_id, parents_only, favourites_only, roms_only } = req.query;
    const sortCol = sort === 'rating' ? 'COALESCE(r.rating, 0)' : sort === 'play_count' ? 'COALESCE(r.play_count, 0)' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    let where = [];
    let params = [];

    if (q) {
      where.push('(g.name LIKE ? OR g.description LIKE ? OR sv.source LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (collection_id) {
      const vids = all('SELECT version_id FROM collection_versions WHERE collection_id = ?', [collection_id]).map(v => v.version_id);
      if (!vids.length) return res.json({ games: [], total: 0, limit: Number(limit), offset: Number(offset) });
      const ph = vids.map(() => '?').join(',');
      where.push(`g.version_id IN (${ph})`);
      params.push(...vids);
    }
    if (version_id) {
      where.push('g.version_id = ?');
      params.push(version_id);
    }
    if (parents_only === 'true') {
      where.push('g.cloneof IS NULL');
    }
    if (favourites_only === 'true') {
      where.push('COALESCE(r.favourite, 0) = 1');
    }
    if (roms_only === 'true') {
      where.push('COALESCE(r.available, 0) = 1');
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const joinClause = 'LEFT JOIN game_state r ON r.game_entry_id = g.id';
    const countSql = `SELECT COUNT(DISTINCT g.name) as c FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id ${joinClause} ${whereClause}`;
    const total = params.length ? get(countSql, params).c : get(countSql).c;

    const sortCol2 = sort === 'rating' ? 'MAX(COALESCE(r.rating, 0))' : sort === 'play_count' ? 'MAX(COALESCE(r.play_count, 0))' : 'g.name';
    const pageParams = params.slice();
    pageParams.push(Number(limit), Number(offset));
    let games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, g.cloneof, g.platform,
        MIN(g.id) as id, MIN(g.version_id) as version_id, MIN(sv.source) as source, MIN(sv.version) as version,
        GROUP_CONCAT(sv.source || '||' || sv.version, '||') as versions_tags,
        MAX(COALESCE(r.rating, 0)) as rating,
        MAX(COALESCE(r.favourite, 0)) as favourite,
        MAX(COALESCE(r.play_count, 0)) as play_count,
        MAX(CASE WHEN g.covers != '[]' THEN g.covers ELSE NULL END) as covers_json,
        MAX(CASE WHEN g.screenshots != '[]' THEN g.screenshots ELSE NULL END) as screenshots_json
      FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id
      ${joinClause}
      ${whereClause} GROUP BY g.name ORDER BY ${sortCol2} ${sortDir} LIMIT ? OFFSET ?
    `, pageParams);
    games = games.map(g => {
      const tags = g.versions_tags ? g.versions_tags.split('||') : [];
      const versions = [];
      for (let i = 0; i < tags.length; i += 2) versions.push(tags[i + 1]);
      delete g.versions_tags;
      let covers = [];
      let screenshots = [];
      try { covers = JSON.parse(g.covers_json) || []; } catch {}
      try { screenshots = JSON.parse(g.screenshots_json) || []; } catch {}
      delete g.covers_json;
      delete g.screenshots_json;
      return { ...g, versions, covers, screenshots };
    });

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
      SELECT g.id, g.name, g.description, g.year, g.manufacturer, g.cloneof, g.platform,
        MIN(g.version_id) as version_id, MIN(sv.source) as source, MIN(sv.version) as version,
        GROUP_CONCAT(sv.source || '||' || sv.version, '||') as versions_tags,
        MAX(CASE WHEN g.covers != '[]' THEN g.covers ELSE NULL END) as covers_json,
        MAX(CASE WHEN g.screenshots != '[]' THEN g.screenshots ELSE NULL END) as screenshots_json,
        rp.played_at
      FROM recently_played rp
      JOIN game_entries g ON g.id = rp.game_entry_id
      JOIN set_versions sv ON sv.id = g.version_id
      GROUP BY g.name
      ORDER BY rp.played_at DESC
      LIMIT 6
    `).map(g => {
      const tags = g.versions_tags ? g.versions_tags.split('||') : [];
      const versions = [];
      for (let i = 0; i < tags.length; i += 2) versions.push(tags[i + 1]);
      delete g.versions_tags;
      let covers = [];
      let screenshots = [];
      try { covers = JSON.parse(g.covers_json) || []; } catch {}
      try { screenshots = JSON.parse(g.screenshots_json) || []; } catch {}
      delete g.covers_json;
      delete g.screenshots_json;
      return { ...g, versions, covers, screenshots };
    });
    res.json({ games });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'not found' });
    if (typeof game.covers === 'string') try { game.covers = JSON.parse(game.covers); } catch { game.covers = []; }
    if (typeof game.screenshots === 'string') try { game.screenshots = JSON.parse(game.screenshots); } catch { game.screenshots = []; }
    if (typeof game.synopsis === 'string') try { game.synopsis = JSON.parse(game.synopsis); } catch {}
    const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
    const state = get('SELECT * FROM game_state WHERE game_entry_id = ?', [game.id]);
    const clones = all(`SELECT id, name, description, cloneof, region FROM game_entries WHERE name = ? AND version_id = ? AND id != ?${game.cloneof ? ' AND cloneof IS NOT NULL' : ''} ORDER BY name`, [game.cloneof || game.name, game.version_id, game.id]);
    let parent = null;
    if (game.cloneof) {
      parent = get('SELECT id, name, region FROM game_entries WHERE name = ? AND version_id = ? AND cloneof IS NULL', [game.cloneof, game.version_id]);
    }
    res.json({ ...game, roms, rating: state?.rating || 0, favourite: state?.favourite || 0, available: state?.available || 0, play_count: state?.play_count || 0, clones, parent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check availability of ROM files for a game (real-time CRC check)
router.get('/:id/availability', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'not found' });

    const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
    const available = {}; // rom_id → boolean

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
    const col = get('SELECT c.folder, c.slug FROM collections c JOIN collection_versions cv ON cv.collection_id = c.id WHERE cv.version_id = ? LIMIT 1', [game.version_id]);
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
      for (const rom of roms) {
        if (rom.merge_target) {
          let currentName = game.romof || game.cloneof;
          while (currentName && !parentPath) {
            const pDir = path.join(dataDir, 'roms', colFolder, game.version, 'roms');
            const pDirs = game.platform ? [path.join(pDir, game.platform), pDir] : [pDir];
            for (const d of pDirs) {
              if (!fs.existsSync(d)) continue;
              for (const entry of fs.readdirSync(d)) {
                if (entry.endsWith('.zip') && path.basename(entry, '.zip') === currentName) {
                  parentPath = path.join(d, entry);
                  break;
                }
              }
              if (parentPath) break;
            }
            if (!parentPath) {
              const parentGame = get('SELECT romof, cloneof FROM game_entries WHERE version_id = ? AND name = ?', [game.version_id, currentName]);
              currentName = parentGame ? (parentGame.romof || parentGame.cloneof) : null;
            }
          }
          break;
        }
      }
    }

    const gameCrcs = gameZipPath ? getZipCrcs(gameZipPath) : null;
    const parentCrcs = parentPath ? getZipCrcs(parentPath) : null;

    for (const rom of roms) {
      if (!rom.crc32) { available[rom.id] = false; continue; }
      if (rom.merge_target) {
        available[rom.id] = !!gameZipPath && !!parentCrcs && parentCrcs.has(rom.crc32.toUpperCase());
      } else {
        available[rom.id] = !!gameCrcs && gameCrcs.has(rom.crc32.toUpperCase());
      }
    }

    res.json({ available });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a ROM file for emulation (auto-finds the correct file)
router.get('/:id/play', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let filePath = null

    // Helper: search directory recursively for a .zip matching game name
    function findInDir(dir) {
      if (!fs.existsSync(dir)) return null
      try {
        const entries = fs.readdirSync(dir)
        for (const entry of entries) {
          const fullPath = path.join(dir, entry)
          if (fs.statSync(fullPath).isDirectory()) {
            const found = findInDir(fullPath)
            if (found) return found
          } else if (entry.endsWith('.zip')) {
            const stem = path.basename(entry, '.zip')
            if (stem === game.name) return fullPath
          }
        }
      } catch {}
      return null
    }

    // 1. Arcade/MAME/FBNeo: find zip in version directory
    const col1 = get(`SELECT c.folder, c.slug FROM collections c
      JOIN collection_versions cv ON cv.collection_id = c.id
      WHERE cv.version_id = ? LIMIT 1`, [game.version_id]);
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
          filePath = findInDir(d)
          if (filePath) break
        }
      }
    }

    // 1b. FBNeo/MAME only: fallback to older versions via .version
    if (!filePath && (game.source === 'FBNeo' || game.source === 'MAME')) {
      if (colFolder1) {
        const versionFile = path.join(dataDir, 'roms', colFolder1, '.version')
        if (fs.existsSync(versionFile)) {
          const versions = fs.readFileSync(versionFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
          const idx = versions.indexOf(game.version)
          if (idx > 0) {
            for (const v of versions.slice(0, idx).reverse()) {
              const olderDirs = [
                ...(game.platform ? [path.join(dataDir, 'roms', colFolder1, v, 'roms', game.platform)] : []),
                path.join(dataDir, 'roms', colFolder1, v, 'roms'),
              ];
              for (const d of olderDirs) {
                filePath = findInDir(d)
                if (filePath) break
              }
              if (filePath) break
            }
          }
        }
      }
    }

    // 2. NPS: find the downloaded file
    if (!filePath && game.source === 'NPS') {
      const rom = get('SELECT * FROM rom_entries WHERE game_entry_id = ? AND subtype = ? LIMIT 1', [game.id, 'game']);
      if (rom) {
        const col = get(`SELECT c.folder, c.slug FROM collections c
          JOIN collection_versions cv ON cv.collection_id = c.id
          WHERE cv.version_id = ? LIMIT 1`, [game.version_id]);
        const colFolder = col?.folder || col?.slug || String(game.version_id);
        const subDir = rom.subtype === 'dlc' ? 'DLCs' : rom.subtype === 'update' ? 'Updates' : 'Games'
        const candidate = path.join(dataDir, 'roms', colFolder, game.platform, subDir, rom.filename)
        if (fs.existsSync(candidate)) filePath = candidate
      }
    }

    // 3. No-Intro/DAT: try first ROM entry in common locations
    if (!filePath) {
      const rom = get('SELECT * FROM rom_entries WHERE game_entry_id = ? LIMIT 1', [game.id]);
      if (rom) {
        const col = get(`SELECT c.folder, c.slug FROM collections c
          JOIN collection_versions cv ON cv.collection_id = c.id
          WHERE cv.version_id = ? LIMIT 1`, [game.version_id]);
        const colFolder = col?.folder || col?.slug || String(game.version_id);
        const baseRomsDir = path.join(dataDir, 'roms', colFolder);
        const candidates = [
          path.join(baseRomsDir, rom.filename),
          path.join(baseRomsDir, 'Games', rom.filename),
        ]
        if (!rom.filename.endsWith('.zip')) {
          candidates.push(path.join(baseRomsDir, rom.filename + '.zip'))
          candidates.push(path.join(baseRomsDir, 'Games', rom.filename + '.zip'))
        }
        for (const c of candidates) {
          if (fs.existsSync(c)) { filePath = c; break }
        }
      }
    }

    if (!filePath) return res.status(404).json({ error: 'ROM file not found on disk' })

    // For split-format zips: merge parent ROMs into the game zip
    if (colFolder1) {
      const vers = get('SELECT version FROM set_versions WHERE id = ?', [game.version_id]);
      if (vers) {
        const romsDir = path.join(dataDir, 'roms', colFolder1, vers.version, 'roms');
        const searchDirs = [
          ...(game.platform ? [path.join(romsDir, game.platform)] : []),
          romsDir,
        ];

        // Collect parent zips for merge: follow romof chain, or find via merge_target
        const parentZips = [];

        // Method 1: Follow romof (or cloneof fallback) chain
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
          const parentGame = get('SELECT romof, cloneof FROM game_entries WHERE version_id = ? AND name = ?', [game.version_id, currentRef]);
          currentRef = parentGame ? (parentGame.romof || parentGame.cloneof) : null;
        }

        // Method 2: No romof chain but has merge_target ROMs — find parent by content
        if (parentZips.length === 0) {
          const mergeTargets = all('SELECT DISTINCT merge_target FROM rom_entries WHERE game_entry_id = ? AND merge_target IS NOT NULL', [game.id]);
          if (mergeTargets.length > 0) {
            const targetNames = new Set(mergeTargets.map(r => r.merge_target));
            for (const d of searchDirs) {
              if (!fs.existsSync(d)) continue;
              for (const entry of fs.readdirSync(d)) {
                if (!entry.endsWith('.zip') || entry === path.basename(filePath)) continue;
                try {
                  // Check if this zip contains any merge target entry
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
            // Extract parents in chain order (root first, then closer)
            for (const pz of parentZips.reverse()) {
              execSync(`unzip -o "${pz}" -d "${mergeDir}"`, { stdio: 'ignore' });
            }
            // Extract game zip last (overrides)
            execSync(`unzip -o "${filePath}" -d "${mergeDir}"`, { stdio: 'ignore' });
            // Re-zip
            execSync(`cd "${mergeDir}" && zip -X -r "${mergedPath}" .`, { stdio: 'ignore' });
            filePath = mergedPath;
            res.on('finish', () => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });
          } catch (e) {
            try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          }
        }
      }
    }

    const ext = path.extname(filePath).toLowerCase()
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
    }

    const contentType = contentTypes[ext] || 'application/octet-stream'
    const stat = fs.statSync(filePath)

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
      'Cache-Control': 'public, max-age=3600',
    })
    fs.createReadStream(filePath).pipe(res)
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export async function scrapeSingleGame(gameId) {
  const game = get('SELECT * FROM game_entries WHERE id = ?', [gameId]);
  if (!game) return { scraped: false, error: 'Game not found', gameId };

  function trySearch(query, platform) {
    const args = ['search', query];
    if (platform) args.push('--platform', platform);
    const r = execCli(args, { binary: 'scraper' });
    if (r?.results?.length) return r;
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

  if (game.platform === 'arcade' && game.name) {
    const expanded = get('SELECT description FROM game_entries WHERE name = ? AND description IS NOT NULL AND description != name LIMIT 1', [game.name]);
    if (expanded?.description) {
      const clean = expanded.description.replace(/\s*\([^)]*\)\s*/g, '').trim();
      if (clean && !candidates.includes(clean)) candidates.unshift(clean);
    }
  }

  if (game.description) {
    const stripped = game.description.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
    if (!candidates.includes(game.description)) candidates.push(game.description);
  }

  if (game.name) {
    const spaced = game.name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
    if (spaced !== game.name && !candidates.includes(spaced)) candidates.push(spaced);
  }

  if (game.name) {
    const VARIANT_SUFFIXES = ['j','u','e','a','w','p','h','b','f','s','k','ja','ju','us','ua','uk','eu','hk','tw','kr','fr','de','es','it','nl','br'];
    for (const sfx of VARIANT_SUFFIXES) {
      if (game.name.endsWith(sfx) && game.name.length > sfx.length + 2) {
        const base = game.name.slice(0, -sfx.length);
        const baseSpaced = base.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
        if (!candidates.includes(baseSpaced)) candidates.push(baseSpaced);
        if (!candidates.includes(base)) candidates.push(base);
        break;
      }
    }
  }

  if (game.name && !candidates.includes(game.name)) candidates.push(game.name);

  let searchResult = null;
  let matchedTitle = null;
  for (const q of candidates) {
    const r = trySearch(q, game.platform);
    if (!r) continue;
    const ranked = rankResults(r.results, q, game.name, game.platform);
    const best = ranked[0];
    searchResult = { results: [best] };
    matchedTitle = best.title;
    break;
  }

  if (!searchResult) {
    return { scraped: false, error: 'No matches found in any provider', gameId };
  }

  const first = searchResult.results[0];
  let detailResult;
  try {
    detailResult = execCli(['detail', first.id], { binary: 'scraper' });
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

  if (synopsis || year || manufacturer || detailResult.covers?.length || detailResult.screenshots?.length) {
    const updates = [];
    const upParams = [];
    if (synopsis) { updates.push('synopsis = ?'); upParams.push(synopsis); }
    if (year && !game.year) { updates.push('year = ?'); upParams.push(year); }
    if (manufacturer && !game.manufacturer) { updates.push('manufacturer = ?'); upParams.push(manufacturer); }
    if (detailResult.covers?.length) {
      updates.push('covers = ?');
      upParams.push(JSON.stringify(upgradeCovers(detailResult.covers)));
    }
    if (detailResult.screenshots?.length) {
      updates.push('screenshots = ?');
      upParams.push(JSON.stringify(upgradeScreenshots(detailResult.screenshots)));
    }
    upParams.push(game.id);
    run(`UPDATE game_entries SET ${updates.join(', ')} WHERE id = ?`, upParams);
  }

  const updated = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [game.id]);
  if (typeof updated.covers === 'string') try { updated.covers = JSON.parse(updated.covers); } catch { updated.covers = []; }
  if (typeof updated.screenshots === 'string') try { updated.screenshots = JSON.parse(updated.screenshots); } catch { updated.screenshots = []; }
  updated.roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);

  // For NPS/PlayStation games, try to get screenshots from Sony Store API via scraper-cli
  if (updated.source === 'NPS' && (!updated.screenshots || updated.screenshots.length === 0)) {
    try {
      const contentId = updated.content_id || updated.title_id;
      if (contentId) {
        const detailResult = execCli(['detail', contentId, '--source', 'sony-store'], { binary: 'scraper' });
        if (detailResult && detailResult.screenshots?.length > 0) {
          run('UPDATE game_entries SET screenshots = ? WHERE id = ?', [JSON.stringify(detailResult.screenshots), game.id]);
          updated.screenshots = detailResult.screenshots;
        }
      }
    } catch {}
  }

  // For DAT-O-MATIC collections, try to get covers/screenshots from no-intro-pictures
  if (!updated.covers?.length && !updated.screenshots?.length) {
    try {
      const colVersion = get(`SELECT c.dataset_preset FROM collections c
        JOIN collection_versions cv ON cv.collection_id = c.id
        WHERE cv.version_id = ? LIMIT 1`, [game.version_id]);
      if (colVersion?.dataset_preset === 'DATOMATIC') {
        // Use description as game name (has full No-Intro naming with region)
        const gameNameForUrl = game.description || game.name;
        const detailResult = execCli(['detail', `${game.platform || 'unknown'}/${gameNameForUrl}`, '--source', 'no-intro-pictures'], { binary: 'scraper' });
        if (detailResult && !detailResult.error) {
          const updates = [];
          const upParams = [];
          if (detailResult.covers?.length) {
            updates.push('covers = ?');
            upParams.push(JSON.stringify(detailResult.covers));
          }
          if (detailResult.screenshots?.length) {
            updates.push('screenshots = ?');
            upParams.push(JSON.stringify(detailResult.screenshots));
          }
          if (updates.length > 0) {
            upParams.push(game.id);
            run(`UPDATE game_entries SET ${updates.join(', ')} WHERE id = ?`, upParams);
            if (detailResult.covers?.length) updated.covers = detailResult.covers;
            if (detailResult.screenshots?.length) updated.screenshots = detailResult.screenshots;
          }
        }
      }
    } catch {}
  }

  const hadData = synopsis || year || manufacturer || detailResult.covers?.length || detailResult.screenshots?.length;
  return { scraped: true, saved: !!hadData, title: matchedTitle || first.title, game: updated, gameId };
}

router.post('/:id/scrape', async (req, res) => {
  await dbReady;
  try {
    const result = await scrapeSingleGame(req.params.id);
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
            const existing = get('SELECT manufacturer, year FROM game_entries WHERE id = ?', [gid]);
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
    const existing = get('SELECT game_entry_id FROM game_state WHERE game_entry_id = ?', [req.params.id]);
    if (existing) {
      if (rating != null) run("UPDATE game_state SET rating = ?, updated_at = datetime('now') WHERE game_entry_id = ?", [rating, req.params.id]);
      if (favourite != null) run("UPDATE game_state SET favourite = ?, updated_at = datetime('now') WHERE game_entry_id = ?", [favourite ? 1 : 0, req.params.id]);
    } else {
      run('INSERT INTO game_state (game_entry_id, rating, favourite) VALUES (?, ?, ?)', [req.params.id, rating ?? 0, favourite ? 1 : 0]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/play', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT id FROM game_entries WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    run("INSERT OR REPLACE INTO recently_played (game_entry_id, played_at) VALUES (?, datetime('now'))", [req.params.id]);
    run(`DELETE FROM recently_played WHERE game_entry_id NOT IN (
      SELECT game_entry_id FROM recently_played ORDER BY played_at DESC LIMIT 6
    )`);
    const existing = get('SELECT game_entry_id FROM game_state WHERE game_entry_id = ?', [req.params.id]);
    if (existing) {
      run("UPDATE game_state SET play_count = play_count + 1, updated_at = datetime('now') WHERE game_entry_id = ?", [req.params.id]);
    } else {
      run("INSERT INTO game_state (game_entry_id, play_count) VALUES (?, 1)", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/cover', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT id, name, covers FROM game_entries WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).end();

    if (game.covers) {
      try {
        const urls = JSON.parse(game.covers);
        if (urls.length > 0) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const imgResp = await fetch(urls[0], { signal: controller.signal });
          clearTimeout(timeout);
          if (imgResp.ok) {
            const buf = Buffer.from(await imgResp.arrayBuffer());
            res.set('Content-Type', imgResp.headers.get('content-type') || 'image/jpeg');
            res.set('Cache-Control', 'no-cache');
            return res.send(buf);
          }
        }
      } catch {}
    }

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
    res.send(svg);
  } catch (e) { res.status(500).end(); }
});

// =============================================================================
// Download game from Internet Archive via ia-cli
// =============================================================================
router.post('/:id/download-ia', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.id, g.name, g.platform, g.version_id, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const col = get(`SELECT c.id, c.folder, c.slug, c.name FROM collections c
      JOIN collection_versions cv ON cv.collection_id = c.id
      WHERE cv.version_id = ? LIMIT 1`, [game.version_id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    const romset = game.source.toLowerCase();
    const colFolder = col.folder || col.slug;

    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        const baseRomDir = path.resolve(dataDir, 'roms', colFolder, game.version || '', 'roms');
        const outputDir = game.platform ? path.join(baseRomDir, game.platform) : baseRomDir;
        fs.mkdirSync(outputDir, { recursive: true });

        // Build CRC string from rom_entries (exclude merge_target ROMs — split format)
        const roms = all('SELECT filename, crc32 FROM rom_entries WHERE game_entry_id = ? AND crc32 IS NOT NULL AND crc32 != ? AND merge_target IS NULL', [game.id, '']);
        const crcStr = roms.map(r => `${r.filename}:${r.crc32.toUpperCase()}`).join(',');

        // Check cache for a known IA item identifier
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

        const result = execCli(args, { binary: 'ia' });

        // Parse JSON result from CLI
        if (!result.ok) {
          const errMsg = result.error || 'Unknown error';
          const dlUrl = result.download_url || '';
          const msg = dlUrl ? `${errMsg}. Download URL: ${dlUrl}` : errMsg;
          throw new Error(msg);
        }

        // Update cache with the found identifier
        if (result.cached_id) {
          setCachedId(romset, game.version || '', result.cached_id);
        }

        // Verify the file was actually downloaded
        const filename = result.file || game.name;
        const downloadedFile = [path.join(outputDir, filename), ...['.zip', '.7z'].map(ext => path.join(outputDir, game.name + ext))]
          .find(f => fs.existsSync(f));

        if (!downloadedFile) {
          const files = fs.readdirSync(outputDir).filter(f => f.toLowerCase().includes(game.name.toLowerCase()));
          if (files.length === 0) {
            throw new Error(`Download completed but file not found for ${game.name}`);
          }
        }

        // Update game_state.available after successful download
        run(`INSERT INTO game_state (game_entry_id, available, updated_at)
          SELECT ge.id, 1, datetime('now') FROM game_entries ge WHERE ge.id = ?
          ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')`, [game.id]);

        doneJob(jobId, { ok: true, crc_match: result.crc_match, details: result });
      } catch (e) {
        if (job._abort.signal.aborted) return;
        failJob(jobId, e.message);
      }
    }, 0);

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
