import { Operation } from './index.js';
import { all, run } from '../helpers.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class ScrapeOperation extends Operation {
  constructor(collectionId, params) {
    super('scrape', collectionId, params);
  }

  async run() {
    const { gameIds } = this.params;
    this._abort = new AbortController();
    this.save();

    // Import scrapeSingleGame lazily to avoid circular deps
    const { scrapeSingleGame } = await import('../routes/games.js');

    // Pick a collection version to pass context (for source priority)
    const versions = all('SELECT id as version_id FROM set_versions WHERE collection_id = ? ORDER BY id DESC LIMIT 1', [this.collectionId]);

    // Find unscraped games
    let games;
    if (gameIds && gameIds.length > 0) {
      games = gameIds.map(id => ({ id }));
    } else {
      games = all(`SELECT DISTINCT g.id FROM games g
        JOIN game_rom_sets grs ON grs.game_id = g.id
                WHERE grs.version_id IN (SELECT id FROM set_versions WHERE collection_id = ?) AND (g.manufacturer IS NULL OR g.manufacturer = '' OR g.year IS NULL OR g.year = '')
        ORDER BY g.name`, [this.collectionId]);
    }

    const total = games.length;
    if (total === 0) {
      this.done({ total: 0, scraped: 0, skipped: 0, failed: 0 });
      return;
    }

    let scraped = 0, skipped = 0, failed = 0;
    const errors = [];

    this.updateProgress(0, `Scraping 0/${total}...`);

    for (let i = 0; i < games.length; i++) {
      if (this._abort.signal.aborted) {
        this.cancel();
        return;
      }

      const gid = games[i].id;
      try {
        const versionId = versions.length > 0 ? versions[0].version_id : undefined;
        const result = await scrapeSingleGame(gid, versionId);
        if (result.scraped) scraped++;
        else skipped++;
        this.updateProgress(Math.round(((i + 1) / total) * 100), `[${i + 1}/${total}] ${result.scraped ? 'scraped' : 'skipped'} ${result.title || ''}`);
      } catch (err) {
        failed++;
        errors.push({ gameId: gid, error: err.message });
        this.updateProgress(Math.round(((i + 1) / total) * 100), `[${i + 1}/${total}] failed: ${err.message}`);
        // Check for rate limiting
        if (err.message?.includes('429') || err.message?.includes('rate limit')) {
          this.updateProgress(Math.round(((i + 1) / total) * 100), 'Rate limited, stopping...');
          break;
        }
      }

      // Rate limit: wait between requests
      if (i < games.length - 1) await sleep(3000);
    }

    this.done({ total, scraped, skipped, failed, errors });
  }
}
