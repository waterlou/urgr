import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { getDb, saveDb } from '../db.js';
import { execCli, execCliStream } from '../cli.js';
import { createJob, updateProgress, doneJob, failJob } from '../jobs.js';
import { all, get, run, runNow, unescapeXml, dbReady } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// =============================================================================
// Fill Descriptions
// =============================================================================
router.post('/api/versions/:id/fill-descriptions', async (req, res) => {
  await dbReady;
  try {
    const sv = get('SELECT * FROM set_versions WHERE id = ?', [req.params.id]);
    if (!sv) return res.status(404).json({ error: 'Version not found' });

    const SOURCE_REPOS = {
      FBNeo: 'libretro/FBNeo',
      FBAlpha43: 'barbudreadmon/fbalpha-backup-dontuse-ty',
      FBAlpha44: 'libretro/fbalpha',
    };
    const repo = SOURCE_REPOS[sv.source];
    if (!repo) return res.json({ updated: 0, error: `Source ${sv.source} not supported for re-import` });

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

// =============================================================================
// Versions
// =============================================================================

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
    const fbalphaVersions = [
      { version: '0.2.97.43', source: 'FBAlpha43', repo: FBALPHA43_REPO },
      { version: '0.2.97.44', source: 'FBAlpha44', repo: FBALPHA44_REPO },
    ];

    const imported = all("SELECT id, source, version FROM set_versions WHERE source IN ('FBNeo','FBAlpha43','FBAlpha44') ORDER BY version");
    const importedSet = new Set(imported.map(v => `${v.source}:${v.version}`));

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

router.get('/api/versions', async (req, res) => {
  await dbReady;
  try {
    const versions = all('SELECT sv.*, (SELECT COUNT(*) FROM game_entries WHERE version_id = sv.id) as total_games FROM set_versions sv ORDER BY sv.created_at DESC');
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/versions/:id/games', async (req, res) => {
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

router.get('/api/versions/available', async (req, res) => {
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

router.post('/api/versions/import-online', async (req, res) => {
  await dbReady;
  try {
    const { collection_id, version, source: reqSource, refresh } = req.body;
    if (!collection_id || !version) return res.status(400).json({ error: 'collection_id and version required' });

    const source = reqSource || 'MAME';

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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const contentsResp = await fetch(`https://api.github.com/repos/${repo}/contents/dats?ref=${ref}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!contentsResp.ok) throw new Error(`GitHub API HTTP ${contentsResp.status}`);
      const contents = await contentsResp.json();
      if (!Array.isArray(contents)) throw new Error('Invalid response from GitHub contents API');

      let datFiles = contents.filter(f => f.name.endsWith('.dat') && f.download_url);

      if (source === 'FBAlpha43') {
        const combined = datFiles.find(f => f.name.includes('0.2.97.43') && !f.name.includes('only'));
        if (combined) datFiles = [combined];
      }

      if (datFiles.length === 0) throw new Error('No DAT files found in the dats/ folder');

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

      const row = get('SELECT id FROM set_versions WHERE source = ? AND version = ?', [srcLabel, version]);
      if (row) run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, row.id]);

      fbneoDatsCache = null;
      res.json({ ok: true, version_id: row.id, total_games: totalGames });
      return;
    }

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

router.post('/api/versions/import-dat', async (req, res) => {
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

export default router;
