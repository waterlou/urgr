import { run } from '../helpers.js';

const CHUNK = 500;

export function syncGameAvailability(gameIds) {
  if (!gameIds || gameIds.length === 0) return;
  for (let i = 0; i < gameIds.length; i += CHUNK) {
    const chunk = gameIds.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    run(`UPDATE game_state SET
      available = COALESCE((SELECT MAX(available) FROM game_rom_sets WHERE game_id = game_state.game_id), 0),
      updated_at = datetime('now')
    WHERE game_id IN (${ph})`, chunk);
  }
}
