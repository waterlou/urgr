# Session: Translations & Scrapers

**Date:** 2026-06-22

## Goal
Integrate region-specific game title translations into the ROM Manager: scrape localized titles from ScreenScraper, generate a `translations.json` file, and display them in the UI. Also fixed ScreenScraper's `noms` parsing and added `region_titles` to the Rust data model.

## Files Changed

### Rust (libs/rom-scraper)
- `src/models.rs` — Added `region_titles: HashMap<String, String>` to `Game` struct
- `src/sources/screenscraper.rs` — Fixed `noms` parsing: the API returns JSON objects (`{"text":"...","region":"ja","langue":"ja"}`) not plain strings. Now correctly extracts region-tagged names into `region_titles`
- `src/lib.rs` — Export `region_titles` in all `Game` constructors

### Rust (apps/scraper-cli)
- `src/main.rs` — Added `region_titles` field to `SearchResult`, `ScrapeMatch`, `DetailOutput` structs

### Scripts
- `scripts/build-translations.mjs` — New standalone script that reads all games from SQLite via sql.js, calls `scraper-cli search --source screenscraper` per game with rate limiting, and writes `data/translations.json`. Supports `--resume`, `--limit`, `--delay`. Requires ScreenScraper credentials (`SS_DEVID`, `SS_DEVPASSWORD`). **Blocked** — user has no ScreenScraper account yet.

### Server (apps/rom-manager-ui/server)
- `routes/games.js` — Added `loadTranslations()` that reads `data/translations.json` at startup and adds a `translations` field (region→title map) to `GET /api/games/:id` response

### Frontend (apps/rom-manager-ui/src)
- `components/GameDetail.jsx` — Displays translations below the game title as italic chips with native language labels (e.g. `日本語: 名作`, `中文(简): 游戏`)

### Root
- `package.json` — Added `sql.js` dev dependency for the translation builder

## Commands Run
- `npm install --save-dev sql.js --ignore-scripts`
- `npm run build` (frontend) — passed
- `cargo build -p scraper-cli --release` — passed
- `cargo test -p scraper-cli` — 20 passed

## Status
- All code changes complete and building
- Translations feature blocked pending ScreenScraper account
- No branch created (changes made directly — user discretion)
