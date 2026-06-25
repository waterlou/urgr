import { run } from '../helpers.js';

const CHUNK = 500;

export function syncGameAvailability(gameIds) {
  if (!gameIds || gameIds.length === 0) return;
  for (let i = 0; i < gameIds.length; i += CHUNK) {
    const chunk = gameIds.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    // Ensure game_state rows exist (fresh imports have no game_state rows)
    const vph = chunk.map(() => '(?)').join(',');
    run(`INSERT OR IGNORE INTO game_state (game_id) VALUES ${vph}`, chunk);
    // Sync available flag from game_rom_sets
    run(`UPDATE game_state SET
      available = COALESCE((SELECT MAX(available) FROM game_rom_sets WHERE game_id = game_state.game_id), 0),
      updated_at = datetime('now')
    WHERE game_id IN (${ph})`, chunk);
  }
}
