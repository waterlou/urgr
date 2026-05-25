import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto, { createHash } from 'crypto';
import { execSync } from 'child_process';
import { initDb, getDb, closeDb, saveDb } from './db.js';
import { execCli, execCliStream } from './cli.js';
import { createJob, getJob, updateProgress, doneJob, failJob, cancelJob } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const distPath = path.join(__dirname, '..', 'dist');
const dbPath = process.env.ROM_DB || path.join(__dirname, '..', '..', '..', 'data', 'roms.db');
let dbReady = initDb(dbPath);

function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'');
}

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

app.use(cors());
app.use(express.json({ limit: '100mb' }));

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
// Platforms (reference list)
// =============================================================================
const KNOWN_PLATFORMS = [
  'Arcade', 'Multi', 'NES', 'SNES', 'Nintendo 64', 'Game Boy', 'Game Boy Color',
  'Game Boy Advance', 'Nintendo DS', 'Nintendo 3DS', 'Sega Genesis', 'Sega Saturn',
  'Sega Dreamcast', 'PlayStation', 'PlayStation 2', 'PlayStation Portable',
  'MSX', 'Commodore 64', 'Amiga', 'Atari 2600', 'Atari 7800', 'TurboGrafx-16',
  'Neo Geo', 'Neo Geo Pocket', 'WonderSwan',
];

