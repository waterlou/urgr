import { Operation } from './index.js';
import { execCli } from '../cli.js';
import { reloadDb } from '../db.js';

export class VerifyOperation extends Operation {
  constructor(collectionId, params) {
    super('verify', collectionId, params);
  }

  async run() {
    const { version_id, dir, fallback_id } = this.params;
    this._abort = new AbortController();
    this.save();
    this.updateProgress(0, 'Verifying ROMs...');

    try {
      const args = ['verify', version_id, dir];
      if (fallback_id) args.push('--fallback', fallback_id);

      const result = execCli(args);

      reloadDb();
      this.updateProgress(100, 'Verification complete');
      this.done({
        verified: result.verified || 0,
        missing: result.missing || 0,
        corrupted: result.corrupted || 0,
      });
    } catch (err) {
      if (err.message?.includes('cancelled')) {
        this.cancel();
        return;
      }
      throw err;
    }
  }
}
