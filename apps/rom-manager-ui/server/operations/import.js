import { Operation } from './index.js';
import { execCli } from '../cli.js';
import { all, run } from '../helpers.js';
import { reloadDb } from '../db.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export class ImportOperation extends Operation {
  constructor(collectionId, params) {
    super('import', collectionId, params);
  }

  async run() {
    const { version, source, refresh } = this.params;
    this._abort = new AbortController();
    this.save();
    this.updateProgress(0, `Importing ${source} ${version}...`);

    try {
      if (source === 'NPS') {
        await this._importNps();
      } else {
        await this._importDat();
      }
    } catch (err) {
      if (err.message?.includes('cancelled')) {
        this.cancel();
        return;
      }
      throw err;
    }
  }

  async _importNps() {
    const { platform } = this.params;
    this.updateProgress(10, 'Downloading TSV...');

    // Import NPS using the CLI
    const result = execCli(['import-nps', platform], { binary: 'nps' });

    reloadDb();
    this.updateProgress(100, 'Import complete');
    this.done({ version_id: result.version_id, total_games: result.games_inserted || 0 });
  }

  async _importDat() {
    const { version, source, refresh } = this.params;
    this.updateProgress(10, 'Downloading DAT...');

    // For now, delegate to the existing import logic via CLI
    // This handles FBNeo, MAME, OfflineList, DAT-O-MATIC
    const args = ['import-dat', version, source];
    if (refresh) args.push('--refresh');

    const result = execCli(args, { binary: 'parse' });

    if (result?.version_id) {
      // Link to collection
      run('INSERT OR IGNORE INTO collection_versions (collection_id, version_id) VALUES (?, ?)',
        [this.collectionId, result.version_id]);
    }

    reloadDb();
    this.updateProgress(100, 'Import complete');
    this.done({ version_id: result?.version_id, total_games: result?.games_inserted || 0 });
  }
}
