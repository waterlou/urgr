import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { getDb, reloadDb } from '../db.js';
import { syncGameAvailability } from '../operations/syncAvailability.js';
import { execCli, execCliStream } from '../cli.js';
import { createJob, getJob, updateProgress, doneJob, failJob, cancelJob } from '../jobs.js';
import { all, get, run, runNow, unescapeXml, KNOWN_PLATFORMS, dbReady } from '../helpers.js';
import { getCookieHeader } from '../ia-auth.js';
import { sortVersions } from '../versionSort.js';

// Shared SQL subquery: counts games available in this version OR inherited from prior versions
const AVAILABLE_GAMES_SQL = `(SELECT COUNT(*) FROM game_rom_sets grs WHERE grs.version_id = sv.id
  AND (grs.available = 1
    OR EXISTS (
      SELECT 1 FROM game_rom_sets grs2
      JOIN set_versions sv2 ON sv2.id = grs2.version_id
      WHERE sv2.collection_id = sv.collection_id
        AND sv2.id < sv.id
        AND grs2.game_id = grs.game_id
        AND grs2.available = 1
    ))
) as available_games`;
import { scanNpsDir, buildNps } from '../nps.js';
import { scrapeSingleGame } from './games.js';
import { romsDir, dataDir } from '../paths.js';

const router = Router();

