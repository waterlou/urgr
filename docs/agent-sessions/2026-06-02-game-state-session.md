# Session 2026-06-02 (Part 2)

## Goal
Replace `game_ratings` table with `game_state` table that consolidates all frequently-changing app data.

## Changes

### Schema (`db.js`)
- New `game_state` table with columns: `game_entry_id`, `available`, `rating`, `favourite`, `play_count`, `updated_at`
- Sparse design: no row = all defaults (available=0, rating=0, favourite=0, play_count=0)
- Migration: copies existing `game_ratings` data → `game_state`, drops `game_ratings`
- Added indexes on `favourite` and `available` columns

### Routes (`games.js`)
- All `game_ratings` references → `game_state`
- JOIN simplified to always `LEFT JOIN game_state` (no conditional JOIN)
- `roms_only` filter now uses `WHERE COALESCE(r.available, 0) = 1` (SQL-level, not filesystem)
- Removed filesystem scanning code, unused `fs`/`path` imports

### Routes (`collections.js`)
- All `game_ratings` references → `game_state`
- `roms_only` filter: replaced recursive filesystem scan with `game_state.available`
- `favourites_only` filter: moved to WHERE clause (was JOIN-dependent before)
- Scan endpoint: updates `game_state.available` from `scanned_games.status` after scan
- Build endpoint: sets `game_state.available = 1` for all games after successful build

## Files changed
- `apps/rom-manager-ui/server/db.js` (+33, -12)
- `apps/rom-manager-ui/server/routes/games.js` (+18, -42)
- `apps/rom-manager-ui/server/routes/collections.js` (+24, -28)

## Benefits
- `roms_only` filter is now a SQL WHERE instead of filesystem scan
- `available` is always in sync after scan/build
- Single table for all app working data
- No UI changes needed (API response shape unchanged)

## Commands
- `bash server/test-api.sh` — 14/14 passed
- `npx playwright test` — 7/7 passed (1 skipped)
