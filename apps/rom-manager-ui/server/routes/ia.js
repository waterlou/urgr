import { Router } from 'express';
import path from 'path';
import { get, dbReady } from '../helpers.js';
import { getAuth, isAuthenticated, setAuth, clearAuth, getCookieHeader } from '../ia-auth.js';
import { romsDir } from '../paths.js';

const router = Router();

// =============================================================================
// IA authentication endpoints
// =============================================================================
router.get('/api/ia/auth', (req, res) => {
  try {
    const auth = getAuth();
    if (auth) {
      res.json({ authenticated: true, screenname: auth.screenname, username: auth.username });
    } else {
      res.json({ authenticated: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/ia/auth', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const result = await setAuth(username, password);
    res.json({ ok: true, screenname: result.screenname });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

router.delete('/api/ia/auth', (req, res) => {
  clearAuth();
  res.json({ ok: true });
});

// =============================================================================
// Remote ZIP file listing and extraction
// =============================================================================
async function fetchWithCookies(url, options = {}) {
  const cookieHeader = getCookieHeader();
  if (cookieHeader) {
    options.headers = { ...options.headers, Cookie: cookieHeader };
  }
  return fetch(url, options);
}

router.post('/api/ia/list', async (req, res) => {
  try {
    const { url, pattern } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const { RemoteZip } = await import('../remote-zip.js');
    const rz = new RemoteZip(url, fetchWithCookies);
    const files = await rz.listFiles(pattern);
    res.json({ files: files.map(f => ({ name: f.name, size: f.uncompressedSize })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/ia/download', async (req, res) => {
  await dbReady;
  try {
    const { url, entry, collection_id } = req.body;
    if (!url || !entry) return res.status(400).json({ error: 'url and entry required' });
    const baseDir = romsDir;
    let dest = path.join(baseDir, entry.replace(/^roms\//, ''));
    if (collection_id) {
      const col = get('SELECT id, folder, slug FROM collections WHERE id = ?', [collection_id]);
      if (col?.folder) dest = path.join(baseDir, col.folder, entry.replace(/^roms\//, ''));
      else if (col?.slug) dest = path.join(baseDir, col.slug, entry.replace(/^roms\//, ''));
    }
    const { RemoteZip } = await import('../remote-zip.js');
    const rz = new RemoteZip(url, fetchWithCookies);
    const result = await rz.extractToFile(entry, dest);
    res.json({ ok: true, ...result, path: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
