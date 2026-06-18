import { Operation } from './index.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { dataDir } from '../paths.js';

const SNAP_URL = 'https://www.progettosnaps.net/snapshots/packs/full_sets/pS_snap_fullset_287.zip';
const TITLES_URL = 'https://www.progettosnaps.net/snapshots/packs/full_sets/pS_titles_fullset_287.zip';

const MEDIA_DIR = path.join(dataDir, 'media', 'progettosnaps');

export class ProgettoSnapsOperation extends Operation {
  constructor(collectionId, params) {
    super('progettosnaps', collectionId, params);
  }

  async downloadFile(url, destPath, onProgress) {
    const response = await fetch(url, { signal: this._abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body.getReader();
    const ws = fs.createWriteStream(destPath);
    let downloaded = 0;

    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', resolve);

      async function pump() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ws.end();
              break;
            }
            downloaded += value.length;
            if (totalSize && onProgress) {
              onProgress(downloaded, totalSize);
            }
            if (!ws.write(value)) {
              await new Promise(r => ws.once('drain', r));
            }
          }
        } catch (err) {
          ws.destroy(err);
          reject(err);
        }
      }
      pump();
    });
  }

  async extractZip(zipPath, destDir) {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  }

  async findAndExtract7z(dir, targetDir) {
    const entries = await fsp.readdir(dir, { recursive: true });
    const sevenZ = entries.find(e => e.endsWith('.7z'));
    if (!sevenZ) throw new Error('No .7z file found in extracted zip');
    const sevenZPath = path.join(dir, sevenZ);
    execSync(`7z e -y -o"${targetDir}" "${sevenZPath}"`, { stdio: 'pipe' });
  }

  async run() {
    this._abort = new AbortController();

    await fsp.mkdir(MEDIA_DIR, { recursive: true });

    const categories = [
      { name: 'snap', url: SNAP_URL, label: 'Snap Full-Set 0.287' },
      { name: 'title', url: TITLES_URL, label: 'Titles Full-Set 0.287' },
    ];

    let completed = 0;
    for (const cat of categories) {
      if (this._abort.signal.aborted) {
        this.cancel();
        return;
      }

      const targetDir = path.join(MEDIA_DIR, cat.name);
      await fsp.mkdir(targetDir, { recursive: true });

      const zipPath = path.join(MEDIA_DIR, `pS_${cat.name}.zip`);
      const tmpDir = path.join(MEDIA_DIR, `_tmp_${cat.name}`);

      try {
        const basePct = Math.round((completed / categories.length) * 100);

        this.updateProgress(basePct, `Downloading ${cat.label}...`);

        await this.downloadFile(cat.url, zipPath, (downloaded, totalSize) => {
          const dlPct = Math.round((downloaded / totalSize) * 100);
          const overallPct = basePct + Math.round(dlPct * 0.7 / categories.length);
          this.updateProgress(overallPct, `Downloading ${cat.label}... ${dlPct}%`);
        });

        const unzipPct = basePct + Math.round(70 / categories.length);
        this.updateProgress(unzipPct, `Extracting zip for ${cat.label}...`);

        await fsp.mkdir(tmpDir, { recursive: true });
        await this.extractZip(zipPath, tmpDir);

        const extractPct = basePct + Math.round(85 / categories.length);
        this.updateProgress(extractPct, `Extracting 7z for ${cat.label}...`);

        await this.findAndExtract7z(tmpDir, targetDir);

        this.updateProgress(basePct + Math.round(95 / categories.length), `Cleaning up ${cat.label}...`);

        await fsp.rm(tmpDir, { recursive: true, force: true });
        await fsp.unlink(zipPath);

      } catch (err) {
        if (err.name === 'AbortError') {
          this.cancel();
          return;
        }
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        this.fail(`Failed to download ${cat.label}: ${err.message}`);
        return;
      }

      completed++;
    }

    this.done({ categories: categories.map(c => c.name) });
  }
}
