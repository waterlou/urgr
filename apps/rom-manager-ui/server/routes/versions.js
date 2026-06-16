import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { getDb, saveDb } from '../db.js';
import { execCli, execCliStream } from '../cli.js';
import { createJob, updateProgress, doneJob, failJob } from '../jobs.js';
import { all, get, run, runNow, unescapeXml, dbReady } from '../helpers.js';
import { importNps, scanNpsDir, buildNps, NPS_PLATFORMS, NPS_PLATFORM_MAP } from '../nps.js';
import { sortVersions } from '../versionSort.js';
import { romsDir } from '../paths.js';

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

    const games = all(`SELECT g.id, g.name, g.description, parent_g.name as cloneof
      FROM games g
      JOIN game_rom_sets grs ON grs.game_id = g.id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      WHERE grs.version_id = ?
      AND (g.description IS NULL OR g.description = "" OR length(g.description) > 80 OR parent_g.name IS NULL)`, [sv.id]);
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
        updates.push('parent_game_id = (SELECT id FROM games WHERE name = ?)');
        upParams.push(co);
        cloneofFilled++;
      }
      if (updates.length > 0) {
        upParams.push(g.id);
        run(`UPDATE games SET ${updates.join(', ')} WHERE id = ?`, upParams);
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

// Match version patterns in filenames for MAME DAT archives
function mameDatMatches(base, version, nickname) {
  const patterns = [];
  const v = version.toLowerCase();                             // "0.274"
  patterns.push(v, v.replace(/\./g, ''), v.replace(/^0\./, '')); // "0.274", "0274", "274"
  if (nickname) {
    const n = nickname.toLowerCase();                          // "0.37b5"
    patterns.push(n, n.replace(/\./g, ''));                    // "0.37b5", "037b5"
    // Also try zero-padded beta: "0.37b5" → "0.37b05"
    const betaMatch = n.match(/^(\d+\.\d+b)(\d+)$/i);
    if (betaMatch) patterns.push(betaMatch[1] + betaMatch[2].padStart(2, '0'));
    // And without leading zero on major: "0.37b5" → "37b5", "37b05"
    const noLeading = n.replace(/^0\./, '');
    patterns.push(noLeading);
    const noLeadingBeta = betaMatch ? betaMatch[1].replace(/^0\./, '') + betaMatch[2].padStart(2, '0') : null;
    if (noLeadingBeta) patterns.push(noLeadingBeta);
  }
  return patterns.some(p => base.includes(p));
}

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

    const imported = all("SELECT id, source, version, created_at FROM set_versions WHERE source IN ('FBNeo','FBAlpha43','FBAlpha44') ORDER BY version");
    const importedSet = new Set(imported.map(v => `${v.source}:${v.version}`));

    const allVersions = sortVersions([
      ...fbalphaVersions.map(v => v.version),
      ...versions.slice().reverse(),
      'nightly',
    ]).flatMap(v => {
      if (v === 'nightly') return [{ version: 'nightly', source: 'FBNeo', repo: FBNEO_REPO, ref: 'master', nightly: true }]
      const fbalpha = fbalphaVersions.find(fv => fv.version === v)
      if (fbalpha) return [fbalpha]
      return [{ version: v, source: 'FBNeo', repo: FBNEO_REPO, ref: v }]
    });

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

const OFFLINELIST_BASE_URL = 'http://nointro.free.fr';
let offlinelistDatsCache = null;
let offlinelistDatsCacheTime = 0;

async function getOfflineListVersions() {
  if (offlinelistDatsCache && Date.now() - offlinelistDatsCacheTime < CACHE_TTL) return offlinelistDatsCache;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${OFFLINELIST_BASE_URL}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // Parse DAT file links: href="datas/Official No-Intro <Platform>.zip"
    const linkRegex = /href="datas\/(Official No-Intro [^"]*\.zip)"/gi;
    const allVersions = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const zipName = match[1];
      // Extract platform name: "Official No-Intro Nintendo Gameboy.zip" → "Nintendo Gameboy"
      const platform = zipName.replace('Official No-Intro ', '').replace('.zip', '');
      allVersions.push({
        version: platform,
        source: 'OFFLINELIST',
        zipName,
        url: `${OFFLINELIST_BASE_URL}/datas/${encodeURIComponent(zipName)}`,
      });
    }

    const imported = all("SELECT id, source, version, created_at FROM set_versions WHERE source = 'OFFLINELIST' ORDER BY version");
    const importedSet = new Set(imported.map(v => v.version));
    const missing = allVersions.filter(v => !importedSet.has(v.version));

    const result = {
      source: 'OFFLINELIST',
      latest: allVersions.length > 0 ? allVersions[0].version : null,
      hasNewer: missing.length > 0,
      available: allVersions,
      imported,
      missing,
    };

    offlinelistDatsCache = result;
    offlinelistDatsCacheTime = Date.now();
    return result;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// DAT-O-MATIC system list (from datomatic.no-intro.org)
