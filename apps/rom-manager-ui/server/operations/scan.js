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
      // Reset availability
      run('UPDATE game_state SET available = 0 WHERE game_entry_id IN (SELECT id FROM game_entries WHERE version_id = ?)', [version_id]);

      const result = execCli(['scan', version_id, dir]);

      // Update availability from scan result JSON
      const matchedNames = (result?.matches || []).map(m => m.name);
      if (matchedNames.length > 0) {
        const ph = matchedNames.map(() => '?').join(',');
        run(`INSERT INTO game_state (game_entry_id, available, updated_at)
          SELECT ge.id, 1, datetime('now') FROM game_entries ge
          WHERE ge.version_id = ? AND ge.name IN (${ph})
          ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')`, [version_id, ...matchedNames]);
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
