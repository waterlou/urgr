# Session: TheGamesDB as default provider with bundled API key

## Goal
Make TheGamesDB the default scraper provider that works out-of-the-box without any user configuration (no `.env`, no env vars).

## Changes

### Rust (rom-scraper library)
- **`libs/rom-scraper/src/config.rs`**:
  - Added `DEFAULT_TGDB_API_KEY` constant with bundled key
  - `Config::default()` now sets `thegamesdb: Some(...)` with the bundled key instead of `None`
  - Source priority changed: TheGamesDb → 100 (first), ScreenScraper → 200, IGDB → 300
  - Updated test to reflect that thegamesdb is always configured by default

- **`libs/rom-scraper/src/sources/thegamesdb.rs`**:
  - Fixed API base URL from broken `v1.3` to working `v1`
  - Removed `BoxartData` struct (wrong JSON path)
  - Added `fetch_boxart()` method using `serde_json::Value` to properly parse boxart from `include.boxart.data.<game_id>` path
  - Removed unused `boxart_url()` method
  - Boxart now correctly fetched from TheGamesDB response

### Rust (scraper-cli)
- **`apps/scraper-cli/src/main.rs`**:
  - `build_config()`: `TGDB_API_KEY` env var now overrides the bundled default instead of being required
  - `parse_source()` final fallback changed from `ScreenScraper` to `TheGamesDb`
  - `cmd_detail()` default changed from `ScreenScraper` to `TheGamesDb`
  - Help text updated: default listed as `thegamesdb`, `TGDB_API_KEY` marked as optional

### UI
- **`apps/rom-manager-ui/src/components/Settings.jsx`**:
  - `TGDB_API_KEY` field: `required: false` with placeholder "Default key active — enter to override"
  - Default `SCRAPER_SOURCE` changed from `'screenscraper'` to `'thegamesdb'`
  - SOURCE_OPTIONS reordered: TheGamesDB first

## Commands Run
- `cargo build -p scraper-cli` (multiple iterations)
- `cargo run -p scraper-cli -- search "Super Mario Bros" --platform nes` — verified search works without any config
- `cargo run -p scraper-cli -- detail 104883` — verified detail works with boxart
- `TGDB_API_KEY=test_key_override cargo run -p scraper-cli -- hash Cargo.toml` — verified env var override still works
- `cargo run -p scraper-cli -- search "test" --source screenscraper` — verified `--source` flag still works
- `cargo test -p rom-scraper` — all 27 tests pass
- `npm run build` (in rom-manager-ui) — UI build succeeds

## Key Decisions
- TheGamesDB API key is bundled in source code (same approach as EmuStation/RetroArch bundle ScreenScraper dev credentials)
- Users can override with `TGDB_API_KEY` env var or via Settings UI (saves to `data/.env`)
- `--source` flag and `SCRAPER_SOURCE` env var still work to select other providers
- ScreenScraper and IGDB remain unchanged — still work if configured