const DATOMATIC_SYSTEMS = [
  { id: '45', name: 'Nintendo - Nintendo Entertainment System' },
  { id: '49', name: 'Nintendo - Super Nintendo Entertainment System' },
  { id: '46', name: 'Nintendo - Game Boy' },
  { id: '47', name: 'Nintendo - Game Boy Color' },
  { id: '23', name: 'Nintendo - Game Boy Advance' },
  { id: '24', name: 'Nintendo - Nintendo 64' },
  { id: '28', name: 'Nintendo - Nintendo DS' },
  { id: '54', name: 'Nintendo - Nintendo DSi' },
  { id: '64', name: 'Nintendo - Nintendo 3DS' },
  { id: '31', name: 'Nintendo - Family Computer Disk System' },
  { id: '15', name: 'Nintendo - Virtual Boy' },
  { id: '83', name: 'Nintendo - Nintendo 64DD' },
  { id: '14', name: 'Nintendo - Pokemon Mini' },
  { id: '32', name: 'Sega - Mega Drive - Genesis' },
  { id: '26', name: 'Sega - Master System - Mark III' },
  { id: '25', name: 'Sega - Game Gear' },
  { id: '17', name: 'Sega - 32X' },
  { id: '19', name: 'Sega - SG-1000 - SC-3000' },
  { id: '88', name: 'Atari - Atari 2600' },
  { id: '1', name: 'Atari - Atari 5200' },
  { id: '74', name: 'Atari - Atari 7800' },
  { id: '2', name: 'Atari - Atari Jaguar' },
  { id: '30', name: 'Atari - Atari Lynx' },
  { id: '12', name: 'NEC - PC Engine - TurboGrafx-16' },
  { id: '13', name: 'NEC - PC Engine SuperGrafx' },
  { id: '35', name: 'SNK - NeoGeo Pocket' },
  { id: '36', name: 'SNK - NeoGeo Pocket Color' },
  { id: '50', name: 'Bandai - WonderSwan' },
  { id: '51', name: 'Bandai - WonderSwan Color' },
  { id: '7', name: 'GCE - Vectrex' },
  { id: '3', name: 'Coleco - ColecoVision' },
  { id: '42', name: 'Commodore - Commodore 64' },
  { id: '10', name: 'Microsoft - MSX' },
  { id: '11', name: 'Microsoft - MSX2' },
  { id: '105', name: 'Mattel - Intellivision' },
  { id: '6', name: 'Fairchild - Channel F' },
  { id: '22', name: 'Watara - Supervision' },
  { id: '20', name: 'Tiger - Game.com' },
  { id: '9', name: 'Magnavox - Odyssey 2' },
  { id: '33', name: 'Commodore - Plus-4' },
  { id: '34', name: 'Commodore - VIC-20' },
  { id: '40', name: 'Commodore - Amiga' },
  { id: '43', name: 'Commodore - Commodore 64 (PP)' },
];