router.get('/api/status', async (req, res) => {
  await dbReady;
  try {
    const db = getDb();
    const v = db.exec("SELECT COUNT(*) as c FROM set_versions")[0].values[0][0];
    const g = db.exec("SELECT COUNT(*) as c FROM games")[0].values[0][0];
    const r = db.exec("SELECT COUNT(*) as c FROM game_rom_files")[0].values[0][0];
    const c = db.exec("SELECT COUNT(*) as c FROM collections")[0].values[0][0];
    const gs = db.exec("SELECT COUNT(*) as c FROM game_sets")[0].values[0][0];
    const rs = db.exec("SELECT COUNT(*) as c FROM game_rom_sets")[0].values[0][0];
    res.json({ versions: v, games: g, roms: r, collections: c, game_sets: gs, game_rom_sets: rs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/platforms', async (req, res) => { await dbReady; res.json(KNOWN_PLATFORMS); });

router.get('/api/collections', async (req, res) => {
  await dbReady;
  try {
    const rows = all('SELECT c.* FROM collections c ORDER BY c.name');
    const result = rows.map(c => {
      const versions = all(`SELECT sv.id, c.dataset_preset as source, sv.version, sv.dir, sv.created_at,
          (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
          ${AVAILABLE_GAMES_SQL}
        FROM set_versions sv
        JOIN collections c ON c.id = sv.collection_id
        WHERE sv.collection_id = ?
        ORDER BY sv.version DESC`, [c.id]);
      versions.sort((a, b) => sortVersions([a.version, b.version])[0] === a.version ? -1 : 1);
      const vids = versions.map(v => v.id);
      let total = 0;
      let available = 0;
      if (vids.length) {
        const ph = vids.map(() => '?').join(',');
        total = get(`SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id IN (${ph})`, vids).c;
        available = get(`SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id IN (${ph}) AND available = 1`, vids).c;
      }
      return { ...c, total_games: total, available_games: available, versions };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections', async (req, res) => {
  await dbReady;
  try {
    let { name, slug, platform, logo, folder, has_dataset, dataset_preset, scrape_mode, scrape_source_priority, uploaded_version_id } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    let finalSlug = slug;
    let counter = 1;
    while (get('SELECT id FROM collections WHERE slug = ?', [finalSlug])) {
      finalSlug = `${slug}-${counter++}`;
    }
    let finalFolder = folder || finalSlug;
    while (get('SELECT id FROM collections WHERE folder = ?', [finalFolder])) {
      finalFolder = `${finalFolder}-${counter++}`;
    }
    run('INSERT INTO collections (name, slug, platform, logo, folder, has_dataset, dataset_preset, scrape_mode, scrape_source_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, finalSlug, platform || null, logo || '', finalFolder, has_dataset ? 1 : 0, dataset_preset || null, scrape_mode || 'auto', scrape_source_priority || null]);
    const col = get('SELECT * FROM collections WHERE slug = ?', [finalSlug]);
    if (uploaded_version_id) {
      run('UPDATE set_versions SET collection_id = ? WHERE id = ?', [col.id, uploaded_version_id]);
    }
    res.status(201).json(col);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/collections/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, slug, platform, logo, folder, scrape_mode, scrape_source_priority } = req.body;
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
    if (scrape_mode != null) { sets.push('scrape_mode = ?'); vals.push(scrape_mode); }
    if (scrape_source_priority !== undefined) { sets.push('scrape_source_priority = ?'); vals.push(scrape_source_priority); }
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    if (sets.length) run(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, vals);

    // Rename data folder if it changed
    if (newFolder !== oldFolder) {
      const oldDir = path.join(romsDir, oldFolder);
      const newDir = path.join(romsDir, newFolder);
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
    // set_versions cascade with collection; collection delete handles FK
    run('DELETE FROM collections WHERE id = ?', [req.params.id]);
    const orphaned = all(`
      SELECT sv.id FROM set_versions sv
      WHERE sv.collection_id IS NULL
    `);
    for (const v of orphaned) {
      const gameIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [v.id]).map(r => r.game_id);
      run('DELETE FROM game_rom_files WHERE rom_set_id IN (SELECT id FROM game_rom_sets WHERE version_id = ?)', [v.id]);
      run('DELETE FROM game_rom_sets WHERE version_id = ?', [v.id]);
      run('DELETE FROM set_versions WHERE id = ?', [v.id]);
      syncGameAvailability(gameIds);
    }
    res.json({ ok: true, orphaned_versions: orphaned.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/collections/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc', q, parents_only, favourites_only, roms_only, version_id, year, manufacturer, platform } = req.query;
    const collection = get('SELECT * FROM collections WHERE id = ?', [id]);
    if (!collection) return res.status(404).json({ error: 'not found' });

    const versions = all('SELECT id as version_id FROM set_versions WHERE collection_id = ?', [id]);
    if (!versions.length) return res.json({ collection, games: [], platforms: [], total: 0 });

    const vids = version_id ? [Number(version_id)] : versions.map(v => v.version_id);
    const ph = vids.map(() => '?').join(',');
    const sortCol = sort === 'rating' ? 'MAX(COALESCE(gs.rating, 0))' : sort === 'play_count' ? 'MAX(COALESCE(gs.play_count, 0))' : sort === 'year' ? 'CAST(g.year AS INTEGER)' : sort === 'manufacturer' ? 'g.manufacturer' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    let whereExtra = '';
    let extraParams = [];
    if (q) {
      whereExtra += 'AND (g.name LIKE ? OR g.description LIKE ?)';
      extraParams.push(`%${q}%`, `%${q}%`);
    }
    if (parents_only === 'true') {
      whereExtra += ' AND g.parent_game_id IS NULL';
    }

    // For roms_only filter, use game_state.available flag
    if (roms_only === 'true') {
      whereExtra += ' AND COALESCE(gs.available, 0) = 1';
    }
    // For favourites_only filter, use game_state.favourite flag
    if (favourites_only === 'true') {
      whereExtra += ' AND COALESCE(gs.favourite, 0) = 1';
    }
    if (year) {
      whereExtra += ' AND g.year = ?';
      extraParams.push(year);
    }
    if (manufacturer) {
      whereExtra += ' AND g.manufacturer = ?';
      extraParams.push(manufacturer);
    }
    if (platform) {
      whereExtra += ' AND g.platform = ?';
      extraParams.push(platform);
    }

    // Always LEFT JOIN game_state for available/favourite/rating data
    const joinClause = 'LEFT JOIN game_state gs ON gs.game_id = g.id';

    const runnableFilter = 'AND (g.runnable != 0 OR g.runnable IS NULL)';
    const total = get(`SELECT COUNT(DISTINCT g.id) as c FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id ${joinClause} WHERE grs.version_id IN (${ph}) ${runnableFilter} ${whereExtra}`, [...vids, ...extraParams]).c;

    let games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, parent_g.name as cloneof, g.platform,
        MIN(g.id) as id, MIN(grs.version_id) as version_id, MIN(c.dataset_preset) as source, MIN(sv.version) as version,
        GROUP_CONCAT(c.dataset_preset || '||' || sv.version, ',') as versions_tags,
        MAX(COALESCE(gs.rating, 0)) as rating,
        MAX(COALESCE(gs.favourite, 0)) as favourite,
        MAX(COALESCE(gs.play_count, 0)) as play_count
      FROM games g
      JOIN collections c ON c.id = g.collection_id
      JOIN game_rom_sets grs ON grs.game_id = g.id
      JOIN set_versions sv ON sv.id = grs.version_id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      ${joinClause}
      WHERE grs.version_id IN (${ph}) ${runnableFilter} ${whereExtra}
      GROUP BY g.id
      ORDER BY ${sortCol} ${sortDir} NULLS LAST LIMIT ? OFFSET ?
    `, [...vids, ...extraParams, Number(limit), Number(offset)]);

    games = games.map(g => {
      const tags = g.versions_tags || '';
      const versions = tags.split(',').filter(Boolean).map(p => { const [, v] = p.split('||'); return v || p; });
      delete g.versions_tags;
      return { ...g, versions, regions: [] };
    });
    // Attach covers/screenshots from game_media (try own name, fall back to cloneof)
    const gameNames = [...new Set(games.flatMap(g => [g.name, g.cloneof].filter(Boolean)))];
    const colScrape = get('SELECT scrape_source_priority FROM collections WHERE id = ?', [id]);
    let enabledSet = null;
    if (colScrape?.scrape_source_priority) {
      try {
        const arr = JSON.parse(colScrape.scrape_source_priority);
        enabledSet = Array.isArray(arr) ? new Set(arr) : null;
      } catch {}
    }

    if (gameNames.length > 0) {
      const ph = gameNames.map(() => '?').join(',');
      const mediaRows = all(`SELECT gm.name, gm.platform, gm.covers, gm.screenshots, gm.source FROM game_media gm WHERE gm.name IN (${ph})`, gameNames);
      const mediaMap = {};
      for (const m of mediaRows) {
        if (enabledSet && !enabledSet.has(m.source || '')) continue;
        try {
          const entry = { covers: JSON.parse(m.covers) || [], screenshots: JSON.parse(m.screenshots) || [] };
          mediaMap[m.name + '|||' + (m.platform || '')] = entry;
        } catch {}
      }
      const psDir = path.join(dataDir, 'media', 'progettosnaps');
      games = games.map(g => {
        const plat = (g.platform || '').trim() || 'arcade';
        const mediaKey = g.name + '|||' + plat;
        const cloneofKey = g.cloneof ? g.cloneof + '|||' + plat : null;
        let covers = mediaMap[mediaKey]?.covers || (cloneofKey ? mediaMap[cloneofKey]?.covers : null) || [];
        let screenshots = mediaMap[mediaKey]?.screenshots || (cloneofKey ? mediaMap[cloneofKey]?.screenshots : null) || [];

        if (!enabledSet || enabledSet.has('progettosnaps')) {
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
        }

        return { ...g, covers, screenshots };
      });
    }

    const platforms = all(`
      SELECT DISTINCT g.platform as platform FROM games g
      JOIN game_rom_sets grs ON grs.game_id = g.id
      WHERE grs.version_id IN (${ph}) AND g.platform != '' AND g.platform IS NOT NULL
      ORDER BY g.platform
    `, vids).map(p => p.platform);

    const collectionVersions = all(`
      SELECT sv.id, c.dataset_preset as source, sv.version, sv.created_at,
        (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games
      FROM set_versions sv
      JOIN collections c ON c.id = sv.collection_id
      WHERE sv.collection_id = ?
    `, [id]);
    collectionVersions.sort((a, b) => sortVersions([a.version, b.version])[0] === a.version ? -1 : 1);

    res.json({ collection, games, platforms, total, versions: collectionVersions, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const versions = all(`
      SELECT sv.*, c.dataset_preset as source,
        (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games,
        ${AVAILABLE_GAMES_SQL}
      FROM set_versions sv
      JOIN collections c ON c.id = sv.collection_id
      WHERE sv.collection_id = ?
    `, [req.params.id]);
    versions.sort((a, b) => sortVersions([a.version, b.version])[0] === a.version ? -1 : 1);
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/versions', async (req, res) => {
  await dbReady;
  try {
    const { version_id } = req.body;
    if (!version_id) return res.status(400).json({ error: 'version_id required' });
    run('UPDATE set_versions SET collection_id = ? WHERE id = ?', [req.params.id, version_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/collections/:id/versions/:versionId', async (req, res) => {
  await dbReady;
  try {
    const versionId = Number(req.params.versionId);
    run('UPDATE set_versions SET collection_id = NULL WHERE id = ? AND collection_id = ?', [versionId, req.params.id]);

    const stillUsed = get('SELECT COUNT(*) as c FROM set_versions WHERE id = ? AND collection_id IS NOT NULL', [versionId]).c;
    if (stillUsed === 0) {
      const gameIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [versionId]).map(r => r.game_id);
      run('DELETE FROM game_rom_files WHERE rom_set_id IN (SELECT id FROM game_rom_sets WHERE version_id = ?)', [versionId]);
      run('DELETE FROM game_rom_sets WHERE version_id = ?', [versionId]);
      run('DELETE FROM set_versions WHERE id = ?', [versionId]);
      syncGameAvailability(gameIds);

      const col = get('SELECT folder FROM collections WHERE id = ?', [req.params.id]);
      if (col?.folder) {
        const versionFile = path.join(romsDir, col.folder, '.version');
        if (fs.existsSync(versionFile)) {
          const sv = get('SELECT version FROM set_versions WHERE id = ?', [versionId]);
          if (sv) {
            let versions = fs.readFileSync(versionFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
            versions = versions.filter(v => v !== sv.version);
            fs.writeFileSync(versionFile, versions.join('\n') + '\n');
          }
        }
      }
    }

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
        const result = execCli(['scan', String(version_id), dir]);
        runNow('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);
        const matchedNames = (result?.matches || []).map(m => m.name);
        if (matchedNames.length > 0) {
          const ph = matchedNames.map(() => '?').join(',');
          runNow(`UPDATE game_rom_sets SET available = 1
            WHERE version_id = ? AND game_id IN (
              SELECT g.id FROM games g WHERE g.name IN (${ph})
            )`, [version_id, ...matchedNames]);
        }
        const affectedIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id);
        syncGameAvailability(affectedIds);
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

function finalizeScan(scanResult, col, version_id, collectionDir, sv, buildId, jobId) {
  // Use game_id from scan matches (avoids name collisions across platforms)
  const matchedIds = [...new Set((scanResult?.matches || []).map(m => m.game_id).filter(id => id != null))];
  const missingNames = scanResult?.missing_names || [];
  const missingReasons = scanResult?.missing_reasons || [];

  runNow('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);
  if (matchedIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < matchedIds.length; i += CHUNK) {
      const chunk = matchedIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      runNow(`UPDATE game_rom_sets SET available = 1
        WHERE version_id = ? AND game_id IN (${ph})`, [version_id, ...chunk]);
    }
  }
  syncGameAvailability(all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id));

  const totalDb = get('SELECT COUNT(DISTINCT g.name) as c FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ?', [version_id]).c;
  const matched = get('SELECT COUNT(DISTINCT g.name) as c FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ? AND grs.available = 1', [version_id]).c;
  let reused = 0;
  const priorVersions = all('SELECT DISTINCT sv.version, sv.id FROM set_versions sv WHERE sv.collection_id = ? AND sv.id < ? ORDER BY sv.id', [col.id, version_id]);
  if (priorVersions.length > 0 && fs.existsSync(collectionDir)) {
    const currentIds = new Set(all('SELECT grs.game_id FROM game_rom_sets grs WHERE grs.version_id = ?', [version_id]).map(r => r.game_id));
    for (const pv of priorVersions) {
      const pvRoms = path.join(collectionDir, pv.version, 'roms');
      if (!fs.existsSync(pvRoms)) continue;
      try {
        const priorFiles = fs.readdirSync(pvRoms, { recursive: true }).filter(f => f.endsWith('.zip'));
        for (const f of priorFiles) {
          const stem = path.basename(f, '.zip');
          const match = get('SELECT grs.game_id FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ? AND g.name = ? LIMIT 1', [pv.id, stem]);
          if (match && currentIds.has(match.game_id)) reused++;
        }
      } catch {}
    }
  }
  runNow("UPDATE collection_builds SET status = 'complete', games_built = ?, completed_at = datetime('now') WHERE id = ?", [matched, buildId]);
  const sf = scanResult?.samples_found ?? 0;
  const sm = scanResult?.samples_missing ?? 0;
  const ms = scanResult?.missing_samples ?? [];
  doneJob(jobId, { found: matched, missing: totalDb - matched, total: totalDb, missing_names: missingNames, missing_by_platform: scanResult?.missing_by_platform || {}, matched_names: matchedIds, missing_reasons: missingReasons, samples_found: sf, samples_missing: sm, missing_samples: ms });
}

router.post('/api/collections/:id/build', async (req, res) => {
  await dbReady;
  try {
    const { version_id, import_dir, scan } = req.body;
    if (!version_id) return res.status(400).json({ error: 'version_id required' });

    const col = get('SELECT id, slug, folder FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const sv = get('SELECT sv.version, c.dataset_preset as source FROM set_versions sv JOIN collections c ON c.id = sv.collection_id WHERE sv.id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });

    const isNps = sv.source === 'nps';
    const needsImportDir = !isNps && !scan;
    if (needsImportDir && !import_dir) return res.status(400).json({ error: 'import_dir required for DAT builds' });

    const collectionDir = path.join(romsDir, col.folder || col.slug);
    fs.mkdirSync(collectionDir, { recursive: true });

    // Create/update collection_builds record
    const buildFormat = scan ? 'scan' : isNps ? 'pkg' : 'split';
    const totalGames = get('SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id = ?', [version_id]).c;
    const existingBuild = get('SELECT id FROM collection_builds WHERE collection_id = ? AND version_id = ?', [col.id, version_id]);
    let buildId;
    if (existingBuild) {
      runNow("UPDATE collection_builds SET status = 'building', format = ?, games_total = ?, started_at = datetime('now') WHERE id = ?", [buildFormat, totalGames, existingBuild.id]);
      buildId = existingBuild.id;
    } else {
      runNow("INSERT INTO collection_builds (collection_id, version_id, status, format, games_total, started_at) VALUES (?, ?, 'building', ?, ?, datetime('now'))", [col.id, version_id, buildFormat, totalGames]);
      buildId = get('SELECT id FROM collection_builds WHERE collection_id = ? AND version_id = ?', [col.id, version_id]).id;
    }

    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    setTimeout(async () => {
      try {
        if (scan) {
          if (isNps) {
            // NPS scan stays synchronous (no --progress support)
            let scanResult;
            scanResult = execCli(['scan', String(version_id), collectionDir], { binary: 'nps' });
            reloadDb();
            finalizeScan(scanResult, col, version_id, collectionDir, sv, buildId, jobId);
          } else {
            // DAT scan with streaming progress
            const scanDir = path.join(collectionDir, sv.version);
            const args = ['scan', String(version_id), scanDir, '--progress'];
            execCliStream(args, {
              binary: 'build',
              onProgress: (p) => updateProgress(jobId, p.pct || 0, p.msg || ''),
              signal: job._abort.signal,
            }).then(scanResult => {
              reloadDb();
              finalizeScan(scanResult, col, version_id, collectionDir, sv, buildId, jobId);
            }).catch(err => {
              if (job._abort.signal.aborted) return;
              runNow("UPDATE collection_builds SET status = 'failed', completed_at = datetime('now') WHERE id = ?", [buildId]);
              failJob(jobId, err.message);
            });
          }
        } else if (isNps) {
          // NPS build
          fs.mkdirSync(collectionDir, { recursive: true });
          const result = execCli(['build', String(version_id), collectionDir, '--input-dir', collectionDir], { binary: 'nps' });
          reloadDb();
          runNow('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);
          if (fs.existsSync(collectionDir)) {
            const found = fs.readdirSync(collectionDir, { recursive: true });
            for (const f of found) {
              if (f.endsWith('.pkg')) {
                const fname = path.basename(f);
                runNow(`UPDATE game_rom_sets SET available = 1
                  WHERE version_id = ? AND game_id IN (
                    SELECT grs.game_id FROM game_rom_files grf
                    JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
                    WHERE grf.filename = ?
                  )`, [version_id, fname]);
              }
            }
          }
          syncGameAvailability(all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id));
          runNow("UPDATE collection_builds SET status = 'complete', games_built = ?, completed_at = datetime('now') WHERE id = ?", [result.built || 0, buildId]);
          doneJob(jobId, { built: result.built, skipped: result.skipped });
        } else {
          // DAT build — uses progress streaming
          const args = ['build', import_dir, '--collection-id', String(col.id), '--version-id', String(version_id), '--base-dir', collectionDir, '--collection-dir', collectionDir, '--progress'];
          execCliStream(args, {
            binary: 'build',
            onProgress: (p) => updateProgress(jobId, p.pct || 0, p.msg || ''),
            signal: job._abort.signal,
          }).then(result => {
            try {
              const foundGameIds = new Set();
              const versionFilePath = path.join(collectionDir, '.version');
              const allVersions = (fs.existsSync(versionFilePath)
                ? fs.readFileSync(versionFilePath, 'utf-8').split('\n').map(l => l.trim()).filter(l => l)
                : []);
              const scanVersions = [];
              for (const v of allVersions) {
                scanVersions.push(v);
                if (v === sv.version) break;
              }
              if (scanVersions.length === 0) scanVersions.push(sv.version);
              for (const ver of scanVersions) {
                const romsDir = path.join(collectionDir, ver, 'roms');
                if (fs.existsSync(romsDir)) {
                  const walkDir = (dir, plat) => {
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                      const fullPath = path.join(dir, entry.name);
                      if (entry.isDirectory()) {
                        walkDir(fullPath, entry.name);
                      } else if (entry.isFile() && entry.name.endsWith('.zip')) {
                        const stem = entry.name.replace('.zip', '');
                        let id;
                        if (plat && plat !== 'roms') {
                          id = get('SELECT g.id FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ? AND g.name = ? AND g.platform = ? LIMIT 1', [version_id, stem, plat]);
                        } else {
                          id = get('SELECT g.id FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ? AND g.name = ? LIMIT 1', [version_id, stem]);
                        }
                        if (id) foundGameIds.add(id.id);
                      }
                    }
                  };
                  walkDir(romsDir, '');
                }
              }
              runNow('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);
              if (foundGameIds.size > 0) {
                const ids = [...foundGameIds];
                const ph = ids.map(() => '?').join(',');
                runNow(`UPDATE game_rom_sets SET available = 1
                  WHERE version_id = ? AND game_id IN (${ph})`, [version_id, ...ids]);
              }
              syncGameAvailability(all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id));
            } catch (_) {}
            runNow("UPDATE collection_builds SET status = 'complete', games_built = ?, completed_at = datetime('now') WHERE id = ?", [result.added || 0, buildId]);
            doneJob(jobId, result);
          }).catch(err => {
            runNow("UPDATE collection_builds SET status = 'failed', completed_at = datetime('now') WHERE id = ?", [buildId]);
            failJob(jobId, err.message);
          });
        }
      } catch (e) {
        if (job._abort.signal.aborted) return;
        runNow("UPDATE collection_builds SET status = 'failed', completed_at = datetime('now') WHERE id = ?", [buildId]);
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
      SELECT cb.*, sv.version, c.dataset_preset as source
      FROM collection_builds cb
      JOIN set_versions sv ON sv.id = cb.version_id
      JOIN collections c ON c.id = sv.collection_id
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
    const link = get('SELECT 1 FROM set_versions WHERE collection_id = ? AND id = ?', [colId, version_id]);
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

    const total = get('SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id = ?', [version_id]).c;
    const existing = get('SELECT id FROM collection_builds WHERE collection_id = ? AND version_id = ?', [colId, version_id]);
    if (existing) {
      runNow("UPDATE collection_builds SET status = 'building', format = ?, games_total = ?, started_at = datetime('now') WHERE id = ?", [format, total, existing.id]);
    } else {
      runNow("INSERT INTO collection_builds (collection_id, version_id, status, format, games_total, started_at) VALUES (?, ?, 'building', ?, ?, datetime('now'))", [colId, version_id, format, total]);
    }
    res.json(get('SELECT cb.*, sv.version, c.dataset_preset as source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id JOIN collections c ON c.id = sv.collection_id WHERE cb.collection_id = ? AND cb.version_id = ?', [colId, version_id]));
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
    res.json(get('SELECT cb.*, sv.version, c.dataset_preset as source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id JOIN collections c ON c.id = sv.collection_id WHERE cb.id = ?', [req.params.buildId]));
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
    const build = get('SELECT cb.*, sv.version, c.dataset_preset as source FROM collection_builds cb JOIN set_versions sv ON sv.id = cb.version_id JOIN collections c ON c.id = sv.collection_id WHERE cb.id = ? AND cb.collection_id = ?', [buildId, req.params.id]);
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
      // Scan output dir to set game_rom_sets.available for built games
      try {
        const buildDir = base_dir || path.join(romsDir, build.source);
        const foundGames = new Set();
        const versionFilePath = path.join(buildDir, '.version');
        const allVersions = (fs.existsSync(versionFilePath)
          ? fs.readFileSync(versionFilePath, 'utf-8').split('\n').map(l => l.trim()).filter(l => l)
          : []);
        const scanVersions = [];
        for (const v of allVersions) {
          scanVersions.push(v);
          if (v === build.version) break;
        }
        if (scanVersions.length === 0) scanVersions.push(build.version);
        for (const ver of scanVersions) {
          const romsDir = path.join(buildDir, ver, 'roms');
          if (fs.existsSync(romsDir)) {
            for (const entry of fs.readdirSync(romsDir, { withFileTypes: true })) {
              if (entry.isDirectory()) foundGames.add(entry.name);
              else if (entry.isFile() && entry.name.endsWith('.zip')) foundGames.add(entry.name.replace('.zip', ''));
            }
          }
        }
        const versionId = build.version_id;
        runNow('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [versionId]);
        if (foundGames.size > 0) {
          const names = [...foundGames];
          const ph = names.map(() => '?').join(',');
          runNow(`UPDATE game_rom_sets SET available = 1
            WHERE version_id = ? AND game_id IN (
              SELECT g.id FROM games g WHERE g.name IN (${ph})
            )`, [versionId, ...names]);
        }
        syncGameAvailability(all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [versionId]).map(r => r.game_id));
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
    const { format = 'split', action = 'preview', version_id } = req.body;
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

    if (action === 'export') {
      // Real export: invoke CLI to produce zips on disk
      const colDir = path.join(romsDir, collection.folder || collection.slug);
      const outputDir = path.join(colDir, 'exports', `${version.version}_${format}`);
      fs.mkdirSync(outputDir, { recursive: true });

      const inputDir = path.join(colDir, version.version, 'roms');

      const args = ['export', String(targetVersionId), outputDir, '--input-dir', inputDir, '--format', format, '--progress'];
      const result = await execCliStream(args, {
        binary: 'build',
        signal: req.abortController?.signal,
      });

      res.json({
        collection: collection.name,
        version: version.version,
        format,
        output_dir: outputDir,
        ...JSON.parse(result),
      });
    } else {
      // Preview: return game + ROM listing (existing behavior)
      const games = all(`
        SELECT g.id, g.name, g.description, g.year, g.manufacturer, parent_g.name as cloneof, g.platform,
          grf.filename as rom_filename, grf.size, grf.crc32, grf.md5, grf.sha1, grf.status as rom_status, grf.merge_target
        FROM games g
        LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
        JOIN game_rom_sets grs ON grs.game_id = g.id
        LEFT JOIN game_rom_files grf ON grf.rom_set_id = grs.id
        WHERE grs.version_id = ?
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
    }
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
        const cookieHdr = getCookieHeader();
        if (cookieHdr) headers['Cookie'] = cookieHdr;
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

    const sv = get('SELECT c.dataset_preset as source FROM set_versions sv JOIN collections c ON c.id = sv.collection_id WHERE sv.id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });
    if (sv.source !== 'nps') return res.status(400).json({ error: 'Version is not an NPS version' });

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

    const sv = get('SELECT c.dataset_preset as source FROM set_versions sv JOIN collections c ON c.id = sv.collection_id WHERE sv.id = ?', [version_id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });
    if (sv.source !== 'nps') return res.status(400).json({ error: 'Version is not an NPS version' });

    const collectionDir = path.join(romsDir, col.folder || col.slug);
    fs.mkdirSync(collectionDir, { recursive: true });

    const result = buildNps(collectionDir, version_id, input_dir);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/collections/:id/scrape-all', async (req, res) => {
  await dbReady;
  try {
    const versions = all('SELECT id as version_id FROM set_versions WHERE collection_id = ?', [req.params.id]);
    if (!versions.length) return res.status(400).json({ error: 'No versions linked to this collection' });

    const vids = versions.map(v => v.version_id);
    const ph = vids.map(() => '?').join(',');

    // Get all unscraped games (no manufacturer or year set)
    const unscraped = all(`SELECT g.id, g.name FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id IN (${ph}) AND (g.manufacturer IS NULL OR g.manufacturer = '') AND (g.year IS NULL OR g.year = '')`, vids);

    if (unscraped.length === 0) return res.json({ jobId: null, total: 0, message: 'All games already have metadata' });

    const game_ids = unscraped.map(g => g.id);
    const total = game_ids.length;
    const jobId = crypto.randomUUID();
    const job = createJob(jobId);
    job._abort = new AbortController();

    runNow('INSERT INTO scrape_jobs (id, status, total_games) VALUES (?, ?, ?)', [jobId, 'running', total]);

    Promise.resolve().then(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let scraped = 0, skipped = 0, failed = 0, cancelled = false, rateLimited = false;
      const errors = [];

      for (let i = 0; i < total; i++) {
        if (job._abort.signal.aborted) { cancelled = true; break; }
        if (rateLimited) { skipped++; continue; }
        const gid = game_ids[i];
        try {
          const result = await scrapeSingleGame(gid);
          if (result.scraped) {
            scraped++;
            updateProgress(jobId, Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✓ ${result.title || '#'+gid}`);
          } else {
            failed++;
            errors.push({ game_id: gid, error: result.error });
            updateProgress(jobId, Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✗ #${gid} — ${result.error}`);
          }
        } catch (e) {
          const msg = e.message || '';
          if (/429|rate.?limit|too many requests|quota/i.test(msg)) {
            rateLimited = true;
            errors.push({ game_id: gid, error: `Rate limited — ${msg}` });
            updateProgress(jobId, Math.round((i + 1) / total * 100), `Rate limited — stopping`);
          } else {
            failed++;
            errors.push({ game_id: gid, error: msg });
            updateProgress(jobId, Math.round((i + 1) / total * 100), `[${i+1}/${total}] ✗ #${gid} — ${msg}`);
          }
        }
        await sleep(3000);
      }

      if (job._abort.signal.aborted) {
        runNow("UPDATE scrape_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", [jobId]);
        return;
      }
      const resultPayload = { total, scraped, skipped, failed, errors, cancelled, rateLimited };
      runNow("UPDATE scrape_jobs SET status = 'done', scraped = ?, skipped = ?, failed = ?, rate_limited = ?, result = ?, updated_at = datetime('now') WHERE id = ?",
        [scraped, skipped, failed, rateLimited ? 1 : 0, JSON.stringify(resultPayload), jobId]);
      doneJob(jobId, resultPayload);
    });

    res.status(202).json({ jobId, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
