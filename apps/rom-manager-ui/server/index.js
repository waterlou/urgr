import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb, closeDb, saveDb } from './db.js';
import { execCli } from './cli.js';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const distPath = path.join(__dirname, '..', 'dist');
const dbPath = process.env.ROM_DB || path.join(__dirname, '..', '..', '..', 'roms.db');
let dbReady = initDb(dbPath);

function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function run(sql, params = []) {
  getDb().run(sql, params);
  saveDb();
}

// =============================================================================
// Status
// =============================================================================
app.get('/api/status', async (req, res) => {
  await dbReady;
  try {
    const db = getDb();
    const v = db.exec("SELECT COUNT(*) as c FROM set_versions")[0].values[0][0];
    const g = db.exec("SELECT COUNT(*) as c FROM game_entries")[0].values[0][0];
    const r = db.exec("SELECT COUNT(*) as c FROM rom_entries")[0].values[0][0];
    const s = db.exec("SELECT COUNT(*) as c FROM scanned_games")[0].values[0][0];
    const c = db.exec("SELECT COUNT(*) as c FROM collections")[0].values[0][0];
    const gs = db.exec("SELECT COUNT(*) as c FROM game_sets")[0].values[0][0];
    res.json({ versions: v, games: g, roms: r, scanned: s, collections: c, game_sets: gs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Collections
// =============================================================================
app.get('/api/collections', async (req, res) => {
  await dbReady;
  try {
    const rows = all('SELECT c.* FROM collections c ORDER BY c.name');
    const result = rows.map(c => {
      const versions = all('SELECT version_id FROM collection_versions WHERE collection_id = ?', [c.id]);
      const vids = versions.map(v => v.version_id);
      let total = 0;
      if (vids.length) {
        const placeholders = vids.map(() => '?').join(',');
        total = get(`SELECT COUNT(*) as c FROM game_entries WHERE version_id IN (${placeholders})`, vids).c;
      }
      return { ...c, total_games: total };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections', async (req, res) => {
  await dbReady;
  try {
    let { name, slug, platform, logo, folder, has_dataset, dataset_preset, uploaded_version_id } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    // Deduplicate slug
    let finalSlug = slug;
    let counter = 1;
    while (get('SELECT id FROM collections WHERE slug = ?', [finalSlug])) {
      finalSlug = `${slug}-${counter++}`;
    }
    run('INSERT INTO collections (name, slug, platform, logo, folder, has_dataset) VALUES (?, ?, ?, ?, ?, ?)',
      [name, finalSlug, platform || null, logo || '', folder || slug, has_dataset ? 1 : 0]);
    const col = get('SELECT * FROM collections WHERE slug = ?', [finalSlug]);
    if (uploaded_version_id) {
      run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)',
        [col.id, uploaded_version_id]);
    }
    res.status(201).json(col);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, platform, logo, folder } = req.body;
    const sets = [];
    const vals = [];
    if (name != null) { sets.push('name = ?'); vals.push(name); }
    if (platform != null) { sets.push('platform = ?'); vals.push(platform); }
    if (logo != null) { sets.push('logo = ?'); vals.push(logo); }
    if (folder != null) { sets.push('folder = ?'); vals.push(folder); }
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    if (sets.length) run(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json(get('SELECT * FROM collections WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM collections WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collections/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc' } = req.query;
    const collection = get('SELECT * FROM collections WHERE id = ?', [id]);
    if (!collection) return res.status(404).json({ error: 'not found' });

    const versions = all('SELECT version_id FROM collection_versions WHERE collection_id = ?', [id]);
    if (!versions.length) return res.json({ collection, games: [], platforms: [], total: 0 });

    const vids = versions.map(v => v.version_id);
    const ph = vids.map(() => '?').join(',');
    const sortCol = sort === 'rating' ? 'COALESCE(r.rating, 0)' : sort === 'favourite' ? 'COALESCE(r.favourite, 0)' : sort === 'play_count' ? 'COALESCE(r.play_count, 0)' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    const total = get(`SELECT COUNT(*) as c FROM game_entries g WHERE g.version_id IN (${ph})`, vids).c;

    const games = all(`
      SELECT g.*, sv.source, sv.version,
        COALESCE(r.rating, 0) as rating, COALESCE(r.favourite, 0) as favourite,
        COALESCE(r.play_count, 0) as play_count
      FROM game_entries g
      JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN game_ratings r ON r.game_entry_id = g.id
      WHERE g.version_id IN (${ph})
      ORDER BY ${sortCol} ${sortDir}, g.name LIMIT ? OFFSET ?
    `, [...vids, Number(limit), Number(offset)]);

    const platforms = all(`SELECT DISTINCT sv.source as platform FROM set_versions sv WHERE sv.id IN (${ph})`, vids).map(p => p.platform);

    res.json({ collection, games, platforms, total, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const { version_id } = req.body;
    run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [req.params.id, version_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/collections/:id/versions/:versionId', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM collection_versions WHERE collection_id = ? AND version_id = ?', [req.params.id, req.params.versionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Game Sets
// =============================================================================
app.get('/api/game-sets', async (req, res) => {
  await dbReady;
  try {
    const sets = all('SELECT gs.*, (SELECT COUNT(*) FROM game_set_games WHERE game_set_id = gs.id) as total_games FROM game_sets gs ORDER BY gs.name');
    res.json(sets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/game-sets', async (req, res) => {
  await dbReady;
  try {
    const { name, description, icon, platforms } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    run('INSERT INTO game_sets (name, description, icon, platforms) VALUES (?, ?, ?, ?)',
      [name, description || '', icon || '', platforms || '']);
    const row = get('SELECT * FROM game_sets WHERE name = ? ORDER BY id DESC', [name]);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/game-sets/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, description, icon, platforms } = req.body;
    const sets = []; const vals = [];
    if (name != null) { sets.push('name = ?'); vals.push(name); }
    if (description != null) { sets.push('description = ?'); vals.push(description); }
    if (icon != null) { sets.push('icon = ?'); vals.push(icon); }
    if (platforms != null) { sets.push('platforms = ?'); vals.push(platforms); }
    if (sets.length) { vals.push(req.params.id); run(`UPDATE game_sets SET ${sets.join(', ')} WHERE id = ?`, vals); }
    res.json(get('SELECT * FROM game_sets WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/game-sets/:id', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM game_sets WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game-sets/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc' } = req.query;
    const gameSet = get('SELECT * FROM game_sets WHERE id = ?', [id]);
    if (!gameSet) return res.status(404).json({ error: 'not found' });
    const sortCol = sort === 'rating' ? 'COALESCE(r.rating, 0)' : sort === 'favourite' ? 'COALESCE(r.favourite, 0)' : sort === 'play_count' ? 'COALESCE(r.play_count, 0)' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';
    const total = get('SELECT COUNT(*) as c FROM game_set_games WHERE game_set_id = ?', [id]).c;
    const games = all(`
      SELECT g.*, sv.source, sv.version, COALESCE(r.rating, 0) as rating, COALESCE(r.favourite, 0) as favourite, COALESCE(r.play_count, 0) as play_count
      FROM game_set_games gsg JOIN game_entries g ON g.id = gsg.game_entry_id
      JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN game_ratings r ON r.game_entry_id = g.id
      WHERE gsg.game_set_id = ?
      ORDER BY ${sortCol} ${sortDir}, g.name LIMIT ? OFFSET ?
    `, [id, Number(limit), Number(offset)]);
    const size = get('SELECT SUM(re.size) as total_bytes FROM game_set_games gsg JOIN rom_entries re ON re.game_entry_id = gsg.game_entry_id WHERE gsg.game_set_id = ?', [id]);
    res.json({ game_set: gameSet, games, total, total_size: size?.total_bytes || 0, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/game-sets/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { game_entry_ids } = req.body;
    if (!game_entry_ids?.length) return res.status(400).json({ error: 'game_entry_ids required' });
    const insert = getDb().prepare('INSERT OR IGNORE INTO game_set_games (game_set_id, game_entry_id) VALUES (?, ?)');
    for (const gid of game_entry_ids) { insert.bind([req.params.id, gid]); insert.step(); insert.reset(); }
    insert.free();
    res.json({ ok: true, added: game_entry_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/game-sets/:id/games/:gameId', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM game_set_games WHERE game_set_id = ? AND game_entry_id = ?', [req.params.id, req.params.gameId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game-sets/:id/export', async (req, res) => {
  await dbReady;
  try {
    const gs = get('SELECT * FROM game_sets WHERE id = ?', [req.params.id]);
    if (!gs) return res.status(404).json({ error: 'not found' });
    const games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, g.cloneof, sv.source, sv.version, r.size
      FROM game_set_games gsg JOIN game_entries g ON g.id = gsg.game_entry_id
      JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN rom_entries r ON r.game_entry_id = g.id AND r.id = (SELECT MIN(id) FROM rom_entries WHERE game_entry_id = g.id)
      WHERE gsg.game_set_id = ? ORDER BY g.name
    `, [req.params.id]);
    res.json({ game_set: gs, games, total_games: games.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Reference data
// =============================================================================
const KNOWN_PLATFORMS = [
  'Arcade', 'Multi', 'NES', 'SNES', 'Nintendo 64', 'Game Boy', 'Game Boy Color',
  'Game Boy Advance', 'Nintendo DS', 'Nintendo 3DS', 'Sega Genesis', 'Sega Saturn',
  'Sega Dreamcast', 'PlayStation', 'PlayStation 2', 'PlayStation Portable',
  'MSX', 'Commodore 64', 'Amiga', 'Atari 2600', 'Atari 7800', 'TurboGrafx-16',
  'Neo Geo', 'Neo Geo Pocket', 'WonderSwan',
];

const POPULAR_DATASETS = [
  { name: 'MAME', slug: 'mame', platform: 'Arcade' },
  { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
];

app.get('/api/platforms', async (req, res) => { await dbReady; res.json(KNOWN_PLATFORMS); });

app.get('/api/datasets', async (req, res) => {
  await dbReady;
  try {
    const imported = all('SELECT id, source, version FROM set_versions ORDER BY source, version');
    res.json({ popular: POPULAR_DATASETS, imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Browse / Search
// =============================================================================
app.get('/api/search', async (req, res) => {
  await dbReady;
  try {
    const { q, limit = 50 } = req.query;
    if (!q) return res.json([]);
    const games = all(`
      SELECT g.*, sv.source, sv.version
      FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id
      WHERE g.name LIKE ? OR g.description LIKE ? OR g.manufacturer LIKE ?
      ORDER BY g.name LIMIT ?
    `, [`%${q}%`, `%${q}%`, `%${q}%`, Number(limit)]);
    res.json(games);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browse', async (req, res) => {
  await dbReady;
  try {
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q } = req.query;
    const sortCol = sort === 'rating' ? 'COALESCE(r.rating, 0)' : sort === 'favourite' ? 'COALESCE(r.favourite, 0)' : sort === 'play_count' ? 'COALESCE(r.play_count, 0)' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';
    const where = q ? 'WHERE (g.name LIKE ? OR g.description LIKE ? OR sv.source LIKE ?)' : '';
    const params = q
      ? [`%${q}%`, `%${q}%`, `%${q}%`, Number(limit), Number(offset)]
      : [Number(limit), Number(offset)];
    const total = q
      ? get(`SELECT COUNT(*) as c FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.name LIKE ? OR g.description LIKE ? OR sv.source LIKE ?`, [`%${q}%`, `%${q}%`, `%${q}%`]).c
      : get('SELECT COUNT(*) as c FROM game_entries').c;
    const games = all(`
      SELECT g.*, sv.source, sv.version, COALESCE(r.rating, 0) as rating, COALESCE(r.favourite, 0) as favourite, COALESCE(r.play_count, 0) as play_count
      FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN game_ratings r ON r.game_entry_id = g.id
      ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?
    `, params);
    res.json({ games, total, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Versions
// =============================================================================
app.get('/api/versions', async (req, res) => {
  await dbReady;
  try {
    const versions = all('SELECT sv.*, (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games FROM set_versions sv ORDER BY sv.created_at DESC');
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/versions/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0, q } = req.query;
    if (!get('SELECT 1 FROM set_versions WHERE id = ?', [id])) return res.status(404).json({ error: 'not found' });
    const where = q ? 'AND (name LIKE ? OR description LIKE ? OR manufacturer LIKE ?)' : '';
    const params = q ? [id, `%${q}%`, `%${q}%`, `%${q}%`, Number(limit), Number(offset)] : [id, Number(limit), Number(offset)];
    const games = all(`SELECT * FROM game_entries WHERE version_id = ? ${where} ORDER BY name LIMIT ? OFFSET ?`, params);
    res.json({ games, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Game detail + rating
// =============================================================================
app.get('/api/games/:id', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'not found' });
    const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
    const scanned = all('SELECT * FROM scanned_games WHERE name = ? AND version_id = ?', [game.name, game.version_id]);
    const rating = get('SELECT * FROM game_ratings WHERE game_entry_id = ?', [game.id]);
    res.json({ ...game, roms, scanned_games: scanned, rating });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/games/:id/rating', async (req, res) => {
  await dbReady;
  try {
    const { rating, favourite } = req.body;
    const existing = get('SELECT id FROM game_ratings WHERE game_entry_id = ?', [req.params.id]);
    if (existing) {
      if (rating != null) run("UPDATE game_ratings SET rating = ?, updated_at = datetime('now') WHERE game_entry_id = ?", [rating, req.params.id]);
      if (favourite != null) run("UPDATE game_ratings SET favourite = ?, updated_at = datetime('now') WHERE game_entry_id = ?", [favourite ? 1 : 0, req.params.id]);
    } else {
      run('INSERT INTO game_ratings (game_entry_id, rating, favourite) VALUES (?, ?, ?)', [req.params.id, rating ?? 0, favourite ? 1 : 0]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Covers
// =============================================================================
app.get('/api/covers/:id', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT id, name FROM game_entries WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).end();
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
// MAME DAT version checking
// =============================================================================

const MAME_DATS_URL = 'https://www.progettosnaps.net/dats/MAME/';

// Parse MAME version string to comparable tuple: [major, minor, beta]
function parseMameVersion(str) {
  const m = str.trim().match(/^(\d+)\.(\d+)(?:b(\d+))?$/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]), parseInt(m[2]), m[3] ? parseInt(m[3]) : 0];
}

function fmtVersion(v) { return v[2] > 0 ? `${v[0]}.${v[1]}b${v[2]}` : `${v[0]}.${v[1]}`; }

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

let mameDatsCache = null;
let mameDatsCacheTime = 0;
const CACHE_TTL = 600_000; // 10 min

app.get('/api/mame-dats', async (req, res) => {
  await dbReady;
  try {
    if (mameDatsCache && Date.now() - mameDatsCacheTime < CACHE_TTL) {
      return res.json(mameDatsCache);
    }

    const html = await (await fetch(MAME_DATS_URL)).text();

    // Extract latest version (HTML spans split words: "a vailable" and "0. 2 87")
    const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const latestMatch = plainText.match(/Latest\s+dat\s+a\s*vailable:\s*([\d.\sb]+)/i);
    const latestVer = latestMatch ? parseMameVersion(latestMatch[1].replace(/\s+/g, '')) : null;

    // Parse table rows: extract version from <td> cells
    const rows = [];
    const rowRegex = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      const cellRegex = /<TD[^>]*>[\s\S]*?<\/TD>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        // Clean up HTML tags, <span>, etc.
        let text = cellMatch[0]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(text);
      }
      if (cells.length >= 3) {
        const rawVer = cells[0].replace(/[()]/g, '').trim();
        const ver = rawVer.split(/\s+/)[0]; // take first token like "0.37" from "0.37 (0.37b1)"
        const parsed = parseMameVersion(ver);
        if (parsed[0] > 0 || parsed[1] > 0) {
          rows.push({
            version: rawVer,
            parsed,
            date: cells[1] || '',
            hasDat: cells[2] !== '-' && cells[2] !== '',
            year: cells[1].match(/(\d{4})/)?.[1] || '',
          });
        }
      }
    }

    // Get imported versions from DB
    const imported = all('SELECT id, source, version FROM set_versions WHERE source = ? ORDER BY version', ['MAME']);
    const importedParsed = imported.map(v => ({
      id: v.id,
      version: v.version,
      parsed: parseMameVersion(v.version),
    }));

    // Determine available versions not yet imported
    const availableDats = rows.filter(r => r.hasDat && !importedParsed.some(iv => cmpVersion(iv.parsed, r.parsed) === 0));
    const hasNewer = latestVer
      ? !importedParsed.some(iv => cmpVersion(iv.parsed, latestVer) === 0)
      : false;

    const result = {
      latest: latestVer ? fmtVersion(latestVer) : null,
      latestParsed: latestVer,
      available: rows.filter(r => r.hasDat).map(r => ({
        version: r.version,
        numeric: fmtVersion(r.parsed),
        date: r.date,
        year: r.year,
        parsed: r.parsed,
      })),
      imported: importedParsed,
      missing: availableDats.map(r => ({
        version: r.version,
        numeric: fmtVersion(r.parsed),
        date: r.date,
        parsed: r.parsed,
      })),
      hasNewer,
    };

    mameDatsCache = result;
    mameDatsCacheTime = Date.now();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import a MAME DAT version into a collection
app.post('/api/mame-dats/import', async (req, res) => {
  await dbReady;
  try {
    const { collection_id, version } = req.body;
    if (!collection_id || !version) {
      return res.status(400).json({ error: 'collection_id and version required' });
    }
    // Create version in set_versions if not exists
    let row = get('SELECT id FROM set_versions WHERE source = ? AND version = ?', ['MAME', version]);
    if (!row) {
      const db = getDb();
      db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', ['MAME', version]);
      const result = db.exec('SELECT last_insert_rowid() as id');
      if (result && result[0] && result[0].values && result[0].values[0]) {
        row = { id: result[0].values[0][0] };
      } else {
        return res.status(500).json({ error: 'Failed to create version' });
      }
    }
    run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)',
      [collection_id, row.id]);
    mameDatsCache = null;
    res.json({ ok: true, version_id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload and parse a DAT file
app.post('/api/dat/upload', async (req, res) => {
  await dbReady;
  try {
    // Collect raw body (may be sent as text/plain from FormData or fetch)
    let text = '';
    if (typeof req.body === 'string') {
      text = req.body;
    } else if (req.body && typeof req.body === 'object') {
      text = req.body.content || JSON.stringify(req.body);
    } else {
      // Read raw body from stream
      text = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
    }
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Empty or invalid DAT content' });
    }

    // Determine source name from header or use default
    let source = 'Custom';
    let gameCount = 0;
    let version = 'unknown';

    // Try to parse as XML (MAME listxml, ClrMAMEPro XML, or datafile format)
    const gameNames = [];
    if (text.trim().startsWith('<')) {
      // Extract <game name="..."> or <machine name="...">
      const gameRegex = /<(?:game|machine)\s+name="([^"]+)"/gi;
      let match;
      while ((match = gameRegex.exec(text)) !== null) {
        gameNames.push(match[1]);
      }
      // Try to extract version from header
      const verMatch = text.match(/version\s*=\s*["']?([\d.]+)/i);
      if (verMatch) version = verMatch[1];
      const headerMatch = text.match(/<(?:mame|datafile|clrmamepro)[^>]*>/i);
      if (headerMatch) source = 'DAT';
    } else {
      // Try to parse as simple DAT format: game ( name "..." )
      const gameRegex = /game\s*\(\s*name\s+"([^"]+)"/gi;
      let match;
      while ((match = gameRegex.exec(text)) !== null) {
        gameNames.push(match[1]);
      }
    }

    if (gameNames.length === 0) {
      return res.status(400).json({ error: 'No games found in DAT file. Ensure it is a valid MAME or ClrMAMEPro format.' });
    }

    // Create the version
    const db = getDb();
    db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', [source, version]);
    const idResult = db.exec('SELECT last_insert_rowid() as id');
    const versionId = idResult[0]?.values[0]?.[0];
    if (!versionId) {
      return res.status(500).json({ error: 'Failed to create version in database' });
    }

    // Insert games
    const insert = db.prepare('INSERT INTO game_entries (version_id, name, description) VALUES (?, ?, ?)');
    for (const name of gameNames) {
      insert.bind([versionId, name, '']);
      insert.step();
      insert.reset();
    }
    insert.free();
    saveDb();

    res.json({
      ok: true,
      version_id: versionId,
      source,
      version,
      total_games: gameNames.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Collection Builds
// =============================================================================

app.get('/api/collections/:id/builds', async (req, res) => {
  await dbReady;
  try {
    const builds = all(`
      SELECT cb.*, sv.version, sv.source
      FROM collection_builds cb
      JOIN set_versions sv ON sv.id = cb.version_id
      WHERE cb.collection_id = ?
      ORDER BY cb.created_at DESC
    `, [req.params.id]);
    res.json(builds);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/build', async (req, res) => {
  await dbReady;
  try {
    const { version_id, format = 'split' } = req.body;
    const colId = req.params.id;

    const version = get('SELECT * FROM set_versions WHERE id = ?', [version_id]);
    if (!version) return res.status(400).json({ error: 'Version not found' });

    // Check this version is linked to the collection
    const link = get('SELECT 1 FROM collection_versions WHERE collection_id = ? AND version_id = ?', [colId, version_id]);
    if (!link) return res.status(400).json({ error: 'Version not linked to this collection' });

    // Check existing builds
    const existingBuilds = all('SELECT * FROM collection_builds WHERE collection_id = ? ORDER BY id', [colId]);
    const targetParsed = parseMameVersion(version.version);

    // Rule: cannot build older version than last completed build (MAME versioned only)
    const completedBuilds = existingBuilds.filter(b => b.status === 'complete');
    if (completedBuilds.length > 0) {
      const lastBuildVersion = get('SELECT version FROM set_versions WHERE id = ?', [completedBuilds[completedBuilds.length - 1].version_id]);
      if (lastBuildVersion) {
        const lastParsed = parseMameVersion(lastBuildVersion.version);
        const targetParsed = parseMameVersion(version.version);
        // Only enforce forward-only for parseable MAME versions (0.xxx)
        if (lastParsed[0] > 0 && targetParsed[0] > 0 && cmpVersion(targetParsed, lastParsed) < 0) {
          return res.status(400).json({
            error: `Cannot build version ${version.version}: already built ${lastBuildVersion.version}. Only forward builds allowed.`
          });
        }
      }
    }

    // Rule: must complete current incomplete build first
    const incomplete = existingBuilds.find(b => b.status === 'building' || b.status === 'not_started');
    if (incomplete) {
      const incVersion = get('SELECT version FROM set_versions WHERE id = ?', [incomplete.version_id]);
      return res.status(400).json({
        error: `Cannot start new build: version ${incVersion?.version || 'unknown'} is currently '${incomplete.status}'. Complete it first.`
      });
    }

    // Count total games for this version
    const total = get('SELECT COUNT(*) as c FROM game_entries WHERE version_id = ?', [version_id]).c;

    // Create or update build
    const existing = get('SELECT id FROM collection_builds WHERE collection_id = ? AND version_id = ?', [colId, version_id]);
    if (existing) {
      run("UPDATE collection_builds SET status = 'building', format = ?, games_total = ?, started_at = datetime('now') WHERE id = ?", [format, total, existing.id]);
    } else {
      run("INSERT INTO collection_builds (collection_id, version_id, status, format, games_total, started_at) VALUES (?, ?, 'building', ?, ?, datetime('now'))",
        [colId, version_id, format, total]);
    }

    res.json(get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.collection_id = ? AND cb.version_id = ?', [colId, version_id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collections/:id/builds/:buildId', async (req, res) => {
  await dbReady;
  try {
    const { status, games_built } = req.body;
    const valid = ['not_started', 'building', 'complete', 'failed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    if (status === 'complete') {
      run("UPDATE collection_builds SET status = ?, games_built = COALESCE(?, games_total), completed_at = datetime('now') WHERE id = ? AND collection_id = ?",
        [status, games_built ?? null, req.params.buildId, req.params.id]);
    } else {
      const sets = ["status = ?"];
      const vals = [status];
      if (games_built != null) { sets.push("games_built = ?"); vals.push(games_built); }
      vals.push(req.params.buildId, req.params.id);
      run(`UPDATE collection_builds SET ${sets.join(', ')} WHERE id = ? AND collection_id = ?`, vals);
    }

    res.json(get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.id = ?', [req.params.buildId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Collection Export
// =============================================================================

app.post('/api/collections/:id/export', async (req, res) => {
  await dbReady;
  try {
    const { format = 'split', version_id } = req.body;
    const colId = req.params.id;

    const collection = get('SELECT * FROM collections WHERE id = ?', [colId]);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    // Determine which version to export
    let targetVersionId = version_id;
    if (!targetVersionId) {
      const builds = all('SELECT version_id FROM collection_builds WHERE collection_id = ? AND status = ? ORDER BY completed_at DESC', [colId, 'complete']);
      if (builds.length === 0) return res.status(400).json({ error: 'No completed builds to export' });
      targetVersionId = builds[0].version_id;
    }

    const version = get('SELECT * FROM set_versions WHERE id = ?', [targetVersionId]);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    // Get all games for this version with their ROM details
    const games = all(`
      SELECT g.*, r.filename as rom_filename, r.size, r.crc32, r.md5, r.sha1, r.status as rom_status, r.merge_target
      FROM game_entries g
      LEFT JOIN rom_entries r ON r.game_entry_id = g.id
      WHERE g.version_id = ?
      ORDER BY g.name
    `, [targetVersionId]);

    // Group by game
    const gameMap = {};
    for (const row of games) {
      if (!gameMap[row.id]) {
        gameMap[row.id] = {
          name: row.name,
          description: row.description,
          year: row.year,
          manufacturer: row.manufacturer,
          cloneof: row.cloneof,
          roms: [],
        };
      }
      if (row.rom_filename) {
        gameMap[row.id].roms.push({
          filename: row.rom_filename,
          size: row.size,
          crc32: row.crc32,
          md5: row.md5,
          sha1: row.sha1,
          status: row.rom_status,
          merge_target: row.merge_target,
        });
      }
    }

    const exportData = {
      collection: collection.name,
      version: version.version,
      format,
      total_games: Object.keys(gameMap).length,
      total_roms: games.filter(g => g.rom_filename).length,
      games: Object.values(gameMap),
    };

    res.json(exportData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// CLI integration — delegates to rom-scraper-cli binary
// =============================================================================

app.post('/api/cli/scan', async (req, res) => {
  try {
    const { version_id, dir } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });
    const result = execCli(['scan', String(version_id), dir]);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cli/verify', async (req, res) => {
  try {
    const { version_id, dir, fallback_id } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });
    const args = ['verify', String(version_id), dir];
    if (fallback_id) args.push('--fallback', String(fallback_id));
    const result = execCli(args);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cli/hash', async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file path required' });
    const result = execCli(['hash', file]);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Static files + SPA fallback
// =============================================================================
app.use('/assets', express.static(path.join(distPath, 'assets')));

app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// =============================================================================
// Start
// =============================================================================
app.listen(PORT, () => {
  console.log(`ROM Manager API running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => { saveDb(); closeDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); closeDb(); process.exit(0); });
