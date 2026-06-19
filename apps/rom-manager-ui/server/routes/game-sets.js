import { Router } from 'express';
import { getDb, saveDb } from '../db.js';
import { all, get, run, dbReady } from '../helpers.js';

const router = Router();

router.get('/api/game-sets', async (req, res) => {
  await dbReady;
  try {
    const sets = all('SELECT gs.*, (SELECT COUNT(*) FROM game_set_games WHERE game_set_id = gs.id) as total_games FROM game_sets gs ORDER BY gs.name');
    res.json(sets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/game-sets', async (req, res) => {
  await dbReady;
  try {
    const { name, description, icon, platforms } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    run('INSERT INTO game_sets (name, description, icon, platforms) VALUES (?, ?, ?, ?)', [name, description || '', icon || '', platforms || '']);
    res.status(201).json(get('SELECT * FROM game_sets WHERE name = ? ORDER BY id DESC', [name]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/game-sets/:id', async (req, res) => {
  await dbReady;
  try {
    const { name, description, icon, platforms } = req.body;
    const sets = []; const vals = [];
    if (name != null) { sets.push('name = ?'); vals.push(name); }
    if (description != null) { sets.push('description = ?'); vals.push(description); }
    if (icon != null) { sets.push('icon = ?'); vals.push(icon); }
    if (platforms != null) { sets.push('platforms = ?'); vals.push(platforms); }
    if (sets.length) { vals.push(req.params.id); run(`UPDATE game_sets SET ${sets.join(', ')} WHERE id = ?`, vals); }
    res.json(get('SELECT * FROM game_sets WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/game-sets/:id', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM game_sets WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/game-sets/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { id } = req.params;
    const { limit = 200, offset = 0, sort = 'name', order = 'asc' } = req.query;
    const gameSet = get('SELECT * FROM game_sets WHERE id = ?', [id]);
    if (!gameSet) return res.status(404).json({ error: 'not found' });
    const sortCol = sort === 'rating' ? 'COALESCE(gs.rating, 0)' : sort === 'favourite' ? 'COALESCE(gs.favourite, 0)' : sort === 'play_count' ? 'COALESCE(gs.play_count, 0)' : 'g.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';
    const total = get('SELECT COUNT(*) as c FROM game_set_games WHERE game_set_id = ?', [id]).c;
    const games = all(`
      SELECT g.*, parent_g.name as cloneof, sv_min.version, COALESCE(gs.rating, 0) as rating, COALESCE(gs.favourite, 0) as favourite, COALESCE(gs.play_count, 0) as play_count
      FROM game_set_games gsg
      JOIN games g ON g.id = gsg.game_id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      LEFT JOIN game_state gs ON gs.game_id = g.id
      LEFT JOIN game_rom_sets grs ON grs.id = (SELECT grs2.id FROM game_rom_sets grs2 WHERE grs2.game_id = g.id ORDER BY grs2.version_id LIMIT 1)
      LEFT JOIN set_versions sv_min ON sv_min.id = grs.version_id
      WHERE gsg.game_set_id = ? AND (g.runnable != 0 OR g.runnable IS NULL)
      ORDER BY ${sortCol} ${sortDir}, g.name LIMIT ? OFFSET ?
    `, [id, Number(limit), Number(offset)]);
    const size = get(`SELECT SUM(grf.size) as total_bytes
      FROM game_set_games gsg
      JOIN games g ON g.id = gsg.game_id
      JOIN game_rom_sets grs ON grs.game_id = g.id
      JOIN game_rom_files grf ON grf.rom_set_id = grs.id
      WHERE gsg.game_set_id = ?`, [id]);
    res.json({ game_set: gameSet, games, total, total_size: size?.total_bytes || 0, limit: Number(limit), offset: Number(offset) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/game-sets/:id/games', async (req, res) => {
  await dbReady;
  try {
    const { game_entry_ids } = req.body;
    if (!game_entry_ids?.length) return res.status(400).json({ error: 'game_entry_ids required' });
    const insert = getDb().prepare('INSERT OR IGNORE INTO game_set_games (game_set_id, game_id) VALUES (?, ?)');
    for (const gid of game_entry_ids) { insert.bind([req.params.id, gid]); insert.step(); insert.reset(); }
    insert.free();
    saveDb();
    res.json({ ok: true, added: game_entry_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/game-sets/:id/games/:gameId', async (req, res) => {
  await dbReady;
  try {
    run('DELETE FROM game_set_games WHERE game_set_id = ? AND game_id = ?', [req.params.id, req.params.gameId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/game-sets/:id/exports', async (req, res) => {
  await dbReady;
  try {
    const gs = get('SELECT * FROM game_sets WHERE id = ?', [req.params.id]);
    if (!gs) return res.status(404).json({ error: 'not found' });
    const games = all(`
      SELECT g.name, g.description, g.year, g.manufacturer, parent_g.name as cloneof, c.dataset_preset as source, sv.version, grf.size
      FROM game_set_games gsg
      JOIN games g ON g.id = gsg.game_id
      JOIN collections c ON c.id = g.collection_id
      LEFT JOIN games parent_g ON parent_g.id = g.parent_game_id
      LEFT JOIN game_rom_sets grs ON grs.game_id = g.id AND grs.id = (SELECT MIN(id) FROM game_rom_sets WHERE game_id = g.id)
      LEFT JOIN set_versions sv ON sv.id = grs.version_id
      LEFT JOIN game_rom_files grf ON grf.rom_set_id = grs.id AND grf.id = (SELECT MIN(id) FROM game_rom_files WHERE rom_set_id = grs.id)
      WHERE gsg.game_set_id = ? ORDER BY g.name
    `, [req.params.id]);
    res.json({ game_set: gs, games, total_games: games.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
