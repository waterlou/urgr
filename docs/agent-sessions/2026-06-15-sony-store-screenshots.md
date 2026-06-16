# Session Summary — 2026-06-15

## Goal
Fix SonyStore scraper returning logos as screenshots — PSN API images were all being shoved into `screenshots` regardless of type.

## Root Cause
The PSN API `images` array has 4 types:

| type | dimensions | content | was handled as |
|------|-----------|---------|---------------|
| 1 | 240×240 | icon/logo | Screenshot ❌ |
| 2 | 80×80 | box art thumbnail | Screenshot ❌ |
| 9 | 160×160 | fake "screenshot" | Screenshot ❌ |
| 10 | 1024+×1024+ | hero/promo image | Screenshot ❌ |

The Rust scraper pushed ALL four into `Media { screenshots, .. }` with `MediaType::Screenshot`, then `games.js` blindly overwrote the DB screenshots column with this garbage — clobbering real IGDB screenshots.

## Changes

**`libs/rom-scraper/src/sources/sony_store.rs`**: filter by `type` — only type=10 is kept (as `MediaType::Fanart`). Types 1, 2, 9 are skipped (too small, not real screenshots).

**`apps/rom-manager-ui/server/db.js`**: added `fanarts TEXT DEFAULT '[]'` column + ALTER TABLE migration.

**`apps/rom-manager-ui/server/routes/games.js`**:
- SonyStore fallback stores `fanarts` not `screenshots`
- Added `fanarts` to main scrape INSERT, game detail response, `attachMedia`
- Added `GET /:id/fanart` and `fanart` media type route

**`apps/scraper-cli/src/main.rs`**: added `fanarts` to `DetailOutput` and `SearchResult` structs

## Verification
- Scraped "My Singing Monsters": screenshots now 9 real IGDB shots (not 4 logos)
- Fanarts now has 1 SonyStore hero image (1024×1024 promo art)
- ALL tests pass: 15 cache, 21 NPS, 14 version-sort, 17 API, 20 Rust

## Commit
`0ae1d65` on `agent/rom-table-overflow`