function getDatomicVersions() {
  const imported = all("SELECT id, source, version, created_at FROM set_versions WHERE source = 'DATOMATIC' ORDER BY version");
  const importedSet = new Set(imported.map(v => v.version));

  const allVersions = DATOMATIC_SYSTEMS.map(s => ({
    version: s.name,
    source: 'DATOMATIC',
    systemId: s.id,
    url: `https://datomatic.no-intro.org/index.php?page=download&op=dat&s=${s.id}`,
  }));

  const missing = allVersions.filter(v => !importedSet.has(v.version));

  return {
    source: 'DATOMATIC',
    latest: null,
    hasNewer: missing.length > 0,
    available: allVersions,
    imported,
    missing,
  };
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Download a DAT from DAT-O-MATIC via 3-step form submission:
 * 1. GET the page to get session cookie + find dat_dl_<hash> button
 * 2. POST with system_selection + dat_dl button → redirect to download page
 * 3. POST the Download... button on the result page → get ZIP file
 */
async function downloadDatomicDat(systemId) {
  const cookieJar = {};

  function parseCookies(headers) {
    const setCookies = headers['set-cookie'] || [];
    for (const c of (Array.isArray(setCookies) ? setCookies : [setCookies])) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      cookieJar[k.trim()] = v.join('=').trim();
    }
  }

  function cookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // Step 1: GET the download page to get session + Prepare button
  const pageUrl = `https://datomatic.no-intro.org/index.php?page=download&op=dat&s=${systemId}`;
  let resp1;
  try {
    resp1 = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader() },
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(`[DAT-O-MATIC step1] Failed to fetch page for system ${systemId}: ${e.message}`);
  }
  if (!resp1.ok && resp1.status !== 302) {
    throw new Error(`[DAT-O-MATIC step1] Page returned HTTP ${resp1.status} for system ${systemId} (${pageUrl})`);
  }
  parseCookies(Object.fromEntries(resp1.headers.entries()));
  const html1 = await resp1.text();

  // Find the dat_dl_<hash> button
  const buttonMatch = html1.match(/name="(dat_dl_[a-f0-9-]+)"\s+value="Prepare"/);
  if (!buttonMatch) {
    const hasDatDl = html1.includes('dat_dl_');
    const hasPrepare = html1.includes('Prepare');
    throw new Error(`[DAT-O-MATIC step1] Prepare button not found for system ${systemId}. Page has dat_dl=${hasDatDl}, Prepare=${hasPrepare}. Page length=${html1.length}`);
  }
  const buttonName = buttonMatch[1];

  // Step 2: POST with system_selection + Prepare to trigger DAT generation
  let resp2;
  try {
    resp2 = await fetch(pageUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(),
      },
      body: `system_selection=${systemId}&${buttonName}=Prepare`,
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(`[DAT-O-MATIC step2] POST Prepare failed for system ${systemId}: ${e.message}`);
  }
  parseCookies(Object.fromEntries(resp2.headers.entries()));

  const location = resp2.headers.get('location');
  if (!location) {
    throw new Error(`[DAT-O-MATIC step2] No redirect after Prepare for system ${systemId}. HTTP ${resp2.status}`);
  }

  // Step 3: GET the manager/download page
  const managerUrl = location.startsWith('http') ? location : `https://datomatic.no-intro.org/${location}`;
  let resp3;
  try {
    resp3 = await fetch(managerUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader() },
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(`[DAT-O-MATIC step3] Failed to fetch manager page (${managerUrl}): ${e.message}`);
  }
  parseCookies(Object.fromEntries(resp3.headers.entries()));
  const html3 = await resp3.text();

  // Find the Download... button hash
  const dlMatch = html3.match(/name="([a-f0-9]+)"\s+value="Download\.\.\."/) ||
                  html3.match(/name="([a-f0-9]+)"\s+value="Download"/);
  if (!dlMatch) {
    throw new Error(`[DAT-O-MATIC step3] Download button not found on manager page for system ${systemId}. URL=${managerUrl}, page length=${html3.length}`);
  }
  const dlHash = dlMatch[1];

  // Step 4: POST the Download button to get the ZIP file
  let resp4;
  try {
    resp4 = await fetch(managerUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(),
      },
      body: `${dlHash}=Download...`,
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(`[DAT-O-MATIC step4] POST Download failed for system ${systemId}: ${e.message}`);
  }
  parseCookies(Object.fromEntries(resp4.headers.entries()));

  const contentType = resp4.headers.get('content-type') || '';
  if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
    // Follow one more redirect if needed
    const loc2 = resp4.headers.get('location');
    if (loc2) {
      const step5Url = loc2.startsWith('http') ? loc2 : `https://datomatic.no-intro.org/${loc2}`;
      let resp5;
      try {
        resp5 = await fetch(step5Url, {
          headers: { 'User-Agent': UA, 'Cookie': cookieHeader() },
          redirect: 'follow',
        });
      } catch (e) {
        throw new Error(`[DAT-O-MATIC step4] Redirect follow failed (${step5Url}): ${e.message}`);
      }
      const ct5 = resp5.headers.get('content-type') || '';
      if (!ct5.includes('zip') && !ct5.includes('octet-stream')) {
        throw new Error(`[DAT-O-MATIC step4] Expected ZIP but got ${ct5} for system ${systemId} after redirect to ${step5Url}`);
      }
      return Buffer.from(await resp5.arrayBuffer());
    }
    throw new Error(`[DAT-O-MATIC step4] Expected ZIP but got ${contentType} for system ${systemId}. HTTP ${resp4.status}`);
  }

  return Buffer.from(await resp4.arrayBuffer());
}

