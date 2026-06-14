import { Operation } from './index.js';
import { execCli } from '../cli.js';
import { run } from '../helpers.js';
import { reloadDb } from '../db.js';

export class ScanOperation extends Operation {
  constructor(collectionId, params) {
    super('scan', collectionId, params);
  }

  async run() {
    const { version_id, dir } = this.params;
    this._abort = new AbortController();
    this.save();
    this.updateProgress(0, 'Scanning ROMs...');

    try {
      run('UPDATE game_state SET available = 0 WHERE game_id IN (SELECT game_id FROM game_rom_sets WHERE version_id = ?)', [version_id]);

      const result = execCli(['scan', version_id, dir]);

      const matchedNames = (result?.matches || []).map(m => m.name);
      if (matchedNames.length > 0) {
        const ph = matchedNames.map(() => '?').join(',');
        run(`INSERT INTO game_state (game_id, available, updated_at)
          SELECT g.id, 1, datetime('now') FROM games g
          JOIN game_rom_sets grs ON grs.game_id = g.id
          WHERE grs.version_id = ? AND g.name IN (${ph})
          ON CONFLICT(game_id) DO UPDATE SET available = 1, updated_at = datetime('now')`, [version_id, ...matchedNames]);
      }

      reloadDb();
      this.updateProgress(100, 'Scan complete');
      this.done({ exists: result.matched || result.matched_games || 0, reused: 0, missing: result.missing || result.missing_games || 0 });
    } catch (err) {
      if (err.message?.includes('cancelled')) {
        this.cancel();
        return;
      }
      throw err;
    }
  }
}
