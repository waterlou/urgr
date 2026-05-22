# Session: `rom-scraper` Library — Phase 1

**Date:** 2026-05-22  
**Branch:** `feat/rom-scraper-library`  
**Goal:** Create a reusable Rust library for retro game ROM metadata scraping

## Files Created

```
gamemanager/
├── Cargo.toml                              # Workspace root
├── libs/rom-scraper/
│   ├── Cargo.toml                          # Library deps (reqwest, serde, quick-xml, tokio, etc.)
│   └── src/
│       ├── lib.rs                          # Public API re-exports
│       ├── models.rs                       # Core data types: Game, Platform, RomInfo, Media, ScrapeSource, etc.
│       ├── error.rs                        # Unified Error enum with thiserror
│       ├── hasher.rs                       # CRC32/MD5/SHA1 streaming computation
│       ├── client.rs                       # Shared async HTTP client (reqwest wrapper)
│       ├── config.rs                       # Config struct with ScreenScraper auth, cache dir, source priority
│       ├── matcher.rs                      # ROM filename parsing (No-Intro style), match via hash
│       └── sources/
│           ├── mod.rs                      # GameScraper trait + ScraperRegistry (priority-based fallback)
│           └── screenscraper.rs            # ScreenScraper.fr API client (JSON output)
```

## Library Architecture

### Scraper Trait Pattern
```rust
#[async_trait]
trait GameScraper: Send + Sync {
    fn name(&self) -> &str;
    fn source_type(&self) -> ScrapeSource;
    fn priority(&self) -> u32;
    async fn search_by_name(&self, query, platform?) -> Result<Vec<Game>>;
    async fn search_by_hash(&self, hash, hash_type, platform?) -> Result<Vec<Game>>;
    async fn get_game_detail(&self, game_id) -> Result<Game>;
}
```

**ScraperRegistry** holds a sorted list of scrapers by priority. When searching, it tries each in priority order, returning the first success or falling through on failure.

### Data Flow
1. ROM file → `compute_hashes()` → CRC32, MD5, SHA1, size
2. Hashes → `match_rom_by_hashes()` → `ScraperRegistry.search_by_hashes()` → tries SHA1 → MD5 → CRC32 across all configured sources
3. Fallback: `parse_filename()` extracts title/region/version from No-Intro style filenames
4. Name → `search_by_name()` → tries sources in priority order

### Dependencies
- **reqwest** 0.12 (async HTTP, rustls-tls)
- **tokio** 1.x (async runtime)
- **serde** + **serde_json** (serialization)
- **quick-xml** 0.31 (ScreenScraper XML — included but JSON output used)
- **crc32fast**, **md-5**, **sha1** (ROM hashing)
- **thiserror** (error types)
- **async-trait** (trait support)
- **tracing** (debug logging)

## Test Results
- **15 tests**, all passing
- Coverage: hashing (empty/ascii/uppercase), filename parsing (basic/revision/multi-region/brackets), platform ID mapping, URL encoding

## What Works
- ROM CRC32/MD5/SHA1 hashing (streaming for large files)
- No-Intro / TOSEC style filename parsing
- ScreenScraper.fr API: search by name, search by hash, get game detail
- Priority-based multi-source fallback (stub slots for TheGamesDB, IGDB)
- 30+ platform short name → ScreenScraper ID mappings
- JSON response parsing with flexible field extraction
- Unified error type across HTTP, IO, parse, and source errors

## Next Phases
1. **SQLite cache** — schema, store/query cached results, dedup
2. **Image download** — download covers/screenshots, resize, local storage
3. **TheGamesDB + IGDB sources** — full implementations
4. **CLI binary** — for testing / manual scraping
5. **File organization engine** — move ROMs to correct folders
6. **Web app + Docker** — NAS deployment

## Commands Run
```bash
cargo build
cargo test
cargo doc --no-deps
```
