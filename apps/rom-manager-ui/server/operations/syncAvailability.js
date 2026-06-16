import { run } from '../helpers.js';

export function syncGameAvailability(gameIds) {
  if (!gameIds || gameIds.length === 0) return;
  const ph = gameIds.map(() => '?').join(',');
  run(`UPDATE game_state SET
    available = COALESCE((SELECT MAX(available) FROM game_rom_sets WHERE game_id = game_state.game_id), 0),
    updated_at = datetime('now')
  WHERE game_id IN (${ph})`, gameIds);
}
