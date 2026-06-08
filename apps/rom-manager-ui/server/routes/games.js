import { Router } from 'express';
import crypto, { createHash } from 'crypto';
import { getDb } from '../db.js';
import { execCli } from '../cli.js';
import { createJob, updateProgress, doneJob, failJob } from '../jobs.js';
import { all, get, run, runNow, dbReady } from '../helpers.js';
import { fetchSonyScreenshots } from '../nps.js';

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

router.get('/:id', async (req, res) => {
  await dbReady;
  try {
    const game = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'not found' });
    if (typeof game.covers === 'string') try { game.covers = JSON.parse(game.covers); } catch { game.covers = []; }
    if (typeof game.screenshots === 'string') try { game.screenshots = JSON.parse(game.screenshots); } catch { game.screenshots = []; }
    if (typeof game.synopsis === 'string') try { game.synopsis = JSON.parse(game.synopsis); } catch {}
    const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
    // Mark which ROMs have been downloaded
    const completedDownloads = new Set(
      all('SELECT filename FROM download_queue WHERE game_entry_id = ? AND status = ?', [game.id, 'completed']).map(r => r.filename)
    );
    for (const rom of roms) {
      rom.downloaded = completedDownloads.has(rom.filename);
    }
    const scanned = all('SELECT * FROM scanned_games WHERE name = ? AND version_id = ?', [game.name, game.version_id]);
    const state = get('SELECT * FROM game_state WHERE game_entry_id = ?', [game.id]);
    const clones = all(`SELECT id, name, description, cloneof, region FROM game_entries WHERE name = ? AND version_id = ? AND id != ?${game.cloneof ? ' AND cloneof IS NOT NULL' : ''} ORDER BY name`, [game.cloneof || game.name, game.version_id, game.id]);
    let parent = null;
    if (game.cloneof) {
      parent = get('SELECT id, name, region FROM game_entries WHERE name = ? AND version_id = ? AND cloneof IS NULL', [game.cloneof, game.version_id]);
    }
    res.json({ ...game, roms, scanned_games: scanned, rating: state?.rating || 0, favourite: state?.favourite || 0, available: state?.available || 0, play_count: state?.play_count || 0, clones, parent });
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
  }

  const updated = get('SELECT g.*, sv.source, sv.version FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [game.id]);
  if (typeof updated.covers === 'string') try { updated.covers = JSON.parse(updated.covers); } catch { updated.covers = []; }
  if (typeof updated.screenshots === 'string') try { updated.screenshots = JSON.parse(updated.screenshots); } catch { updated.screenshots = []; }
  updated.roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ?', [game.id]);
  updated.scanned_games = all('SELECT * FROM scanned_games WHERE name = ? AND version_id = ?', [game.name, game.version_id]);

  // For NPS/PlayStation games, try to get screenshots from Sony Store API if not already scraped
  if (updated.source === 'NPS' && (!updated.screenshots || updated.screenshots.length === 0)) {
    try {
      const sonyScreenshots = await fetchSonyScreenshots(updated.content_id, updated.title_id);
      if (sonyScreenshots.length > 0) {
        run('UPDATE game_entries SET screenshots = ? WHERE id = ?', [JSON.stringify(sonyScreenshots), game.id]);
        updated.screenshots = sonyScreenshots;
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

export default router;
