import { Operation } from './index.js';
import { all } from '../helpers.js';

export class ExportOperation extends Operation {
  constructor(collectionId, params) {
    super('export', collectionId, params);
  }

  async run() {
    const { version_id, format } = this.params;
    this._abort = new AbortController();
    this.save();
    this.updateProgress(0, 'Exporting...');

    try {
      const games = all(`SELECT g.*, sv.source, sv.version
        FROM games g
        JOIN game_rom_sets grs ON grs.game_id = g.id
        JOIN set_versions sv ON sv.id = grs.version_id
        WHERE grs.version_id = ?`, [version_id]);

      this.updateProgress(50, `Processing ${games.length} games...`);

      const manifest = {
        version_id,
        format: format || 'json',
        total: games.length,
        exported_at: new Date().toISOString(),
        games: games.map(g => ({
          name: g.name,
          description: g.description,
          year: g.year,
          manufacturer: g.manufacturer,
          platform: g.platform,
          source: g.source,
          version: g.version,
        })),
      };

      this.updateProgress(100, 'Export complete');
      this.done(manifest);
    } catch (err) {
      throw err;
    }
  }
}
