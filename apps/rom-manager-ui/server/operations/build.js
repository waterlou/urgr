import { Operation } from './index.js';
import { execCli, execCliStream } from '../cli.js';
import { all, get, run } from '../helpers.js';
import { reloadDb, getDb, saveDb } from '../db.js';
import { syncGameAvailability } from './syncAvailability.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export class BuildOperation extends Operation {
  constructor(collectionId, params) {
    super('build', collectionId, params);
  }

  async run() {
    const { version_id, dir, scan, format, import_dir } = this.params;
    this._abort = new AbortController();
    this.save();

    try {
      if (scan) {
        await this._runScan(version_id, dir);
      } else if (format === 'nps') {
        await this._runNpsBuild(version_id, import_dir);
      } else {
        await this._runDatBuild(version_id, dir);
      }
    } catch (err) {
      if (err.message?.includes('cancelled')) {
        this.cancel();
        return;
      }
      throw err;
    }
  }

  async _runScan(version_id, dir) {
    this.updateProgress(0, 'Scanning ROMs...');
    this.updateProgress(50, 'Scanning ROMs...');

    const { default: { collectionBuildScan } = {} } = await import('../routes/collections.js').catch(() => ({}));
    if (collectionBuildScan) {
      const result = await collectionBuildScan(this.collectionId, version_id);
      this.updateProgress(100, 'Scan complete');
      this.done(result);
      return;
    }

    const col = this.collectionId ? get('SELECT id, slug, folder FROM collections WHERE id = ?', [this.collectionId]) : null;
    const sv = get('SELECT source, version FROM set_versions WHERE id = ?', [version_id]);
    if (!col || !sv) throw new Error('Collection or version not found');

    const collectionDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'data', 'roms', col.folder || col.slug);
    const scanDir = dir || path.join(collectionDir, sv.version);

    const matchedNames = (() => {
      const result = execCli(['scan', String(version_id), scanDir]);
      return (result?.matches || []).map(m => m.name);
    })();

    run('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);

    if (matchedNames.length > 0) {
      const ph = matchedNames.map(() => '?').join(',');
      run(`UPDATE game_rom_sets SET available = 1
        WHERE version_id = ? AND game_id IN (
          SELECT g.id FROM games g WHERE g.name IN (${ph})
        )`, [version_id, ...matchedNames]);
    }

    const gameIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id);
    syncGameAvailability(gameIds);

    const total = get('SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id = ?', [version_id]).c;
    const matched = get('SELECT COUNT(*) as c FROM game_rom_sets WHERE version_id = ? AND available = 1', [version_id]).c;

    let reused = 0;
    const priorVersions = all('SELECT DISTINCT sv.version, sv.id FROM set_versions sv JOIN collection_versions cv ON cv.version_id = sv.id WHERE cv.collection_id = ? AND sv.id < ? ORDER BY sv.id', [this.collectionId, version_id]);
    if (priorVersions.length > 0 && fs.existsSync(collectionDir)) {
      const currentNames = new Set(all('SELECT DISTINCT g.name FROM games g JOIN game_rom_sets grs ON grs.game_id = g.id WHERE grs.version_id = ?', [version_id]).map(r => r.name));
      for (const pv of priorVersions) {
        const pvRoms = path.join(collectionDir, pv.version, 'roms');
        if (!fs.existsSync(pvRoms)) continue;
        try {
          const readDir = (d) => {
            const results = [];
            for (const e of fs.readdirSync(d)) {
              const fp = path.join(d, e);
              if (fs.statSync(fp).isDirectory()) results.push(...readDir(fp));
              else if (e.endsWith('.zip')) results.push(path.basename(e, '.zip'));
            }
            return results;
          };
          const priorFiles = readDir(pvRoms);
          for (const stem of priorFiles) {
            if (currentNames.has(stem)) reused++;
          }
        } catch {}
      }
    }

    this.updateProgress(100, 'Scan complete');
    this.done({ exists: matched - reused, reused, missing: total - matched });
  }

  async _runNpsBuild(version_id, import_dir) {
    this.updateProgress(0, 'Building NPS ROMs...');

    const result = execCli(['build', '--version', version_id, '--input-dir', import_dir]);

    reloadDb();
    this.updateProgress(100, 'Build complete');
    this.done({ built: result.built || 0, skipped: result.skipped || 0 });
  }

  async _runDatBuild(version_id, dir) {
    this.updateProgress(0, 'Starting build...');

    const result = await execCliStream(['scan', version_id, dir], {
      binary: 'build',
      signal: this._abort.signal,
      onProgress: (p) => {
        this.updateProgress(p.pct || 0, `${p.phase}: ${p.msg || ''}`);
      },
    });

    run('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);

    if (dir && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
      const names = files.map(f => path.basename(f, '.zip'));
      if (names.length > 0) {
        const ph = names.map(() => '?').join(',');
        run(`UPDATE game_rom_sets SET available = 1
          WHERE version_id = ? AND game_id IN (
            SELECT g.id FROM games g WHERE g.name IN (${ph})
          )`, [version_id, ...names]);
      }
    }

    const gameIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id);
    syncGameAvailability(gameIds);

    reloadDb();
    this.updateProgress(100, 'Build complete');
    this.done({
      matched: result.matched || result.games_built || 0,
      missing: result.missing || result.games_missing || 0,
    });
  }
}
