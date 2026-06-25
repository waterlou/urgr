import { run } from '../helpers.js';

const CHUNK = 500;

export function syncGameAvailability(gameIds) {
  if (!gameIds || gameIds.length === 0) return;
  for (let i = 0; i < gameIds.length; i += CHUNK) {
    const chunk = gameIds.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    // Create game_state rows for available games (don't insert unavailable ones)
    run(`INSERT OR IGNORE INTO game_state (game_id, available)
      SELECT game_id, 1 FROM game_rom_sets
      WHERE game_id IN (${ph}) AND available = 1`, chunk);
    // Sync available flag for all existing game_state rows (including
    // those from user actions like rating/favourite that have no rom_set)
    run(`UPDATE game_state SET
      available = COALESCE((SELECT MAX(available) FROM game_rom_sets WHERE game_id = game_state.game_id), 0),
      updated_at = datetime('now')
    WHERE game_id IN (${ph})`, chunk);
  }
}