app.get('/api/platforms', async (req, res) => { await dbReady; res.json(KNOWN_PLATFORMS); });

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
        const ph = vids.map(() => '?').join(',');
        total = get(`SELECT COUNT(*) as c FROM game_entries WHERE version_id IN (${ph})`, vids).c;
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
    let finalSlug = slug;
    let counter = 1;
    while (get('SELECT id FROM collections WHERE slug = ?', [finalSlug])) {
      finalSlug = `${slug}-${counter++}`;
    }
    run('INSERT INTO collections (name, slug, platform, logo, folder, has_dataset, dataset_preset) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, finalSlug, platform || null, logo || '', folder || slug, has_dataset ? 1 : 0, dataset_preset || null]);
    const col = get('SELECT * FROM collections WHERE slug = ?', [finalSlug]);
    if (uploaded_version_id) {
      run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [col.id, uploaded_version_id]);
    }
    res.status(201).json(col);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, platform, logo, folder } = req.body;
    const sets = []; const vals = [];
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
    run('DELETE FROM collection_builds WHERE collection_id = ?', [req.params.id]);
    run('DELETE FROM collection_versions WHERE collection_id = ?', [req.params.id]);
    run('DELETE FROM collections WHERE id = ?', [req.params.id]);
    // Clean up orphaned versions no longer referenced by any collection
    const orphaned = all(`
      SELECT sv.id FROM set_versions sv
      WHERE NOT EXISTS (SELECT 1 FROM collection_versions cv WHERE cv.version_id = sv.id)
    `);
    for (const v of orphaned) {
      run('DELETE FROM rom_entries WHERE game_entry_id IN (SELECT id FROM game_entries WHERE version_id = ?)', [v.id]);
      run('DELETE FROM scanned_games WHERE version_id = ?', [v.id]);
      run('DELETE FROM game_entries WHERE version_id = ?', [v.id]);
      run('DELETE FROM set_versions WHERE id = ?', [v.id]);
    }
    res.json({ ok: true, orphaned_versions: orphaned.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collections/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, parents_only } = req.query;
    const collection = get('SELECT * FROM collections WHERE id = ?', [id]);
    if (!collection) return res.status(404).json({ error: 'not found' });

    const versions = all('SELECT version_id FROM collection_versions WHERE collection_id = ?', [id]);
    if (!versions.length) return res.json({ collection, games: [], platforms: [], total: 0 });

    const vids = versions.map(v => v.version_id);
    const ph = vids.map(() => '?').join(',');
    const sortCol = sort === 'rating' ? 'MAX(COALESCE(r.rating, 0))' : sort === 'favourite' ? 'MAX(COALESCE(r.favourite, 0))' : sort === 'play_count' ? 'MAX(COALESCE(r.play_count, 0))' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    let whereExtra = '';
    let extraParams = [];
    if (q) {
      whereExtra += 'AND (g.name LIKE ? OR g.description LIKE ?)';
      extraParams.push(`%${q}%`, `%${q}%`);
    }
    if (parents_only === 'true') {
      whereExtra += ' AND g.cloneof IS NULL';
    }

    const total = get(`SELECT COUNT(DISTINCT g.name) as c FROM game_entries g WHERE g.version_id IN (${ph}) ${whereExtra}`, [...vids, ...extraParams]).c;

    let games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, g.cloneof, g.platform,
        MIN(g.id) as id, MIN(g.version_id) as version_id, MIN(sv.source) as source, MIN(sv.version) as version,
        GROUP_CONCAT(sv.source || '||' || sv.version, '||') as versions_tags,
        MAX(COALESCE(r.rating, 0)) as rating,
        MAX(COALESCE(r.favourite, 0)) as favourite,
        MAX(COALESCE(r.play_count, 0)) as play_count
      FROM game_entries g
      JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN game_ratings r ON r.game_entry_id = g.id
      WHERE g.version_id IN (${ph}) ${whereExtra}
      GROUP BY g.name
      ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?
    `, [...vids, ...extraParams, Number(limit), Number(offset)]);

    games = games.map(g => {
      const tags = g.versions_tags ? g.versions_tags.split('||') : [];
      const versions = [];
      for (let i = 0; i < tags.length; i += 2) versions.push(tags[i + 1]);
      delete g.versions_tags;
      return { ...g, versions };
    });

    const platforms = all(`SELECT DISTINCT sv.source as platform FROM set_versions sv WHERE sv.id IN (${ph})`, vids).map(p => p.platform);

    res.json({ collection, games, platforms, total, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const { version_id } = req.body;
    if (!version_id) return res.status(400).json({ error: 'version_id required' });
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

// --- Long-running collection operations (scan / verify) ---

app.post('/api/collections/:id/scan', async (req, res) => {
  await dbReady;
  try {
    const { version_id, dir } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    // Fire-and-forget CLI; return jobId immediately
    setTimeout(() => {
      try {
        const result = execCli(['scan', String(version_id), dir]);
        doneJob(jobId, result);
      } catch (e) {
        failJob(jobId, e.message);
      }
    }, 0);
    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/verify', async (req, res) => {
  await dbReady;
  try {
    const { version_id, dir, fallback_id } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    setTimeout(() => {
      try {
        const args = ['verify', String(version_id), dir];
        if (fallback_id) args.push('--fallback', String(fallback_id));
        const result = execCli(args);
        doneJob(jobId, result);
      } catch (e) {
        failJob(jobId, e.message);
      }
    }, 0);
    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Collection Build (with version fallback) ---

app.post('/api/collections/:id/build', async (req, res) => {
  await dbReady;
  try {
    const { version_id, import_dir } = req.body;
    if (!version_id || !import_dir) return res.status(400).json({ error: 'version_id and import_dir required' });

    const col = get('SELECT id, slug, folder FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const sv = get('SELECT source, version FROM set_versions WHERE id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });

    const collectionDir = path.join(__dirname, '..', '..', '..', 'data', 'roms', col.folder || col.slug);
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        // Run build-cli build with collection-dir
        const args = ['build', sv.source, import_dir, '--base-dir', collectionDir, '--collection-dir', collectionDir, '--progress'];
        execCliStream(args, {
          binary: 'build',
          onProgress: (p) => updateProgress(jobId, p.pct || 0, p.msg || ''),
          signal: job._abort.signal,
        }).then(result => {
          doneJob(jobId, result);
        }).catch(err => {
          failJob(jobId, err.message);
        });
      } catch (e) {
        if (job._abort.signal.aborted) return;
        failJob(jobId, e.message);
      }
    }, 0);

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Builds ---

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

app.post('/api/collections/:id/builds', async (req, res) => {
  await dbReady;
  try {
    const { version_id, format = 'split' } = req.body;
    const colId = req.params.id;
    const version = get('SELECT * FROM set_versions WHERE id = ?', [version_id]);
    if (!version) return res.status(400).json({ error: 'Version not found' });
    const link = get('SELECT 1 FROM collection_versions WHERE collection_id = ? AND version_id = ?', [colId, version_id]);
    if (!link) return res.status(400).json({ error: 'Version not linked to this collection' });

    const existingBuilds = all('SELECT * FROM collection_builds WHERE collection_id = ? ORDER BY id', [colId]);
    const completedBuilds = existingBuilds.filter(b => b.status === 'complete');
    if (completedBuilds.length > 0) {
      const lastBuildVersion = get('SELECT version FROM set_versions WHERE id = ?', [completedBuilds[completedBuilds.length - 1].version_id]);
      if (lastBuildVersion) {
        const parseVer = (s) => { const m = s.trim().match(/^(\d+)\.(\d+)(?:b(\d+))?$/i); return m ? [parseInt(m[1]), parseInt(m[2]), m[3] ? parseInt(m[3]) : 0] : [0,0,0]; };
        const lastParsed = parseVer(lastBuildVersion.version);
        const targetParsed = parseVer(version.version);
        const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
        if (lastParsed[0] > 0 && targetParsed[0] > 0 && cmp(targetParsed, lastParsed) < 0) {
          return res.status(400).json({ error: `Cannot build version ${version.version}: already built ${lastBuildVersion.version}. Only forward builds allowed.` });
        }
      }
    }
    const incomplete = existingBuilds.find(b => b.status === 'building' || b.status === 'not_started');
    if (incomplete) {
      const incVersion = get('SELECT version FROM set_versions WHERE id = ?', [incomplete.version_id]);
      return res.status(400).json({ error: `Cannot start new build: version ${incVersion?.version || 'unknown'} is currently '${incomplete.status}'. Complete it first.` });
    }

    const total = get('SELECT COUNT(*) as c FROM game_entries WHERE version_id = ?', [version_id]).c;
    const existing = get('SELECT id FROM collection_builds WHERE collection_id = ? AND version_id = ?', [colId, version_id]);
    if (existing) {
      run("UPDATE collection_builds SET status = 'building', format = ?, games_total = ?, started_at = datetime('now') WHERE id = ?", [format, total, existing.id]);
    } else {
      run("INSERT INTO collection_builds (collection_id, version_id, status, format, games_total, started_at) VALUES (?, ?, 'building', ?, ?, datetime('now'))", [colId, version_id, format, total]);
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
      run("UPDATE collection_builds SET status = ?, games_built = COALESCE(?, games_total), completed_at = datetime('now') WHERE id = ? AND collection_id = ?", [status, games_built ?? null, req.params.buildId, req.params.id]);
    } else {
      const sets = ["status = ?"]; const vals = [status];
      if (games_built != null) { sets.push("games_built = ?"); vals.push(games_built); }
      vals.push(req.params.buildId, req.params.id);
      run(`UPDATE collection_builds SET ${sets.join(', ')} WHERE id = ? AND collection_id = ?`, vals);
    }
    res.json(get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.id = ?', [req.params.buildId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/builds/:buildId/run', async (req, res) => {
  await dbReady;
  try {
    const { source, import_dir, base_dir, update } = req.body;
    if (!source || !import_dir) {
      return res.status(400).json({ error: 'source and import_dir are required' });
    }
    const buildId = req.params.buildId;
    const build = get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.id = ? AND cb.collection_id = ?', [buildId, req.params.id]);
    if (!build) return res.status(404).json({ error: 'Build not found' });

    run("UPDATE collection_builds SET status = 'building' WHERE id = ?", [buildId]);

    const jobId = buildId;
    const job = createJob(jobId);

    const abort = new AbortController();
    job._abort = abort; // store for cancellation

    const args = ['build', source, import_dir];
    if (base_dir) args.push('--base-dir', base_dir);
    if (update) args.push('--update');

    execCliStream(args, {
      binary: 'build',
      onProgress: (progress) => {
        updateProgress(jobId, progress.pct, `${progress.phase}: ${progress.msg} (${progress.matched}/${progress.total})`);
      },
      signal: abort.signal,
    }).then((result) => {
      run("UPDATE collection_builds SET status = 'complete', games_built = ?, games_missing = ?, completed_at = datetime('now') WHERE id = ?",
        [result.matched || 0, result.missing || 0, buildId]);
      doneJob(jobId, result);
    }).catch((err) => {
      const msg = err.message || String(err);
      if (msg.includes('cancelled') || msg.includes('Build cancelled')) {
        run("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [buildId]);
        failJob(jobId, 'Build cancelled');
      } else {
        run("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [buildId]);
        failJob(jobId, `Build failed: ${msg}`);
      }
    });

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections/:id/exports', async (req, res) => {
  await dbReady;
  try {
    const { format = 'split', version_id } = req.body;
    const colId = req.params.id;
    const collection = get('SELECT * FROM collections WHERE id = ?', [colId]);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    let targetVersionId = version_id;
    if (!targetVersionId) {
      const builds = all('SELECT version_id FROM collection_builds WHERE collection_id = ? AND status = ? ORDER BY completed_at DESC', [colId, 'complete']);
      if (builds.length === 0) return res.status(400).json({ error: 'No completed builds to export' });
      targetVersionId = builds[0].version_id;
    }
    const version = get('SELECT * FROM set_versions WHERE id = ?', [targetVersionId]);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const games = all(`
      SELECT g.*, r.filename as rom_filename, r.size, r.crc32, r.md5, r.sha1, r.status as rom_status, r.merge_target
      FROM game_entries g
      LEFT JOIN rom_entries r ON r.game_entry_id = g.id
      WHERE g.version_id = ?
      ORDER BY g.name
    `, [targetVersionId]);

    const gameMap = {};
    for (const row of games) {
      if (!gameMap[row.id]) {
        gameMap[row.id] = {
          name: row.name, description: row.description, year: row.year,
          manufacturer: row.manufacturer, cloneof: row.cloneof, roms: [],
        };
      }
      if (row.rom_filename) {
        gameMap[row.id].roms.push({
          filename: row.rom_filename, size: row.size, crc32: row.crc32,
          md5: row.md5, sha1: row.sha1, status: row.rom_status, merge_target: row.merge_target,
        });
      }
    }
    res.json({
      collection: collection.name, version: version.version, format,
      total_games: Object.keys(gameMap).length, total_roms: games.filter(g => g.rom_filename).length,
      games: Object.values(gameMap),
    });
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
    run('INSERT INTO game_sets (name, description, icon, platforms) VALUES (?, ?, ?, ?)', [name, description || '', icon || '', platforms || '']);
    res.status(201).json(get('SELECT * FROM game_sets WHERE name = ? ORDER BY id DESC', [name]));
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
    saveDb();
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

app.get('/api/game-sets/:id/exports', async (req, res) => {
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
// Games (global browse / search)
// =============================================================================
app.get('/api/games', async (req, res) => {
  await dbReady;
  try {
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, collection_id, version_id, parents_only } = req.query;
    const sortCol = sort === 'rating' ? 'COALESCE(r.rating, 0)' : sort === 'favourite' ? 'COALESCE(r.favourite, 0)' : sort === 'play_count' ? 'COALESCE(r.play_count, 0)' : 'g.name';
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

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countSql = `SELECT COUNT(DISTINCT g.name) as c FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id ${whereClause}`;
    const total = params.length ? get(countSql, params).c : get(countSql).c;

    const sortCol2 = sort === 'rating' ? 'MAX(COALESCE(r.rating, 0))' : sort === 'favourite' ? 'MAX(COALESCE(r.favourite, 0))' : sort === 'play_count' ? 'MAX(COALESCE(r.play_count, 0))' : 'g.name';
    const pageParams = params.slice();
    pageParams.push(Number(limit), Number(offset));
    let games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, g.cloneof, g.platform,
        MIN(g.id) as id, MIN(g.version_id) as version_id, MIN(sv.source) as source, MIN(sv.version) as version,
        GROUP_CONCAT(sv.source || '||' || sv.version, '||') as versions_tags,
        MAX(COALESCE(r.rating, 0)) as rating,
        MAX(COALESCE(r.favourite, 0)) as favourite,
        MAX(COALESCE(r.play_count, 0)) as play_count
      FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id
      LEFT JOIN game_ratings r ON r.game_entry_id = g.id
      ${whereClause} GROUP BY g.name ORDER BY ${sortCol2} ${sortDir} LIMIT ? OFFSET ?
    `, pageParams);
    games = games.map(g => {
      const tags = g.versions_tags ? g.versions_tags.split('||') : [];
      const versions = [];
      for (let i = 0; i < tags.length; i += 2) versions.push(tags[i + 1]);
      delete g.versions_tags;
      return { ...g, versions };
    });
    res.json({ games, total, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'not found' });
    // Parse JSON columns
    if (typeof game.covers === 'string') try { game.covers = JSON.parse(game.covers); } catch { game.covers = []; }
    if (typeof game.screenshots === 'string') try { game.screenshots = JSON.parse(game.screenshots); } catch { game.screenshots = []; }
    if (typeof game.synopsis === 'string') try { game.synopsis = JSON.parse(game.synopsis); } catch {} // already a string, no-op
    const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
    const scanned = all('SELECT * FROM scanned_games WHERE name = ? AND version_id = ?', [game.name, game.version_id]);
    const rating = get('SELECT * FROM game_ratings WHERE game_entry_id = ?', [game.id]);
    // Find clone variants (games where cloneof = this game's name, in the same version)
    const clones = all('SELECT id, name, description, cloneof FROM game_entries WHERE cloneof = ? AND version_id = ? ORDER BY name', [game.name, game.version_id]);
    res.json({ ...game, roms, scanned_games: scanned, rating, clones });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/games/:id/scrape', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT * FROM game_entries WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    function trySearch(query, platform) {
      const args = ['search', query];
      if (platform) args.push('--platform', platform);
      const r = execCli(args, { binary: 'scraper' });
      if (r?.results?.length) return r;
      return null;
    }

    // Build search candidates in priority order
    const candidates = [];

    // 1. Description with region/set suffixes stripped (e.g., "2010: The Graphic Action Game (USA)" → "2010: The Graphic Action Game")
    if (game.description) {
      const stripped = game.description.replace(/\s*\([^)]*\)\s*/g, '').trim();
      if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
      // Also try the raw description
      if (!candidates.includes(game.description)) candidates.push(game.description);
    }

    // 2. ROM name with spaces at word boundaries
    if (game.name) {
      const spaced = game.name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
      if (spaced !== game.name && !candidates.includes(spaced)) candidates.push(spaced);
    }

    // 3. ROM name with known variant suffix stripped (e.g., "8eyesj" → "8eyes")
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

    // 4. Raw ROM name as last resort
    if (game.name && !candidates.includes(game.name)) candidates.push(game.name);

    // Try searches, preferring arcade-matching results
    let searchResult = null;
    for (const q of candidates) {
      const r = trySearch(q, game.platform);
      if (!r) continue;
      // Prefer results whose platform contains 'arcade' when game is arcade
      if (game.platform === 'arcade' || !game.platform) {
        const arcadeMatch = r.results.find(x => x.platform?.toLowerCase().includes('arcade'));
        if (arcadeMatch) {
          searchResult = { results: [arcadeMatch] };
          break;
        }
      }
      searchResult = r;
      break;
    }

    if (!searchResult) {
      return res.json({ scraped: false, error: 'No matches found in any provider' });
    }

    const first = searchResult.results[0];
    let detailResult;
    try {
      detailResult = execCli(['detail', first.id], { binary: 'scraper' });
    } catch {
      return res.json({ scraped: false, error: 'Failed to get game details' });
    }
    if (!detailResult || detailResult.error) {
      return res.json({ scraped: false, error: 'Detail fetch failed' });
    }

    const synopsis = detailResult.synopsis || '';
    const rawDate = (detailResult.release_date || '').trim();
    const year = (rawDate && !rawDate.startsWith('1970')) ? rawDate.substring(0, 4) : null;
    const manufacturer = detailResult.publisher || detailResult.developer || null;

    // Upgrade IGDB thumbnail sizes to larger resolutions
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
      if (year) { updates.push('year = ?'); upParams.push(year); }
      if (manufacturer) { updates.push('manufacturer = ?'); upParams.push(manufacturer); }
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
      saveDb();
    }

    const updated = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [game.id]);
    // Parse JSON columns before returning (sql.js returns TEXT)
    if (typeof updated.covers === 'string') try { updated.covers = JSON.parse(updated.covers); } catch { updated.covers = []; }
    if (typeof updated.screenshots === 'string') try { updated.screenshots = JSON.parse(updated.screenshots); } catch { updated.screenshots = []; }
    const hadData = synopsis || year || manufacturer || detailResult.covers?.length || detailResult.screenshots?.length;
    res.json({ scraped: true, saved: !!hadData, title: first.title, game: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Migration: fill empty descriptions for a version by re-downloading its DAT files
app.post('/api/versions/:id/fill-descriptions', async (req, res) => {
  await dbReady;
  try {
    const sv = get('SELECT * FROM set_versions WHERE id = ?', [req.params.id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });

    // Map source labels back to repo info
    const SOURCE_REPOS = {
      FBNeo: 'libretro/FBNeo',
      FBAlpha43: 'barbudreadmon/fbalpha-backup-dontuse-ty',
      FBAlpha44: 'libretro/fbalpha',
    };
    const repo = SOURCE_REPOS[sv.source];
    if (!repo) return res.json({ updated: 0, error: `Source ${sv.source} not supported for re-import` });

    // For nightly, use master ref; else use the version tag
    const ref = (sv.source === 'FBNeo' && sv.version === 'nightly') ? 'master' : sv.version;
    const contentsResp = await fetch(`https://api.github.com/repos/${repo}/contents/dats?ref=${ref}`);
    if (!contentsResp.ok) throw new Error(`GitHub API HTTP ${contentsResp.status}`);
    const contents = await contentsResp.json();
    if (!Array.isArray(contents)) throw new Error('Invalid response');

    let datFiles = contents.filter(f => f.name.endsWith('.dat') && f.download_url);
    if (sv.source === 'FBAlpha43') {
      const combined = datFiles.find(f => f.name.includes('0.2.97.43') && !f.name.includes('only'));
      if (combined) datFiles = [combined];
    }

    // Build name → {desc, cloneof} map from DATs
    const datMap = new Map();
    for (const df of datFiles) {
      const dlResp = await fetch(df.download_url);
      if (!dlResp.ok) continue;
      const text = await dlResp.text();
      if (text.length < 10) continue;

      if (text.trim().startsWith('<')) {
        const blockRegex = /<game\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/game>/gi;
        let m;
        while ((m = blockRegex.exec(text)) !== null) {
          if (datMap.has(m[1])) continue;
          const descMatch = m[2].match(/<description>([^<]*)<\/description>/);
          const cloneMatch = m[0].match(/cloneof\s*=\s*"([^"]+)"/);
          datMap.set(m[1], {
            desc: descMatch ? unescapeXml(descMatch[1].trim()) : '',
            cloneof: cloneMatch ? cloneMatch[1] : null
          });
        }
      } else {
        let idx = 0;
        while (idx < text.length) {
          const gs = text.indexOf('game (', idx);
          if (gs === -1) break;
          let depth = 1;
          let end = gs + 6;
          while (end < text.length && depth > 0) {
            if (text[end] === '(') depth++;
            else if (text[end] === ')') depth--;
            end++;
          }
          const block = text.slice(gs, end);
          const nameMatch = block.match(/\bname\s+([^\s")]+)/);
          if (nameMatch && !datMap.has(nameMatch[1])) {
            const descMatch = block.match(/description\s+"([^"]+)"/);
            const cloneMatch = block.match(/\bcloneof\s+([^\s")]+)/);
            datMap.set(nameMatch[1], {
              desc: descMatch ? unescapeXml(descMatch[1].trim()) : '',
              cloneof: cloneMatch ? cloneMatch[1] : null
            });
          }
          idx = end;
        }
      }
    }

    // Update game_entries — descriptions + cloneof
    const games = all('SELECT id, name, description, cloneof FROM game_entries WHERE version_id = ? AND (description IS NULL OR description = "" OR length(description) > 80 OR cloneof IS NULL OR cloneof = "")', [sv.id]);
    let updated = 0;
    let synopsisMoved = 0;
    let cloneofFilled = 0;
    for (const g of games) {
      const entry = datMap.get(g.name);
      if (!entry) continue;
      const desc = entry.desc;
      const co = entry.cloneof;
      const updates = [];
      const upParams = [];
      if (desc && (g.description !== desc)) {
        // If current description was a scraped synopsis (long), move it to synopsis column
        if (g.description && g.description.length > 80 && g.description !== desc) {
          updates.push('description = ?', 'synopsis = ?');
          upParams.push(desc, g.description);
          synopsisMoved++;
        } else {
          updates.push('description = ?');
          upParams.push(desc);
        }
      }
      if (co && (!g.cloneof || g.cloneof !== co)) {
        updates.push('cloneof = ?');
        upParams.push(co);
        cloneofFilled++;
      }
      if (updates.length > 0) {
        upParams.push(g.id);
        run(`UPDATE game_entries SET ${updates.join(', ')} WHERE id = ?`, upParams);
        updated++;
      }
    }
    saveDb();

    res.json({ ok: true, total: games.length, updated, synopsis_moved: synopsisMoved, cloneof_filled: cloneofFilled });
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

app.get('/api/games/:id/cover', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT id, name, covers FROM game_entries WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).end();

    // If we have a saved cover, proxy it (avoids CORS/redirect issues)
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

    // Fallback: placeholder SVG
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

// --- Available DAT versions from progettosnaps / GitHub ---

const MAME_DATS_URL = 'https://www.progettosnaps.net/dats/MAME/';
let mameDatsCache = null;
let mameDatsCacheTime = 0;
const CACHE_TTL = 600_000;

const FBNEO_REPO = 'libretro/FBNeo';
const FBALPHA43_REPO = 'barbudreadmon/fbalpha-backup-dontuse-ty';
const FBALPHA44_REPO = 'libretro/fbalpha';
let fbneoDatsCache = null;
let fbneoDatsCacheTime = 0;

function parseMameVersion(str) {
  const m = str.trim().match(/^(\d+)\.(\d+)(?:b(\d+))?$/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]), parseInt(m[2]), m[3] ? parseInt(m[3]) : 0];
}
function fmtVersion(v) { return v[2] > 0 ? `${v[0]}.${v[1]}b${v[2]}` : `${v[0]}.${v[1]}`; }
function cmpVersion(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

async function getFBNeoVersions() {
  if (fbneoDatsCache && Date.now() - fbneoDatsCacheTime < CACHE_TTL) return fbneoDatsCache;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`https://api.github.com/repos/${FBNEO_REPO}/tags?per_page=100`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
    const tags = await resp.json();
    if (!Array.isArray(tags)) throw new Error('Invalid response from GitHub tags API');

    const versions = tags.map(t => t.name);
    // hardcoded FB Alpha versions — common on slower retro consoles
    const fbalphaVersions = [
      { version: '0.2.97.43', source: 'FBAlpha43', repo: FBALPHA43_REPO },
      { version: '0.2.97.44', source: 'FBAlpha44', repo: FBALPHA44_REPO },
    ];

    const imported = all("SELECT id, source, version FROM set_versions WHERE source IN ('FBNeo','FBAlpha43','FBAlpha44') ORDER BY version");
    const importedSet = new Set(imported.map(v => `${v.source}:${v.version}`));

    // Ascending order: oldest first, nightly at the end
    const allVersions = [
      ...fbalphaVersions,
      ...versions.slice().reverse().map(v => ({ version: v, source: 'FBNeo', repo: FBNEO_REPO, ref: v })),
      { version: 'nightly', source: 'FBNeo', repo: FBNEO_REPO, ref: 'master', nightly: true },
    ];

    const missing = allVersions.filter(v => !importedSet.has(`${v.source}:${v.version}`));
    const result = {
      source: 'FBNeo',
      latest: 'nightly',
      hasNewer: missing.some(v => v.nightly || !importedSet.has(`FBNeo:${v.version}`)),
      available: allVersions,
      imported,
      missing,
    };

    fbneoDatsCache = result;
    fbneoDatsCacheTime = Date.now();
    return result;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

app.get('/api/versions/available', async (req, res) => {
  await dbReady;
  try {
    const source = (req.query.source || 'MAME').toUpperCase();

    if (source === 'FBNEO') {
      const fbneo = await getFBNeoVersions();
      return res.json(fbneo);
    }
    if (source === 'FBALPHA43' || source === 'FBALPHA44') {
      const is43 = source === 'FBALPHA43';
      const src = is43 ? 'FBAlpha43' : 'FBAlpha44';
      const repo = is43 ? FBALPHA43_REPO : FBALPHA44_REPO;
      const ver = is43 ? '0.2.97.43' : '0.2.97.44';
      const imported = all("SELECT id, source, version FROM set_versions WHERE source = ? ORDER BY version", [src]);
      return res.json({
        source: src,
        latest: ver,
        hasNewer: false,
        available: [{ version: ver, source: src, repo }],
        imported,
        missing: imported.length === 0 ? [{ version: ver, source: src, repo }] : [],
      });
    }

    // Default: MAME
    if (mameDatsCache && Date.now() - mameDatsCacheTime < CACHE_TTL) return res.json(mameDatsCache);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let html;
    try {
      const response = await fetch(MAME_DATS_URL, { signal: controller.signal });
      html = await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
    const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const latestMatch = plainText.match(/Latest\s+dat\s+a\s*vailable:\s*([\d.\sb]+)/i);
    const latestVer = latestMatch ? parseMameVersion(latestMatch[1].replace(/\s+/g, '')) : null;

    const rows = [];
    const rowRegex = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const cells = [];
      const cellRegex = /<TD[^>]*>[\s\S]*?<\/TD>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      }
      if (cells.length >= 3) {
        const rawVer = cells[0].replace(/[()]/g, '').trim();
        const ver = rawVer.split(/\s+/)[0];
        const parsed = parseMameVersion(ver);
        if (parsed[0] > 0 || parsed[1] > 0) {
          const allLinks = [...rowMatch[1].matchAll(/<a[^>]+href="([^"]+)"/gi)];
          const url = allLinks.length > 0 ? allLinks[0][1].replace(/&amp;/g, '&') : null;
          rows.push({ version: rawVer, parsed, date: cells[1] || '', hasDat: cells[2] !== '-' && cells[2] !== '', year: cells[1].match(/(\d{4})/)?.[1] || '', url });
        }
      }
    }

    const imported = all('SELECT id, source, version FROM set_versions WHERE source = ? ORDER BY version', ['MAME']);
    const importedParsed = imported.map(v => ({ id: v.id, version: v.version, parsed: parseMameVersion(v.version) }));
    const availableDats = rows.filter(r => r.hasDat && !importedParsed.some(iv => cmpVersion(iv.parsed, r.parsed) === 0));
    const hasNewer = latestVer ? !importedParsed.some(iv => cmpVersion(iv.parsed, latestVer) === 0) : false;

    const _urls = {};
    for (const r of rows) {
      if (r.url) _urls[fmtVersion(r.parsed)] = r.url;
    }
    const result = {
      source: 'MAME',
      latest: latestVer ? fmtVersion(latestVer) : null, latestParsed: latestVer,
      available: rows.filter(r => r.hasDat).map(r => ({ version: r.version, numeric: fmtVersion(r.parsed), date: r.date, year: r.year, parsed: r.parsed, url: r.url })),
      imported: importedParsed,
      missing: availableDats.map(r => ({ version: r.version, numeric: fmtVersion(r.parsed), date: r.date, parsed: r.parsed, url: r.url })),
      hasNewer,
      _urls,
    };

    mameDatsCache = result;
    mameDatsCacheTime = Date.now();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/versions/import-online', async (req, res) => {
  await dbReady;
  try {
    const { collection_id, version, source: reqSource, refresh } = req.body;
    if (!collection_id || !version) return res.status(400).json({ error: 'collection_id and version required' });

    const source = reqSource || 'MAME';

    // --- Non-MAME: FBNeo / FBAlpha ---
    if (source !== 'MAME') {
      let repo, ref, srcLabel;
      if (source === 'FBNeo') {
        repo = FBNEO_REPO;
        ref = version === 'nightly' ? 'master' : version;
        srcLabel = 'FBNeo';
      } else if (source === 'FBAlpha43') {
        repo = FBALPHA43_REPO;
        ref = 'master';
        srcLabel = 'FBAlpha43';
      } else if (source === 'FBAlpha44') {
        repo = FBALPHA44_REPO;
        ref = 'master';
        srcLabel = 'FBAlpha44';
      } else {
        throw new Error(`Unknown source: ${source}`);
      }

      // Fetch list of DAT files in the dats/ folder from GitHub API
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const contentsResp = await fetch(`https://api.github.com/repos/${repo}/contents/dats?ref=${ref}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!contentsResp.ok) throw new Error(`GitHub API HTTP ${contentsResp.status}`);
      const contents = await contentsResp.json();
      if (!Array.isArray(contents)) throw new Error('Invalid response from GitHub contents API');

      let datFiles = contents.filter(f => f.name.endsWith('.dat') && f.download_url);

      // For FBAlpha43, prefer the combined DAT over individual system DATs
      if (source === 'FBAlpha43') {
        const combined = datFiles.find(f => f.name.includes('0.2.97.43') && !f.name.includes('only'));
        if (combined) datFiles = [combined];
      }

      if (datFiles.length === 0) throw new Error('No DAT files found in the dats/ folder');

      // Download each DAT to temp and import via parse-cli (handles games + ROM entries)
      // Map DAT filename patterns to platform folder names
      const PLATFORM_MAP = [
        { match: /arcade/i, folder: 'arcade' }, { match: /neogeo only/i, folder: 'neogeo' },
        { match: /neogeo pocket/i, folder: 'ngp' }, { match: /nes games/i, folder: 'nes' },
        { match: /fds games/i, folder: 'fds' }, { match: /snes games/i, folder: 'snes' },
        { match: /megadrive|mega.?drive/i, folder: 'megadriv' }, { match: /master system/i, folder: 'sms' },
        { match: /game gear/i, folder: 'gamegear' }, { match: /pc-?engine/i, folder: 'pce' },
        { match: /turbografx.?16/i, folder: 'tg16' }, { match: /suprgrafx/i, folder: 'sgx' },
        { match: /colecovision/i, folder: 'coleco' }, { match: /msx 1|msx1/i, folder: 'msx' },
        { match: /zx spectrum/i, folder: 'zxspectrum' }, { match: /fairchild channel.?f/i, folder: 'channelf' },
        { match: /sg-?1000/i, folder: 'sg1000' },
      ];
      function platformFromName(filename) {
        for (const p of PLATFORM_MAP) { if (p.match.test(filename)) return p.folder; }
        return 'arcade';
      }

      let totalGames = 0;
      for (const df of datFiles) {
        const dlResp = await fetch(df.download_url);
        if (!dlResp.ok) continue;
        const text = await dlResp.text();
        if (text.length < 10) continue;

        const plat = platformFromName(df.name);
        const tmpFile = path.join('/tmp', `fbneo_import_${Date.now()}_${Math.random().toString(36).slice(2)}.dat`);
        fs.writeFileSync(tmpFile, text, 'utf-8');

        try {
          const result = execCli(['import', tmpFile, srcLabel, version, '--platform', plat], { binary: 'parse' });
          if (result) totalGames += result.games_inserted || 0;
        } catch (e) {
          console.error('parse-cli error for', df.name, e.message);
        } finally {
          fs.unlinkSync(tmpFile);
        }
      }

      // Link to collection
      const row = get('SELECT id FROM set_versions WHERE source = ? AND version = ?', [srcLabel, version]);
      if (row) run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, row.id]);

      fbneoDatsCache = null;
      res.json({ ok: true, version_id: row.id, total_games: totalGames });
      return;
    }

    // --- Original MAME flow ---
    else {
      let url = null;
      if (mameDatsCache && mameDatsCache._urls) {
        url = mameDatsCache._urls[version];
      }
      if (!url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(MAME_DATS_URL, { signal: controller.signal });
        const html = await resp.text();
        clearTimeout(timeoutId);
        const rowRegex = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(html)) !== null) {
          const cells = [];
          const cellRegex = /<TD[^>]*>[\s\S]*?<\/TD>/gi;
          let cellMatch;
          while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
            cells.push(cellMatch[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
          }
          if (cells.length >= 3) {
            const rawVer = cells[0].replace(/[()]/g, '').trim();
            const ver = rawVer.split(/\s+/)[0];
            const parsed = parseMameVersion(ver);
            if (fmtVersion(parsed) === version) {
              const linkMatch = rowMatch[1].match(/<a[^>]+href="([^"]+)"/i);
              if (linkMatch) url = linkMatch[1].replace(/&amp;/g, '&');
              break;
            }
          }
        }
      }
      if (!url) throw new Error(`Could not find download URL for MAME version "${version}"`);

      const ext = url.includes('.rar') ? '.rar' : '.7z';
      const tempFile = path.join('/tmp', `mame_pack_${Date.now()}${ext}`);
      try {
        const dlController = new AbortController();
        const dlTimeout = setTimeout(() => dlController.abort(), 180_000);
        const dlRes = await fetch(url, { signal: dlController.signal });
        clearTimeout(dlTimeout);
        if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
        const buf = Buffer.from(await dlRes.arrayBuffer());
        fs.writeFileSync(tempFile, buf);
      } catch (dlErr) {
        throw new Error(`Failed to download pack: ${dlErr.message}`);
      }

      const extractDir = path.join('/tmp', `mame_extract_${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });
      let text = '';
      try {
        try {
          execSync(`7z e -y -o"${extractDir}" "${tempFile}"`, { encoding: 'utf-8' });
        } catch (_) {
          try {
            execSync(`unrar e -y "${tempFile}" "${extractDir}/"`, { encoding: 'utf-8' });
          } catch (_) {
            throw new Error('Failed to extract pack archive (both 7z and unrar failed)');
          }
        }

        const allFiles = [];
        const walkDir = (dir) => {
          for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            if (fs.statSync(fp).isDirectory()) walkDir(fp);
            else allFiles.push(fp);
          }
        };
        walkDir(extractDir);
        let foundDat = null;

        for (const fp of allFiles) {
          const base = path.basename(fp).toLowerCase();
          if (base.endsWith('.dat') && !/without.?crc|nocrc/i.test(base) && base.includes(version.replace('.', ''))) {
            foundDat = fp; break;
          }
          if (base.endsWith('.xml') && base.includes(version.replace('.', '')) && !foundDat) foundDat = fp;
        }

        if (!foundDat) {
          for (const fp of allFiles) {
            const base = path.basename(fp).toLowerCase();
            if (!base.endsWith('.exe') && !base.endsWith('.7z') && !base.endsWith('.rar')) continue;
            const nestedDir = path.join(extractDir, 'nested_' + path.basename(fp));
            fs.mkdirSync(nestedDir);
            let extracted = false;
            try { execSync(`7z e -y -o"${nestedDir}" "${fp}"`, { encoding: 'utf-8' }); extracted = true; } catch (_) {}
            if (!extracted) try { execSync(`unrar e -y "${fp}" "${nestedDir}/"`, { encoding: 'utf-8' }); extracted = true; } catch (_) {}
            if (!extracted) continue;
            const nestedFiles = [];
            const walkNested = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walkNested(p); else nestedFiles.push(p); } };
            walkNested(nestedDir);
            for (const fp2 of nestedFiles) {
              const b2 = path.basename(fp2).toLowerCase();
              if (b2.endsWith('.dat') && !/without.?crc|nocrc/i.test(b2)) { foundDat = fp2; break; }
              if (b2.endsWith('.xml') && !foundDat) foundDat = fp2;
            }
            if (foundDat) break;
          }
        }

        if (!foundDat) {
          for (const fp of allFiles) {
            const b = path.basename(fp).toLowerCase();
            if (b.endsWith('.dat') && !/without.?crc|nocrc/i.test(b)) { foundDat = fp; break; }
            if (b.endsWith('.xml') && !foundDat) foundDat = fp;
          }
        }

        if (!foundDat) throw new Error(`No DAT/XML file found for version "${version}" in the archive`);

        text = fs.readFileSync(foundDat, 'utf-8');
      } finally {
        try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }

      if (!text || text.length < 10) throw new Error(`Empty or invalid DAT content (size=${text?.length || 0})`);

      // Save to temp and import via parse-cli
      const tmpFile = path.join('/tmp', `mame_import_${Date.now()}_${version.replace(/[^a-zA-Z0-9]/g, '_')}.dat`);
      fs.writeFileSync(tmpFile, text, 'utf-8');
      try {
        execCli(['import', tmpFile, 'MAME', version], { binary: 'parse' });
      } finally {
        fs.unlinkSync(tmpFile);
      }

      let row = get('SELECT id FROM set_versions WHERE source = ? AND version = ?', ['MAME', version]);
      for (const name of gameNames) {
        insert.bind([row.id, name, '']);
        insert.step();
        insert.reset();
      }
      insert.free();
      saveDb();

      run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, row.id]);

      mameDatsCache = null;
      res.json({ ok: true, version_id: row.id });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/versions/import-dat', async (req, res) => {
  await dbReady;
  try {
    let text = '';
    if (typeof req.body === 'string') {
      text = req.body;
    } else if (req.body && typeof req.body === 'object') {
      text = req.body.content || JSON.stringify(req.body);
    } else {
      text = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
    }
    if (!text || text.length < 10) return res.status(400).json({ error: 'Empty or invalid DAT content' });

    let source = 'Custom';
    let version = 'unknown';
    const gameNames = [];

    if (text.trim().startsWith('<')) {
      const gameRegex = /<(?:game|machine)\s+name="([^"]+)"/gi;
      let match;
      while ((match = gameRegex.exec(text)) !== null) gameNames.push(match[1]);
      const verMatch = text.match(/version\s*=\s*["']?([\d.]+)/i);
      if (verMatch) version = verMatch[1];
      if (text.match(/<(?:mame|datafile|clrmamepro)[^>]*>/i)) source = 'DAT';
    } else {
      const gameRegex = /game\s*\([\s\S]*?name\s+([^\s")]+)/gi;
      let match;
      while ((match = gameRegex.exec(text)) !== null) gameNames.push(match[1]);
    }

    if (gameNames.length === 0) return res.status(400).json({ error: 'No games found in DAT file.' });

    const db = getDb();
    db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', [source, version]);
    const idResult = db.exec('SELECT last_insert_rowid() as id');
    const versionId = idResult[0]?.values[0]?.[0];
    if (!versionId) return res.status(500).json({ error: 'Failed to create version' });

    const insert = db.prepare('INSERT INTO game_entries (version_id, name, description) VALUES (?, ?, ?)');
    for (const name of gameNames) {
      insert.bind([versionId, name, '']);
      insert.step();
      insert.reset();
    }
    insert.free();
    saveDb();

    res.json({ ok: true, version_id: versionId, source, version, total_games: gameNames.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Scraper (external metadata) — delegates to scraper-cli
// =============================================================================
app.post('/api/scraper/search', async (req, res) => {
  try {
    const { query, platform } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const args = ['search', query];
    if (platform) args.push('--platform', platform);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scraper/scrape', async (req, res) => {
  try {
    const { file, game_name, platform } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    const args = ['scrape', file];
    if (game_name) args.push('--name', game_name);
    if (platform) args.push('--platform', platform);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scraper/hash', async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    const result = execCli(['hash', file], { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scraper/detail', async (req, res) => {
  try {
    const { game_id, source } = req.body;
    if (!game_id) return res.status(400).json({ error: 'game_id required' });
    const args = ['detail', game_id];
    if (source) args.push('--source', source);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Internet Archive download
// =============================================================================

app.post('/api/collections/:id/download-ia', async (req, res) => {
  await dbReady;
  try {
    const { item, file_pattern, dest_dir } = req.body;
    if (!item || !dest_dir) return res.status(400).json({ error: 'item and dest_dir required' });

    // Resolve IA download URL
    const metaResp = await fetch(`https://archive.org/metadata/${item}`);
    if (!metaResp.ok) return res.status(404).json({ error: `IA item "${item}" not found` });
    const meta = await metaResp.json();
    const files = meta.files || [];
    const target = file_pattern
      ? files.find(f => f.name.includes(file_pattern) && f.size > 0)
      : files.filter(f => f.size > 0 && !f.name.startsWith('__') && !f.name.endsWith('.xml') && !f.name.endsWith('.sqlite') && !f.name.endsWith('.torrent') && !f.name.endsWith('.jpg'))[0];
    if (!target) return res.status(404).json({ error: 'No matching file found in IA item' });

    const dlUrl = `https://archive.org/download/${item}/${target.name}`;
    const totalSize = parseInt(target.size, 10);
    const baseName = target.name.split('/').pop() || target.name;
    const destFile = path.join(dest_dir, baseName);

    // Create job
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        fs.mkdirSync(dest_dir, { recursive: true });

        // Resume partial downloads
        let startByte = 0;
        if (fs.existsSync(destFile)) {
          const stats = fs.statSync(destFile);
          startByte = stats.size;
        }

        const headers = {};
        if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;
        const dlResp = await fetch(dlUrl, { headers, signal: job._abort.signal });
        if (!dlResp.ok && dlResp.status !== 206) throw new Error(`HTTP ${dlResp.status}`);

        const stream = fs.createWriteStream(destFile, { flags: startByte > 0 ? 'a' : 'w' });
        const reader = dlResp.body.getReader();
        let downloaded = startByte;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.write(Buffer.from(value));
          downloaded += value.length;
          const pct = Math.round((downloaded / totalSize) * 100);
          updateProgress(jobId, pct, `Downloading ${baseName} — ${(downloaded / 1024 / 1024).toFixed(1)} / ${(totalSize / 1024 / 1024).toFixed(0)} MB (${pct}%)`);
        }

        await new Promise(resolve => stream.end(resolve));
        updateProgress(jobId, 100, 'Download complete, extracting...');

        // Extract zip
        let extractDir = dest_dir;
        if (baseName.endsWith('.zip')) {
          extractDir = path.join(dest_dir, baseName.replace(/\.zip$/, ''));
          fs.mkdirSync(extractDir, { recursive: true });
          execSync(`unzip -o "${destFile}" -d "${extractDir}"`, { stdio: 'ignore' });
          updateProgress(jobId, 100, `Extracted to ${extractDir}`);
        }

        doneJob(jobId, { dest_dir: extractDir, file_count: files.length });
      } catch (e) {
        if (job._abort.signal.aborted) return cancelJob(jobId);
        failJob(jobId, e.message);
      }
    }, 0);

    res.status(202).json({ jobId, file: target.name, size: totalSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Remote ZIP (Internet Archive) — list + download individual ROMs
// =============================================================================

app.post('/api/ia/list', async (req, res) => {
  try {
    const { url, pattern } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const { RemoteZip } = await import('./remote-zip.js');
    const rz = new RemoteZip(url);
    const files = await rz.listFiles(pattern);
    res.json({ files: files.map(f => ({ name: f.name, size: f.uncompressedSize })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia/download', async (req, res) => {
  await dbReady;
  try {
    const { url, entry, collection_id } = req.body;
    if (!url || !entry) return res.status(400).json({ error: 'url and entry required' });
    const baseDir = path.join(__dirname, '..', '..', '..', 'data', 'roms');
    let dest = path.join(baseDir, entry.replace(/^roms\//, ''));
    console.log('[ia-download] collection_id:', collection_id);
    if (collection_id) {
      const col = get('SELECT id, folder FROM collections WHERE id = ?', [collection_id]);
      console.log('[ia-download] collection query result:', JSON.stringify(col));
      if (col?.folder) dest = path.join(baseDir, col.folder, entry.replace(/^roms\//, ''));
      console.log('[ia-download] resolved dest:', dest);
    }
    const { RemoteZip } = await import('./remote-zip.js');
    const rz = new RemoteZip(url);
    const result = await rz.extractToFile(entry, dest);
    res.json({ ok: true, ...result, path: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Jobs (SSE progress streams)
// =============================================================================
app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status !== 'running') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (job.status === 'done' && job.result) {
      res.write(`data: ${JSON.stringify({ type: 'result', data: job.result })}\n\n`);
    } else if (job.error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: job.error })}\n\n`);
    }
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'progress', pct: job.progress.pct, msg: job.progress.msg })}\n\n`);

  job.subscribers.add(res);
  res.on('close', () => job.subscribers.delete(res));
});

app.post('/api/jobs/:jobId/cancel', (req, res) => {
  const ok = cancelJob(req.params.jobId);
  res.json({ ok });
});

// =============================================================================
// Settings (read/write .env)
// =============================================================================

const SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'data', '.env');
const SETTINGS_KEYS = [
  'SS_DEVID', 'SS_DEVPASSWORD', 'SS_USERNAME', 'SS_PASSWORD',
  'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET',
  'TGDB_API_KEY',
  'SCRAPER_SOURCE',
];

function parseEnv(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (SETTINGS_KEYS.includes(key)) {
      obj[key] = val;
    }
  }
  return obj;
}

function serializeEnv(obj) {
  const lines = [];
  for (const key of SETTINGS_KEYS) {
    if (obj[key] !== undefined && obj[key] !== '') {
      lines.push(`${key}=${obj[key]}`);
    }
  }
  return lines.join('\n') + '\n';
}

function readEnvFile() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return parseEnv(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Error reading .env:', e.message);
  }
  return {};
}

app.get('/api/settings', async (req, res) => {
  try {
    res.json(readEnvFile());
  } catch (e) {
    console.error('GET /api/settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (typeof updates !== 'object' || !updates) {
      return res.status(400).json({ error: 'body must be a JSON object' });
    }
    const current = readEnvFile();
    for (const [key, val] of Object.entries(updates)) {
      if (SETTINGS_KEYS.includes(key)) {
        if (val === null || val === undefined || val === '') {
          delete current[key];
        } else {
          current[key] = String(val);
        }
      }
    }
    fs.writeFileSync(SETTINGS_PATH, serializeEnv(current), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/test-tgdb', async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) {
      return res.status(400).json({ error: 'api_key is required' });
    }
    const testRes = await fetch(`https://api.thegamesdb.net/v1/Platforms?apikey=${api_key}`);
    const data = await testRes.json();
    if (data.code === 200) {
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: data.status || 'Invalid API key' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/test-igdb', async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;
    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'client_id and client_secret are required' });
    }
    const params = new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'client_credentials',
    });
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.json({ ok: false, error: tokenData.message || tokenData.error || 'Authentication failed' });
    }
    const testRes = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': client_id,
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'text/plain',
      },
      body: 'fields name; limit 1;',
    });
    if (!testRes.ok) {
      const text = await testRes.text();
      return res.json({ ok: false, error: `API test failed (HTTP ${testRes.status}): ${text.slice(0, 200)}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// Static files + SPA fallback
// =============================================================================
app.use('/assets', express.static(path.join(distPath, 'assets')));

app.use((req, res) => {
  const filePath = path.join(distPath, 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(200).json({ message: 'ROM Manager API' });
  }
});

// =============================================================================
// Start
// =============================================================================
// Startup cleanup: reset orphaned builds (server crashed/restarted)
dbReady.then(() => {
  const orphans = all("SELECT id FROM collection_builds WHERE status = 'building'");
  if (orphans.length > 0) {
    console.log(`Resetting ${orphans.length} orphaned build(s) to 'failed'`);
    for (const o of orphans) {
      run("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [o.id]);
    }
  }
});

app.listen(PORT, () => {
  console.log(`ROM Manager API running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => { saveDb(); closeDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); closeDb(); process.exit(0); });