router.get('/api/versions', async (req, res) => {
  await dbReady;
  try {
    const versions = all('SELECT sv.*, (SELECT COUNT(*) FROM game_rom_sets WHERE version_id = sv.id) as total_games FROM set_versions sv ORDER BY sv.created_at DESC');
    res.json(versions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/versions/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0, q } = req.query;
    if (!get('SELECT 1 FROM set_versions WHERE id = ?', [id])) return res.status(404).json({ error: 'not found' });
    const where = q ? 'AND (g.name LIKE ? OR g.description LIKE ? OR g.manufacturer LIKE ?)' : '';
    const params = q ? [id, `%${q}%`, `%${q}%`, `%${q}%`, Number(limit), Number(offset)] : [id, Number(limit), Number(offset)];
    const games = all(`SELECT g.*, parent_g.name as cloneof
      FROM games g
      JOIN game_rom_sets grs ON grs.game_id = g.id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      WHERE grs.version_id = ? AND (g.runnable != 0 OR g.runnable IS NULL) ${where}
      ORDER BY g.name LIMIT ? OFFSET ?`, params);
    res.json({ games, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/versions/import-online', async (req, res) => {
  await dbReady;
  try {
    const { collection_id, version, source: reqSource, refresh } = req.body;
    if (!collection_id || !version) return res.status(400).json({ error: 'collection_id and version required' });

    const source = reqSource || 'MAME';

    if (source === 'DATOMATIC') {
      // DAT-O-MATIC: download via form submission, extract ZIP, import
      const system = DATOMATIC_SYSTEMS.find(s => s.name === version);
      if (!system) throw new Error(`Unknown DAT-O-MATIC system: ${version}`);

      const tempZip = path.join('/tmp', `datomatic_${Date.now()}.zip`);
      const extractDir = path.join('/tmp', `datomatic_extract_${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        const zipBuffer = await downloadDatomicDat(system.id);
        fs.writeFileSync(tempZip, zipBuffer);

        // Extract ZIP
        execSync(`unzip -o "${tempZip}" -d "${extractDir}"`, { encoding: 'utf-8' });

        // Find the DAT file
        const datFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.dat') || f.endsWith('.xml'));
        if (datFiles.length === 0) throw new Error('No DAT file found in ZIP');

        const datPath = path.join(extractDir, datFiles[0]);
        const result = execCli(['import', datPath, 'DATOMATIC', version], { binary: 'parse' });
        if (!result) throw new Error('CLI returned null');

        const versionId = result.version_id;
        const totalGames = result.games_inserted || 0;
        if (!versionId) throw new Error(`Failed to create version for DATOMATIC "${version}"`);

        run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, versionId]);

        res.json({ ok: true, version_id: versionId, total_games: totalGames });
        return;
      } finally {
        try { fs.unlinkSync(tempZip); } catch (_) {}
        try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
      }
    }

    if (source === 'OFFLINELIST') {
      // OfflineList: download ZIP from nointro.free.fr, extract XML, import
      const zipUrl = `${OFFLINELIST_BASE_URL}/datas/${encodeURIComponent('Official No-Intro ' + version + '.zip')}`;
      const tempZip = path.join('/tmp', `nointro_${Date.now()}.zip`);
      const extractDir = path.join('/tmp', `nointro_extract_${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        // Download ZIP
        const dlController = new AbortController();
        const dlTimeout = setTimeout(() => dlController.abort(), 60_000);
        let dlRes;
        try {
          dlRes = await fetch(zipUrl, {
            signal: dlController.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          });
        } catch (e) {
          throw new Error(`[OfflineList] Failed to download ${zipUrl}: ${e.message}`);
        }
        clearTimeout(dlTimeout);
        if (!dlRes.ok) throw new Error(`[OfflineList] Download returned HTTP ${dlRes.status} for "${version}" (${zipUrl})`);
        fs.writeFileSync(tempZip, Buffer.from(await dlRes.arrayBuffer()));

        // Extract ZIP
        try {
          execSync(`unzip -o "${tempZip}" -d "${extractDir}"`, { encoding: 'utf-8' });
        } catch (e) {
          throw new Error(`[OfflineList] Failed to extract ZIP for "${version}": ${e.message}`);
        }

        // Find the XML file
        const xmlFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.xml'));
        if (xmlFiles.length === 0) throw new Error(`[OfflineList] No XML file found in ZIP for "${version}" (files: ${fs.readdirSync(extractDir).join(', ')})`);

        const xmlPath = path.join(extractDir, xmlFiles[0]);
        let result;
        try {
          result = execCli(['import', xmlPath, 'OFFLINELIST', version], { binary: 'parse' });
        } catch (e) {
          throw new Error(`[OfflineList] parse-cli import failed for "${version}": ${e.message}`);
        }
        if (!result) throw new Error(`[OfflineList] parse-cli returned null for "${version}"`);

        const versionId = result.version_id;
        const totalGames = result.games_inserted || 0;
        if (!versionId) throw new Error(`[OfflineList] Failed to create version for "${version}"`);

        run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, versionId]);

        offlinelistDatsCache = null;
        res.json({ ok: true, version_id: versionId, total_games: totalGames });
        return;
      } finally {
        try { fs.unlinkSync(tempZip); } catch (_) {}
        try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
      }
    }

    if (source === 'DATOMATIC') {
      // DAT-O-MATIC: three-step download flow
      const system = DATOMATIC_SYSTEMS.find(s => s.name === version);
      if (!system) throw new Error(`Unknown DAT-O-MATIC system: ${version}`);

      const tempZip = path.join('/tmp', `datomatic_${Date.now()}.zip`);
      const extractDir = path.join('/tmp', `datomatic_extract_${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        let zipBuffer;
        try {
          ({ zipBuffer } = await downloadDatomicDat(system.id));
        } catch (e) {
          throw new Error(`[DAT-O-MATIC] Download failed for "${version}" (system ${system.id}): ${e.message}`);
        }
        fs.writeFileSync(tempZip, zipBuffer);

        // Extract ZIP
        try {
          execSync(`unzip -o "${tempZip}" -d "${extractDir}"`, { encoding: 'utf-8' });
        } catch (e) {
          throw new Error(`[DAT-O-MATIC] Failed to extract ZIP for "${version}": ${e.message}`);
        }

        // Find the DAT file (.dat or .xml)
        const datFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.dat') || f.endsWith('.xml'));
        if (datFiles.length === 0) throw new Error(`[DAT-O-MATIC] No DAT file found in ZIP for "${version}" (files: ${fs.readdirSync(extractDir).join(', ')})`);

        const datPath = path.join(extractDir, datFiles[0]);
        let result;
        try {
          result = execCli(['import', datPath, 'DATOMATIC', version], { binary: 'parse' });
        } catch (e) {
          throw new Error(`[DAT-O-MATIC] parse-cli import failed for "${version}": ${e.message}`);
        }
        if (!result) throw new Error(`[DAT-O-MATIC] parse-cli returned null for "${version}"`);

        const versionId = result.version_id;
        const totalGames = result.games_inserted || 0;
        if (!versionId) throw new Error(`[DAT-O-MATIC] Failed to create version for "${version}"`);

        run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, versionId]);

        res.json({ ok: true, version_id: versionId, total_games: totalGames });
        return;
      } finally {
        try { fs.unlinkSync(tempZip); } catch (_) {}
        try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
      }
    }

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

      // Update .version file so fallback can find this version
      const col = get('SELECT c.folder FROM collections c WHERE c.id = ?', [collection_id])
      if (col?.folder) {
        const versionFile = path.join(romsDir, col.folder, '.version')
        let versions = []
        if (fs.existsSync(versionFile)) {
          versions = fs.readFileSync(versionFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
        }
        versions.push(version)
        fs.writeFileSync(versionFile, sortVersions([...new Set(versions)]).join('\n') + '\n')
      }

      fbneoDatsCache = null;
      res.json({ ok: true, version_id: row.id, total_games: totalGames });
      return;
    }

    else {
      let url = null;
      let mameNickname = null;
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
            const cellText = cells[0];
            const parenMatch = cellText.match(/\(([^)]+)\)/);
            mameNickname = parenMatch ? parenMatch[1].trim() : null;
            const ver = cellText.replace(/\([^)]+\)/g, '').replace(/[()]/g, '').trim().split(/\s+/)[0];
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
      let foundDat = null;
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

        // Pick the best DAT: prefer ARCADE subset, then .dat over .xml, skip mess/chd subsets
        const dats = allFiles.map(fp => ({ fp, base: path.basename(fp).toLowerCase() }))
          .filter(({ base }) => {
            if (!base.endsWith('.xml') && !(base.endsWith('.dat') && !/without.?crc|nocrc/i.test(base))) return false;
            if (/\(?mess\)?|\bchd\b/i.test(base)) return false; // skip mess/chd subsets
            return mameDatMatches(base, version, mameNickname) || /^mame(\s|\b|_)/.test(base) || /^arcade(\s|\b|_)/.test(base);
          })
          .sort((a, b) => {
            // Full MAME set preferred over arcade-only subset
            const aFull = a.base.startsWith('arcade') ? 1 : 0;
            const bFull = b.base.startsWith('arcade') ? 1 : 0;
            if (aFull !== bFull) return aFull - bFull;
            // .xml preferred over .dat (listxml has richer attributes)
            const aIsXml = a.base.endsWith('.xml') ? 0 : 1;
            const bIsXml = b.base.endsWith('.xml') ? 0 : 1;
            if (aIsXml !== bIsXml) return aIsXml - bIsXml;
            // Version match before generic name
            const aVer = mameDatMatches(a.base, version, mameNickname) ? 0 : 1;
            const bVer = mameDatMatches(b.base, version, mameNickname) ? 0 : 1;
            if (aVer !== bVer) return aVer - bVer;
            // Descending alphabetical so latest date-wed release sorts first
            return b.base.localeCompare(a.base);
          });

        if (dats.length > 0) foundDat = dats[0].fp;

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
            const nestedDats = nestedFiles.map(fp2 => ({ fp: fp2, base: path.basename(fp2).toLowerCase() }))
              .filter(({ base: b }) => {
                if (!b.endsWith('.xml') && !b.endsWith('.dat')) return false;
                return mameDatMatches(b, version, mameNickname) || /^mame(\s|\b|_)/.test(b);
              })
              .sort((a, b) => {
                // XML preferred over DAT
                const aIsXml = a.base.endsWith('.xml') ? 0 : 1;
                const bIsXml = b.base.endsWith('.xml') ? 0 : 1;
                if (aIsXml !== bIsXml) return aIsXml - bIsXml;
                // Version/nickname match before loose match
                const aMatch = mameDatMatches(a.base, version, mameNickname) ? 0 : 1;
                const bMatch = mameDatMatches(b.base, version, mameNickname) ? 0 : 1;
                if (aMatch !== bMatch) return aMatch - bMatch;
                // Descending alphabetical so latest date sorts first
                return b.base.localeCompare(a.base);
              });
            if (nestedDats.length > 0) { foundDat = nestedDats[0].fp; break; }
          }
        }

        if (!foundDat) {
          for (const fp of allFiles) {
            const b = path.basename(fp).toLowerCase();
            if (b.endsWith('.xml')) { foundDat = fp; break; }
            if (b.endsWith('.dat') && !/without.?crc|nocrc/i.test(b) && !foundDat) foundDat = fp;
          }
        }

        if (!foundDat) throw new Error(`No DAT/XML file found for version "${version}" in the archive`);

        console.log(`[mame-import] Selected: ${foundDat} (${(fs.statSync(foundDat).size / 1024 / 1024).toFixed(1)} MB)`);
        try { fs.writeFileSync('/tmp/mame_debug_sample.txt', fs.readFileSync(foundDat, { encoding: 'utf-8', flag: 'r' }).slice(0, 500)); } catch {}

        const result = execCli(['import', foundDat, 'MAME', version], { binary: 'parse' });
        if (!result) throw new Error('CLI returned null');
        console.log(`[mame-import] Format: ${result.format}, games: ${result.games_inserted}`);

        // Import companion DATs (CHD, Samples) if present — same version, existing games only
        for (const fp of allFiles) {
          const base = path.basename(fp).toLowerCase();
          if (/MAME_CHD_.*\.dat$/i.test(base)) {
            console.log(`[mame-import] Also importing ${base} (subtype: chd)`);
            try {
              execCli(['import', fp, 'MAME', version, '--subtype', 'chd', '--existing-only'], { binary: 'parse' });
            } catch (e) { console.error(`[mame-import] CHD import failed: ${e.message}`); }
          }
          if (/MAME_Samples_.*\.dat$/i.test(base)) {
            console.log(`[mame-import] Also importing ${base} (subtype: sample)`);
            try {
              execCli(['import', fp, 'MAME', version, '--subtype', 'sample', '--existing-only'], { binary: 'parse' });
            } catch (e) { console.error(`[mame-import] Samples import failed: ${e.message}`); }
          }
        }

        const versionId = result.version_id;
        const totalGames = result.games_inserted || 0;
        if (!versionId) throw new Error(`Failed to create version for MAME "${version}"`);

        run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, versionId]);

        // Update .version file so fallback can find this version
        const col = get('SELECT c.folder FROM collections c WHERE c.id = ?', [collection_id])
        if (col?.folder) {
          const versionFile = path.join(romsDir, col.folder, '.version')
          let versions = []
          if (fs.existsSync(versionFile)) {
            versions = fs.readFileSync(versionFile, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean)
          }
          versions.push(version)
          fs.writeFileSync(versionFile, sortVersions([...new Set(versions)]).join('\n') + '\n')
        }

        mameDatsCache = null;
        res.json({ ok: true, version_id: versionId, total_games: totalGames });
        return;
      } finally {
        try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
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

    const gameInsert = db.prepare('INSERT OR IGNORE INTO games (name, description) VALUES (?, ?)');
    const setInsert = db.prepare('INSERT OR IGNORE INTO game_rom_sets (game_id, version_id) VALUES ((SELECT id FROM games WHERE name = ?), ?)');
    for (const name of gameNames) {
      gameInsert.bind([name, '']);
      gameInsert.step();
      gameInsert.reset();
      setInsert.bind([name, versionId]);
      setInsert.step();
      setInsert.reset();
    }
    gameInsert.free();
    setInsert.free();
    saveDb();

    res.json({ ok: true, version_id: versionId, source, version, total_games: gameNames.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// NPS (NoPayStation)
// =============================================================================

router.get('/api/versions/available', async (req, res) => {
  await dbReady;
  try {
    const source = (req.query.source || 'MAME').toUpperCase();

    if (source === 'FBNEO') {
      const fbneo = await getFBNeoVersions();
      return res.json(fbneo);
    }
    if (source === 'OFFLINELIST') {
      const offlinelist = await getOfflineListVersions();
      return res.json(offlinelist);
    }
    if (source === 'DATOMATIC') {
      const datomatic = getDatomicVersions();
      return res.json(datomatic);
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
    if (source === 'NPS') {
      const imported = all("SELECT id, source, version FROM set_versions WHERE source = 'NPS' ORDER BY version");
      const importedSet = new Set(imported.map(v => v.version));
      const available = NPS_PLATFORMS.map(p => ({
        version: p,
        source: 'NPS',
        name: NPS_PLATFORM_MAP[p].name,
        hasDlcs: NPS_PLATFORM_MAP[p].hasDlcs,
        hasUpdates: NPS_PLATFORM_MAP[p].hasUpdates,
      }));
      const missing = available.filter(v => !importedSet.has(v.version));
      return res.json({
        source: 'NPS',
        latest: NPS_PLATFORMS[0],
        hasNewer: missing.length > 0,
        available,
        imported,
        missing,
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
        const cellText = cells[0];
        const parenMatch = cellText.match(/\(([^)]+)\)/);
        const nickname = parenMatch ? parenMatch[1].trim() : null;
        const ver = cellText.replace(/\([^)]+\)/g, '').replace(/[()]/g, '').trim().split(/\s+/)[0];
        const parsed = parseMameVersion(ver);
        if (parsed[0] > 0 || parsed[1] > 0) {
          const allLinks = [...rowMatch[1].matchAll(/<a[^>]+href="([^"]+)"/gi)];
          const url = allLinks.length > 0 ? allLinks[0][1].replace(/&amp;/g, '&') : null;
          rows.push({ version: nickname || ver, parsed, numeric: ver, date: cells[1] || '', hasDat: cells[2] !== '-' && cells[2] !== '', year: cells[1].match(/(\d{4})/)?.[1] || '', url });
        }
      }
    }

    const imported = all('SELECT id, source, version, created_at FROM set_versions WHERE source = ? ORDER BY version', ['MAME']);
    const importedParsed = imported.map(v => ({ id: v.id, source: v.source, version: v.version, parsed: parseMameVersion(v.version) }));
    const availableDats = rows.filter(r => r.hasDat && !importedParsed.some(iv => cmpVersion(iv.parsed, r.parsed) === 0));
    const hasNewer = latestVer ? !importedParsed.some(iv => cmpVersion(iv.parsed, latestVer) === 0) : false;

    const _urls = {};
    for (const r of rows) {
      if (r.url) _urls[r.numeric] = r.url;
    }
    const result = {
      source: 'MAME',
      latest: latestVer ? fmtVersion(latestVer) : null, latestParsed: latestVer,
      available: sortVersions(rows.filter(r => r.hasDat).map(r => r.version)).map(ver => {
        const r = rows.find(row => row.version === ver && row.hasDat)
        return r ? { version: r.version, numeric: r.numeric, date: r.date, year: r.year, parsed: r.parsed, url: r.url } : null
      }).filter(Boolean),
      imported: importedParsed,
      missing: availableDats.map(r => ({ version: r.version, numeric: r.numeric, date: r.date, parsed: r.parsed, url: r.url })),
      hasNewer,
      _urls,
    };

    mameDatsCache = result;
    mameDatsCacheTime = Date.now();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/versions/import-nps', async (req, res) => {
  await dbReady;
  try {
    const { collection_id, platform } = req.body;
    if (!collection_id || !platform) return res.status(400).json({ error: 'collection_id and platform required' });
    if (!NPS_PLATFORM_MAP[platform]) return res.status(400).json({ error: `Invalid platform: ${platform}. Valid: ${NPS_PLATFORMS.join(', ')}` });

    const db = getDb();
    db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', ['NPS', platform]);
    const idResult = db.exec('SELECT last_insert_rowid() as id');
    const versionId = idResult[0]?.values[0]?.[0];
    if (!versionId) return res.status(500).json({ error: 'Failed to create version' });

    const result = await importNps(platform, versionId);

    run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)', [collection_id, versionId]);

    res.json({ ok: true, version_id: versionId, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
