import { Router } from 'express';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { dbReady } from '../helpers.js';
import { dataDir } from '../paths.js';

const router = Router();

const ALLOWED_ROOTS = [
  os.homedir(),
  path.dirname(os.homedir()),
  path.join(dataDir, 'roms'),
  '/tmp',
];

// macOS: add /Volumes for external drives
if (os.platform() === 'darwin') {
  ALLOWED_ROOTS.push('/Volumes');
}

function isPathAllowed(resolvedPath) {
  for (const root of ALLOWED_ROOTS) {
    // Check if resolvedPath starts with the root (followed by separator or exact match)
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

function expandPath(p) {
  // Handle ~/ and ~ expansion
  if (p.startsWith('~')) {
    return path.resolve(os.homedir(), p.slice(1).replace(/^[/\\]/, ''));
  }
  // Relative path → resolve against home
  if (!path.isAbsolute(p)) {
    return path.resolve(os.homedir(), p);
  }
  return path.resolve(p);
}

router.get('/api/filesystem/browse', async (req, res) => {
  try {
    await dbReady;
    const rawPath = req.query.path || os.homedir();
    const resolved = expandPath(rawPath);

    if (!isPathAllowed(resolved)) {
      return res.status(403).json({
        error: 'Path not in allowed roots',
        allowed_roots: ALLOWED_ROOTS,
      });
    }

    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(400).json({ error: 'Path does not exist' });
      }
      if (e.code === 'EACCES') {
        return res.status(403).json({ error: 'Permission denied' });
      }
      throw e;
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      const dirEntries = await fsp.readdir(resolved, { withFileTypes: true });
      entries = dirEntries
        .filter(e => !e.name.startsWith('.') && e.name !== '..')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical within each group
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch (e) {
      if (e.code === 'EACCES') {
        return res.status(403).json({ error: 'Permission denied reading directory' });
      }
      throw e;
    }

    // Compute parent path (null if at an allowed root boundary and parent is not allowed)
    const parent = path.dirname(resolved);
    const parentAllowed = parent !== resolved && isPathAllowed(parent) ? parent : null;

    res.json({ path: resolved, parent: parentAllowed, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
