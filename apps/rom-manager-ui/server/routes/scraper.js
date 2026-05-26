import { Router } from 'express';
import { execCli } from '../cli.js';
import { dbReady } from '../helpers.js';

const router = Router();

router.post('/api/scraper/search', async (req, res) => {
  try {
    const { query, platform } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const args = ['search', query];
    if (platform) args.push('--platform', platform);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/scraper/scrape', async (req, res) => {
  try {
    const { file, game_name, platform } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    const args = ['scrape', file];
    if (game_name) args.push('--name', game_name);
    if (platform) args.push('--platform', platform);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/scraper/hash', async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    const result = execCli(['hash', file], { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/scraper/detail', async (req, res) => {
  try {
    const { game_id, source } = req.body;
    if (!game_id) return res.status(400).json({ error: 'game_id required' });
    const args = ['detail', game_id];
    if (source) args.push('--source', source);
    const result = execCli(args, { binary: 'scraper' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
