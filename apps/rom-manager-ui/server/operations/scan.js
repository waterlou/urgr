import { Operation } from './index.js';
import { execCli } from '../cli.js';
import { all, run } from '../helpers.js';
import { reloadDb } from '../db.js';
import { syncGameAvailability } from './syncAvailability.js';

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
      const result = execCli(['scan', version_id, dir]);

      run('UPDATE game_rom_sets SET available = 0 WHERE version_id = ?', [version_id]);

      const matchedIds = [...new Set((result?.matches || []).map(m => m.game_id).filter(id => id != null))];
      if (matchedIds.length > 0) {
        const ph = matchedIds.map(() => '?').join(',');
        run(`UPDATE game_rom_sets SET available = 1
          WHERE version_id = ? AND game_id IN (${ph})`, [version_id, ...matchedIds]);
      }

      const gameIds = all('SELECT game_id FROM game_rom_sets WHERE version_id = ?', [version_id]).map(r => r.game_id);
      syncGameAvailability(gameIds);

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
