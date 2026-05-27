import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { get, dbReady } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.post('/api/ia/list', async (req, res) => {
  try {
    const { url, pattern } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const { RemoteZip } = await import('../remote-zip.js');
    const rz = new RemoteZip(url);
    const files = await rz.listFiles(pattern);
    res.json({ files: files.map(f => ({ name: f.name, size: f.uncompressedSize })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/ia/download', async (req, res) => {
  await dbReady;
  try {
    const { url, entry, collection_id } = req.body;
    if (!url || !entry) return res.status(400).json({ error: 'url and entry required' });
    const baseDir = path.join(__dirname, '..', '..', '..', 'data', 'roms');
    let dest = path.join(baseDir, entry.replace(/^roms\//, ''));
    console.log('[ia-download] collection_id:', collection_id);
    if (collection_id) {
      const col = get('SELECT id, folder, slug FROM collections WHERE id = ?', [collection_id]);
      console.log('[ia-download] collection query result:', JSON.stringify(col));
      if (col?.folder) dest = path.join(baseDir, col.folder, entry.replace(/^roms\//, ''));
      else if (col?.slug) dest = path.join(baseDir, col.slug, entry.replace(/^roms\//, ''));
      console.log('[ia-download] resolved dest:', dest);
    }
    const { RemoteZip } = await import('../remote-zip.js');
    const rz = new RemoteZip(url);
    const result = await rz.extractToFile(entry, dest);
    res.json({ ok: true, ...result, path: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
