import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { getDb } from '../db.js';
import { execCli, execCliStream } from '../cli.js';
import { createJob, getJob, updateProgress, doneJob, failJob, cancelJob } from '../jobs.js';
import { all, get, run, runNow, unescapeXml, KNOWN_PLATFORMS, dbReady } from '../helpers.js';
import { scanNpsDir, buildNps } from '../nps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.get('/api/status', async (req, res) => {
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

router.get('/api/platforms', async (req, res) => { await dbReady; res.json(KNOWN_PLATFORMS); });

router.get('/api/collections', async (req, res) => {
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

router.post('/api/collections', async (req, res) => {
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

router.put('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, slug, platform, logo, folder } = req.body;
    const col = get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    const oldFolder = col.folder || col.slug || col.name;
    const newFolder = folder || slug || oldFolder;

    const sets = []; const vals = [];
    if (name != null) { sets.push('name = ?'); vals.push(name); }
    if (slug != null) { sets.push('slug = ?'); vals.push(slug); }
    if (platform != null) { sets.push('platform = ?'); vals.push(platform); }
    if (logo != null) { sets.push('logo = ?'); vals.push(logo); }
    if (folder != null) { sets.push('folder = ?'); vals.push(folder); }
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    if (sets.length) run(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, vals);

    // Rename data folder if it changed
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    if (newFolder !== oldFolder) {
      const oldDir = path.join(__dirname, '..', '..', '..', '..', 'data', 'roms', oldFolder);
      const newDir = path.join(__dirname, '..', '..', '..', '..', 'data', 'roms', newFolder);
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
      }
    }

    res.json(get('SELECT * FROM collections WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM collection_builds WHERE collection_id = ?', [req.params.id]);
    run('DELETE FROM collection_versions WHERE collection_id = ?', [req.params.id]);
    run('DELETE FROM collections WHERE id = ?', [req.params.id]);
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

router.get('/api/collections/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, parents_only, favourites_only, roms_only, version_id } = req.query;
    const collection = get('SELECT * FROM collections WHERE id = ?', [id]);
    if (!collection) return res.status(404).json({ error: 'not found' });

    const versions = all('SELECT version_id FROM collection_versions WHERE collection_id = ?', [id]);
    if (!versions.length) return res.json({ collection, games: [], platforms: [], total: 0 });

    const vids = version_id ? [Number(version_id)] : versions.map(v => v.version_id);
    const ph = vids.map(() => '?').join(',');
    const sortCol = sort === 'rating' ? 'MAX(COALESCE(r.rating, 0))' : sort === 'play_count' ? 'MAX(COALESCE(r.play_count, 0))' : 'g.name';
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

    // For roms_only filter, use game_state.available flag
    if (roms_only === 'true') {
      whereExtra += ' AND COALESCE(r.available, 0) = 1';
    }
    // For favourites_only filter, use game_state.favourite flag
    if (favourites_only === 'true') {
      whereExtra += ' AND COALESCE(r.favourite, 0) = 1';
    }

    // Always LEFT JOIN game_state for available/favourite/rating data
    const joinClause = 'LEFT JOIN game_state r ON r.game_entry_id = g.id';

    const total = get(`SELECT COUNT(DISTINCT g.name || '|' || g.region) as c FROM game_entries g ${joinClause} WHERE g.version_id IN (${ph}) ${whereExtra}`, [...vids, ...extraParams]).c;

    let games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, g.cloneof, g.platform, g.region,
        (SELECT GROUP_CONCAT(region, '||') FROM (SELECT DISTINCT region FROM game_entries c WHERE c.cloneof = g.name AND c.version_id = g.version_id)) as clone_regions,
        MIN(g.id) as id, MIN(g.version_id) as version_id, MIN(sv.source) as source, MIN(sv.version) as version,
        GROUP_CONCAT(sv.source || '||' || sv.version, '||') as versions_tags,
        MAX(COALESCE(r.rating, 0)) as rating,
        MAX(COALESCE(r.favourite, 0)) as favourite,
        MAX(COALESCE(r.play_count, 0)) as play_count,
        MAX(CASE WHEN g.covers != '[]' THEN g.covers ELSE NULL END) as covers_json,
        MAX(CASE WHEN g.screenshots != '[]' THEN g.screenshots ELSE NULL END) as screenshots_json
      FROM game_entries g
      JOIN set_versions sv ON sv.id = g.version_id
      ${joinClause}
      WHERE g.version_id IN (${ph}) ${whereExtra}
      GROUP BY g.name, g.region
      ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?
    `, [...vids, ...extraParams, Number(limit), Number(offset)]);

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
      const cloneRegions = g.clone_regions ? g.clone_regions.split('||').filter(Boolean) : [];
      delete g.clone_regions;
      const allRegions = [g.region, ...cloneRegions].filter(Boolean);
      const regions = [...new Set(allRegions)];
      return { ...g, versions, covers, screenshots, regions };
    });

    const platforms = all(`SELECT DISTINCT sv.source as platform FROM set_versions sv WHERE sv.id IN (${ph})`, vids).map(p => p.platform);

    const collectionVersions = all(`
      SELECT sv.id, sv.source, sv.version, sv.created_at,
        (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games
      FROM set_versions sv
      JOIN collection_versions cv ON cv.version_id = sv.id
      WHERE cv.collection_id = ?
      ORDER BY sv.created_at DESC
    `, [id]);

    res.json({ collection, games, platforms, total, versions: collectionVersions, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const versions = all(`
      SELECT sv.*, (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games
      FROM set_versions sv
      JOIN collection_versions cv ON cv.version_id = sv.id
      WHERE cv.collection_id = ?
      ORDER BY sv.created_at DESC
    `, [req.params.id]);
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const { version_id } = req.body;
    if (!version_id) return res.status(400).json({ error: 'version_id required' });
    run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [req.params.id, version_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/collections/:id/versions/:versionId', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM collection_versions WHERE collection_id = ? AND version_id = ?', [req.params.id, req.params.versionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/scan', async (req, res) => {
  await dbReady;
  try {
    const { version_id, dir } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    setTimeout(() => {
      try {
        // Reset available=0 for all games in this version before scan
        try {
          runNow(`
            INSERT INTO game_state (game_entry_id, available, updated_at)
            SELECT ge.id, 0, datetime('now')
            FROM game_entries ge
            WHERE ge.version_id = ?
            ON CONFLICT(game_entry_id) DO UPDATE SET
              available = 0,
              updated_at = datetime('now')
          `, [version_id]);
        } catch (_) {}
        const result = execCli(['scan', String(version_id), dir]);
        // Update game_state.available from scanned_games after scan
        try {
          runNow(`
            INSERT INTO game_state (game_entry_id, available, updated_at)
            SELECT ge.id, CASE WHEN sg.status IN ('ok', 'mismatch') THEN 1 ELSE 0 END, datetime('now')
            FROM game_entries ge
            LEFT JOIN scanned_games sg ON sg.version_id = ge.version_id AND sg.name = ge.name
            WHERE ge.version_id = ?
            ON CONFLICT(game_entry_id) DO UPDATE SET
              available = excluded.available,
              updated_at = datetime('now')
          `, [version_id]);
        } catch (_) {}
        doneJob(jobId, result);
      } catch (e) {
        failJob(jobId, e.message);
      }
    }, 0);
    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/verify', async (req, res) => {
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

router.post('/api/collections/:id/build', async (req, res) => {
  await dbReady;
  try {
    const { version_id, import_dir, scan } = req.body;
    if (!version_id || !import_dir) return res.status(400).json({ error: 'version_id and import_dir required' });

    const col = get('SELECT id, slug, folder FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const sv = get('SELECT source, version FROM set_versions WHERE id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });

    const collectionDir = path.join(__dirname, '..', '..', '..', '..', 'data', 'roms', col.folder || col.slug);
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        const args = ['build', sv.source, import_dir, '--version-id', String(version_id), '--base-dir', collectionDir, '--collection-dir', collectionDir, '--progress'];
        if (scan) args.push('--dry-run');
        execCliStream(args, {
          binary: 'build',
          onProgress: (p) => updateProgress(jobId, p.pct || 0, p.msg || ''),
          signal: job._abort.signal,
        }).then(result => {
          // Scan output dir to set game_state.available for built games
          try {
            const foundGames = new Set();
            function scanDir(dir) {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) scanDir(path.join(dir, entry.name));
                else if (entry.name.endsWith('.zip')) foundGames.add(entry.name.replace('.zip', ''));
              }
            }
            if (fs.existsSync(collectionDir)) scanDir(collectionDir);
            // Reset all games to available=0, then set found ones to available=1
            runNow(`
              INSERT INTO game_state (game_entry_id, available, updated_at)
              SELECT ge.id, 0, datetime('now') FROM game_entries ge WHERE ge.version_id = ?
              ON CONFLICT(game_entry_id) DO UPDATE SET available = 0, updated_at = datetime('now')
            `, [version_id]);
            if (foundGames.size > 0) {
              const names = [...foundGames];
              const ph = names.map(() => '?').join(',');
              runNow(`
                INSERT INTO game_state (game_entry_id, available, updated_at)
                SELECT ge.id, 1, datetime('now') FROM game_entries ge
                WHERE ge.version_id = ? AND ge.name IN (${ph})
                ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')
              `, [version_id, ...names]);
            }
          } catch (_) {}
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

router.get('/api/collections/:id/builds', async (req, res) => {
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

router.post('/api/collections/:id/builds', async (req, res) => {
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
      runNow("UPDATE collection_builds SET status = 'building', format = ?, games_total = ?, started_at = datetime('now') WHERE id = ?", [format, total, existing.id]);
    } else {
      runNow("INSERT INTO collection_builds (collection_id, version_id, status, format, games_total, started_at) VALUES (?, ?, 'building', ?, ?, datetime('now'))", [colId, version_id, format, total]);
    }
    res.json(get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.collection_id = ? AND cb.version_id = ?', [colId, version_id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/collections/:id/builds/:buildId', async (req, res) => {
  await dbReady;
  try {
    const { status, games_built } = req.body;
    const valid = ['not_started', 'building', 'complete', 'failed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status === 'complete') {
      runNow("UPDATE collection_builds SET status = ?, games_built = COALESCE(?, games_total), completed_at = datetime('now') WHERE id = ? AND collection_id = ?", [status, games_built ?? null, req.params.buildId, req.params.id]);
    } else {
      const sets = ["status = ?"]; const vals = [status];
      if (games_built != null) { sets.push("games_built = ?"); vals.push(games_built); }
      vals.push(req.params.buildId, req.params.id);
      runNow(`UPDATE collection_builds SET ${sets.join(', ')} WHERE id = ? AND collection_id = ?`, vals);
    }
    res.json(get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.id = ?', [req.params.buildId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/builds/:buildId/run', async (req, res) => {
  await dbReady;
  try {
    const { source, import_dir, base_dir, update } = req.body;
    if (!source || !import_dir) {
      return res.status(400).json({ error: 'source and import_dir are required' });
    }
    const buildId = req.params.buildId;
    const build = get('SELECT cb.*, sv.version, sv.source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id WHERE cb.id = ? AND cb.collection_id = ?', [buildId, req.params.id]);
    if (!build) return res.status(404).json({ error: 'Build not found' });

    runNow("UPDATE collection_builds SET status = 'building' WHERE id = ?", [buildId]);

    const jobId = buildId;
    const job = createJob(jobId);

    const abort = new AbortController();
    job._abort = abort;

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
      runNow("UPDATE collection_builds SET status = 'complete', games_built = ?, games_missing = ?, completed_at = datetime('now') WHERE id = ?",
        [result.added || 0, result.missing || 0, buildId]);
      // Scan output dir to set game_state.available for built games
      try {
        const buildDir = base_dir || path.join(__dirname, '..', '..', '..', '..', 'data', 'roms', build.source);
        const foundGames = new Set();
        function scanDir(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) scanDir(path.join(dir, entry.name));
            else if (entry.name.endsWith('.zip')) foundGames.add(entry.name.replace('.zip', ''));
          }
        }
        if (fs.existsSync(buildDir)) scanDir(buildDir);
        const versionId = build.version_id;
        runNow(`
          INSERT INTO game_state (game_entry_id, available, updated_at)
          SELECT ge.id, 0, datetime('now') FROM game_entries ge WHERE ge.version_id = ?
          ON CONFLICT(game_entry_id) DO UPDATE SET available = 0, updated_at = datetime('now')
        `, [versionId]);
        if (foundGames.size > 0) {
          const names = [...foundGames];
          const ph = names.map(() => '?').join(',');
          runNow(`
            INSERT INTO game_state (game_entry_id, available, updated_at)
            SELECT ge.id, 1, datetime('now') FROM game_entries ge
            WHERE ge.version_id = ? AND ge.name IN (${ph})
            ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')
          `, [versionId, ...names]);
        }
      } catch (_) {}
      doneJob(jobId, result);
    }).catch((err) => {
      const msg = err.message || String(err);
      if (msg.includes('cancelled') || msg.includes('Build cancelled')) {
        runNow("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [buildId]);
        failJob(jobId, 'Build cancelled');
      } else {
        runNow("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [buildId]);
        failJob(jobId, `Build failed: ${msg}`);
      }
    });

    res.status(202).json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/exports', async (req, res) => {
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

router.post('/api/collections/:id/download-ia', async (req, res) => {
  await dbReady;
  try {
    const { item, file_pattern, dest_dir } = req.body;
    if (!item || !dest_dir) return res.status(400).json({ error: 'item and dest_dir required' });

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

    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        fs.mkdirSync(dest_dir, { recursive: true });

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
// NPS (NoPayStation) scan and build
// =============================================================================

router.post('/api/collections/:id/scan-nps', async (req, res) => {
  await dbReady;
  try {
    const { version_id, dir } = req.body;
    if (!version_id || !dir) return res.status(400).json({ error: 'version_id and dir required' });

    const col = get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    const sv = get('SELECT * FROM set_versions WHERE id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });
    if (sv.source !== 'NPS') return res.status(400).json({ error: 'Version is not an NPS version' });

    const result = scanNpsDir(dir, version_id);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/build-nps', async (req, res) => {
  await dbReady;
  try {
    const { version_id, input_dir } = req.body;
    if (!version_id) return res.status(400).json({ error: 'version_id required' });

    const col = get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });

    const sv = get('SELECT * FROM set_versions WHERE id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });
    if (sv.source !== 'NPS') return res.status(400).json({ error: 'Version is not an NPS version' });

    const collectionDir = path.join(__dirname, '..', '..', '..', '..', 'data', 'roms', col.folder || col.slug);
    fs.mkdirSync(collectionDir, { recursive: true });

    const result = buildNps(collectionDir, version_id, input_dir);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
