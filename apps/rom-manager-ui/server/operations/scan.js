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

      // Update availability from scanned games
      run(`UPDATE game_state SET available = 1 WHERE game_entry_id IN (
        SELECT ge.id FROM game_entries ge
        JOIN scanned_games sg ON sg.name = ge.name AND sg.version_id = ge.version_id
        WHERE ge.version_id = ? AND sg.status = 'ok'
      )`, [version_id]);

      reloadDb();
      this.updateProgress(100, 'Scan complete');
      this.done({ exists: result.exists || 0, reused: result.reused || 0, missing: result.missing || 0 });
    } catch (err) {
      if (err.message?.includes('cancelled')) {
        this.cancel();
        return;
      }
      throw err;
    }
  }
}
