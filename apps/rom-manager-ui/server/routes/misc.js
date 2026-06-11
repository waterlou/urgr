import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { getJob, cancelJob } from '../jobs.js';
import { get, dbReady } from '../helpers.js';
import { setAuth, clearAuth } from '../ia-auth.js';
import { envFile } from '../paths.js';

const router = Router();

// =============================================================================
// Jobs (SSE progress streams)
// =============================================================================
router.get('/api/jobs/:jobId', (req, res) => {
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

router.post('/api/jobs/:jobId/cancel', (req, res) => {
  const ok = cancelJob(req.params.jobId);
  res.json({ ok });
});

// =============================================================================
// Settings (read/write .env)
// =============================================================================

const SETTINGS_PATH = envFile;
const SETTINGS_KEYS = [
  'SS_DEVID', 'SS_DEVPASSWORD', 'SS_USERNAME', 'SS_PASSWORD',
  'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET',
  'TGDB_API_KEY',
  'SCRAPER_SOURCE',
  'IA_USERNAME', 'IA_PASSWORD',
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

router.get('/api/settings', async (req, res) => {
  try {
    res.json(readEnvFile());
  } catch (e) {
    console.error('GET /api/settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/settings', async (req, res) => {
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

    // Live-reload IA auth if credentials changed
    if ('IA_USERNAME' in updates || 'IA_PASSWORD' in updates) {
      const user = current.IA_USERNAME || '';
      const pass = current.IA_PASSWORD || '';
      if (user && pass) {
        setAuth(user, pass).then(() => {
          console.log('[settings] IA login successful');
        }).catch(e => {
          console.error('[settings] IA login failed:', e.message);
        });
      } else {
        clearAuth();
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/settings/test-tgdb', async (req, res) => {
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

router.post('/api/settings/test-igdb', async (req, res) => {
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

export default router;
