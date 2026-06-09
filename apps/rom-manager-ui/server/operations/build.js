import { Operation } from './index.js';
import { execCli, execCliStream } from '../cli.js';
import { all, get, run } from '../helpers.js';
import { reloadDb, getDb, saveDb } from '../db.js';
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

    // Delegate to the original build/scan endpoint logic
    // This preserves the exact exist/reused counting from the original code
    const { default: { collectionBuildScan } = {} } = await import('../routes/collections.js').catch(() => ({}));
    if (collectionBuildScan) {
      const result = await collectionBuildScan(this.collectionId, version_id);
      this.updateProgress(100, 'Scan complete');
      this.done(result);
      return;
    }

    // Fallback: run the scan directly with original logic
    const col = this.collectionId ? get('SELECT id, slug, folder FROM collections WHERE id = ?', [this.collectionId]) : null;
    const sv = get('SELECT source, version FROM set_versions WHERE id = ?', [version_id]);
    if (!col || !sv) throw new Error('Collection or version not found');

    const collectionDir = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'data', 'roms', col.folder || col.slug);
    const scanDir = dir || path.join(collectionDir, sv.version);

    // Reset availability
    run('UPDATE game_state SET available = 0 WHERE game_entry_id IN (SELECT id FROM game_entries WHERE version_id = ?)', [version_id]);

    execCli(['scan', String(version_id), scanDir]);
    reloadDb();

    // Update availability from scanned games (same as original code)
    run(`INSERT INTO game_state (game_entry_id, available, updated_at)
      SELECT ge.id, 1, datetime('now')
      FROM game_entries ge
      JOIN scanned_games sg ON sg.version_id = ge.version_id AND sg.name = ge.name
      WHERE ge.version_id = ? AND sg.filename != ''
      ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')`, [version_id]);
    run(`INSERT INTO game_state (game_entry_id, available, updated_at)
      SELECT ge.id, 0, datetime('now')
      FROM game_entries ge
      LEFT JOIN scanned_games sg ON sg.version_id = ge.version_id AND sg.name = ge.name
      WHERE ge.version_id = ? AND (sg.filename IS NULL OR sg.filename = '')
      ON CONFLICT(game_entry_id) DO UPDATE SET available = 0, updated_at = datetime('now')`, [version_id]);

    // Count results
    const total = get('SELECT COUNT(*) as c FROM game_entries WHERE version_id = ?', [version_id]).c;
    const matched = get('SELECT COUNT(*) as c FROM game_entries ge JOIN game_state gs ON gs.game_entry_id = ge.id WHERE ge.version_id = ? AND gs.available = 1', [version_id]).c;

    // Calculate reuse: check if matched files exist in prior version dirs
    let reused = 0;
    const priorVersions = all('SELECT DISTINCT sv.version, sv.id FROM set_versions sv JOIN collection_versions cv ON cv.version_id = sv.id WHERE cv.collection_id = ? AND sv.id < ? ORDER BY sv.id', [this.collectionId, version_id]);
    if (priorVersions.length > 0 && fs.existsSync(collectionDir)) {
      const matchedGames = all('SELECT name FROM scanned_games WHERE version_id = ? AND filename != ?', [version_id, '']);
      for (const game of matchedGames) {
        for (const pv of priorVersions) {
          const pvRoms = path.join(collectionDir, pv.version, 'roms');
          if (!fs.existsSync(pvRoms)) continue;
          try {
            const found = fs.readdirSync(pvRoms, { recursive: true }).some(f => path.basename(f) === `${game.name}.zip`);
            if (found) { reused++; break; }
          } catch {}
        }
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

    // Update game_state availability
    run('UPDATE game_state SET available = 0 WHERE game_entry_id IN (SELECT id FROM game_entries WHERE version_id = ?)', [version_id]);

    // Scan output directory for .zip files
    if (dir && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
      for (const f of files) {
        const name = path.basename(f, '.zip');
        run('UPDATE game_state SET available = 1 WHERE game_entry_id IN (SELECT id FROM game_entries WHERE name = ? AND version_id = ?)', [name, version_id]);
      }
    }

    reloadDb();
    this.updateProgress(100, 'Build complete');
    this.done({
      matched: result.matched || result.games_built || 0,
      missing: result.missing || result.games_missing || 0,
    });
  }
}
