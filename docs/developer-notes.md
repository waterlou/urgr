# Developer Notes

## Non-obvious Constraints

- **WAL files** (`roms.db-wal`, `roms.db-shm`) must be deleted when doing direct `sqlite3` updates — they shadow the main DB
- **Frontend changes require rebuild**: server serves `dist/` statically; run `npx vite build` after JSX/CSS edits
- **Rust changes require recompilation**: run `cargo build -p <name> --release` after modifying Rust source
- **sql.js in-memory DB**: server loads DB into memory at startup; autosave happens 200ms after each write via debounce. Direct file edits while server runs get overwritten.
- **IA credentials stored in `data/.env`**: saved via Settings → Internet Archive tab; auto-loaded on server startup via `ia-auth.js:loadFromEnv()`. Re-login happens on restart, so restart after saving credentials.
- **IA item cache**: `data/ia-cache.json` maps `(source, version)` → IA item ID to skip re-searching. Managed automatically by server from `ia-cli find` JSON output.
- **DB path injection**: `execCli` automatically appends `--json --db <path>` for Rust binaries
- **`findBinary` checks**: env var → PATH → `target/release/` → `target/debug/` → `/usr/local/bin/`
- **`romof` column**: `server/db.js` migration adds `romof TEXT` to `game_entries`. All three parsers (MAME listXML, Logiqx XML, ClrMAMEPro) read it from the `<machine>` element. Re-import required after migration.

## Download Manager

### `server/downloader.js`

Singleton managing download queue. Key behaviors:
- **One download at a time**: Queue processes sequentially
- **SHA-256 verification**: Downloaded file hashed and compared against expected
- **Auto-move**: After download, file moved to `data/roms/{collection_folder}/{platform}/{Games|DLCs|Updates}/{filename}`
- **Game completion**: After all files for a game entry are done, runs `nps-cli scan --game-id <id>` to update `scanned_games`, then sets `game_rom_sets.available = 1` for the version and calls `syncGameAvailability()`
- **Retry**: Up to 3 retries before marking as failed
- **120s timeout**: Fetch uses `AbortSignal.timeout(120000)`

### Per-ROM Availability

Game detail response includes `downloaded` flag per ROM entry, computed by CRC verification:
- **Non-merge ROMs**: checked in the game's own zip via `unzip -v` (CRC-32 column)
- **Merge ROMs** (`merge_target` set): checked in parent zips by following `romof`/`cloneof` chain
- Results are cached per zip — one `unzip -v` call per zip, not per ROM
- Previously this was a simple `game_state.available === 1` shortcut — now it's CRC-based

## Frontend

- Router: custom `useRouter` hook with query params (`?view=`, `?id=`, `?game=`)
- BuildManager scan result displays: `✓ {exists} exist · ♻ {reused} reused · ✗ {missing} missing`
- For unversioned collections (NPS, No-Intro): `reused` is always 0 (not shown by frontend)
- For versioned collections (FBNeo, MAME): `reused` calculated by checking prior version directories. Also shown in scan results via `GET /api/collections/:id/build?scan=true`.
- EmulatorJS CDN: `https://cdn.emulatorjs.org/nightly/data/` (nightly channel has more up-to-date cores)
- **EmulatorJS re-open**: Closing the emulator modal triggers a page reload (`location.reload()`). EmulatorJS doesn't support re-initialization with a new game URL after the initial load.

## Build Completion Scan (game_rom_sets.available)

After a build completes, the server scans output dirs to set `game_rom_sets.available = 1` for found games. **The scan must follow the version chain from `.version`:**

1. Read `.version` file at `{collectionDir}/.version`
2. Walk versions **in order** (oldest first, matching the file's line order)
3. Stop at the version that was just built
4. Scan each version's `roms/` subdirectory for `.zip` files and CHD directories

**Never** scan the collection root recursively (`scanDir(collectionDir)`) — that causes cross-version misassignment (e.g., 0.256 ROMs attributed to 0.41).

This design exists in two places in `collections.js`:
- `POST /api/collections/:id/build` (DAT build completion, ~line 470)
- `PUT /api/collections/:id/builds/:buildId/run` (~line 625)

## Game State Availability

`game_state.available` is **derived** from `game_rom_sets.available` via `syncGameAvailability(gameIds)` in `server/operations/syncAvailability.js`. Never write to `game_state.available` directly — always write to `game_rom_sets.available` and call `syncGameAvailability()` afterward.

## Build Progress Reporting

### Frontend field name
The server sends progress as `{ type: 'progress', pct: N, msg: '...' }`. The frontend MUST read `msg.pct` (not `msg.percent`). See `BuildManager.jsx` line 46.

### Rust progress interval
In `builder.rs`, progress during the copy loop uses an adaptive interval: `(need_copy.len() / 100).max(1)`. This ensures ~100 evenly-spaced updates regardless of workload size. A counter `processed_count` increments every iteration (including missing games), so the progress bar always advances.

## CLI Behavior

### ROM Verification

- **Zip-based ROMs (FBNeo, MAME, No-Intro)**: Use **CRC32** read from zip entry headers. No decompression needed — `zip::ZipArchive::by_index_raw().crc32()` reads the stored CRC directly from the zip's local file header.
- **NPS (PKG files)**: Uses **SHA-256** for download verification (`downloader.js` compares downloaded file hash against `expected_sha256`).
- `scanned_games` table was removed. CLI now outputs match results as JSON; server writes to `game_rom_sets.available` and calls `syncGameAvailability()` to update `game_state`.

### Split-Format (Merged) ROM Support

DATs from `progettosnaps.net` are in **Logiqx XML format** (detected via `<!DOCTYPE datafile>`). All three parsers (MAME listXML, Logiqx XML, ClrMAMEPro) now read `romof` from `<machine>` elements.

**Key concepts:**
- `merge_target` on `RomEntry` — this ROM lives in a parent game's zip, not this game's zip. Set when `<rom>` has a `merge` attribute.
- `romof` on `GameEntry` — which game's zip provides the shared ROMs. Only set for clone/child games.
- `cloneof` on `GameEntry` — game hierarchy (which game this is a variant of). Same as `romof` when both are present.

**How split-format works:**

| Storage | Game zip | Parent zip (e.g. `neogeo.zip`) |
|---------|----------|-------------------------------|
| Non-merge ROMs | `201-c1.c1`, `201-p1.p1` (game-specific) | — |
| Merge ROMs | — (not in this zip) | `000-lo.lo`, `sfix.sfix`, `sm1.sm1` (BIOS) |

**CRC verification skips merge ROMs** — in both `verify_game_zip` (builder) and `ImportIndex::find_match` (import matcher). ROMs with `merge_target` set are expected to be in the parent zip, not the game zip.

**CRC verification also subtracts by `cloneof`** — ROMs whose CRCs match the parent game's ROMs are skipped. This handles cases where the parent has the shared ROMs but `merge` attribute isn't set.

**Play endpoint merges parent zips** — when serving a game, follows `romof` chain (or `cloneof` fallback) to find all parent zips, extracts all entries, and re-zips into a single merged file for EmulatorJS.

**Per-ROM availability** — `rom.downloaded` is computed by actually checking CRC in zip files via `unzip -v`. Non-merge ROMs checked in game's own zip; merge ROMs checked in parent zip via `romof` chain. Results are cached per zip (one `unzip -v` call per zip).

### Scan commands (`nps-cli scan`, `build-cli scan`)

Both CLIs accept `--game-id <id>` to scan a single game instead of the entire collection.
- `nps-cli scan` — extracts `title_id` from `.pkg` filename (pattern: `{prefix}-{title_id}_{num}-...`)
- `build-cli scan` — matches by stem (filename without `.zip` extension), then verifies CRC from zip entry headers against expected ROM entries. A zip is only considered matched if at least one expected CRC is found in its entry headers.
- Both output JSON with `{ matches: [{name, filename}], missing_names: [...] }`. Server parses this and updates `game_rom_sets.available` + `syncGameAvailability()`.

### Reuse calculation (versioned collections)

For versioned collections (FBNeo, MAME), `reused` is calculated by the builder:
- Counts games in the current version that have matching `.zip` files in prior version output directories
- Includes both `need_copy` games (new/changed) AND unchanged games
- CRC from zip entry headers is compared against expected ROM entries via `verify_game_zip`
- Unversioned collections (NPS, No-Intro): `reused` is always 0

### Build matching (`ImportIndex::find_match`)

The builder's import matcher compares CRC32 sets:
1. Reads CRC32 of each zip entry from the zip's local file headers (no decompression)
2. For each game, checks that ALL expected CRC values from `rom_entries` are present in the zip
3. Only if all CRCs match does the zip count as a match for that game

### Unified build endpoint

`POST /api/collections/:id/build`:
- **scan=true**: Routes to appropriate CLI scan, no `import_dir` needed, uses `data/roms/{collection_folder}` as scan dir. Returns `{ exists, reused, missing }`.
- **scan=false & NPS**: Calls `nps-cli build`. No `import_dir` needed.
- **scan=false & DAT**: Calls `build-cli build` with progress streaming. Requires `import_dir`.

## Scraping Sources

### no-intro-pictures

Source: `https://github.com/teeedubb/no-intro-pictures`

Free, no-auth scraper for DAT-O-MATIC / No-Intro collections. Fetches box art, screenshots, and title logos from GitHub raw URLs.

**How it works:**
- Platform slugs (e.g., `nes`, `snes`, `megadriv`) are mapped to No-Intro folder names (e.g., `Nintendo - Nintendo Entertainment System`)
- Images are stored in subdirectories: `Named_Boxarts/{game}.png`, `Named_Snaps/{game}.png`, `Named_Titles/{game}.png`
- Uses HTTP HEAD to check existence before fetching
- No API key or authentication needed (public GitHub repo)

**Integration:**
- `libs/rom-scraper/src/sources/no_intro_pictures.rs` — `GameScraper` trait implementation
- Automatically included in `ScraperRegistry` (always available, priority 400)
- CLI usage: `scraper-cli detail "nes/1942 (Japan, USA)" --source no-intro-pictures`
- JS fallback in `scrapeSingleGame` (`games.js`): after other scrapers, if collection is `DATOMATIC` and no covers/screenshots found, tries no-intro-pictures using the game's `description` field for matching (has full No-Intro naming with region)

### sony-store

Source: PlayStation Store public API (`store.playstation.com/store/api/chihiro/00_09_000/container/{region}/{lang}/{content_id}`)

Free, no-auth scraper for NPS collections. Fetches screenshots (hero image + screens) from the Sony Store API.

**How it works:**
- Takes the NPS `content_id` (or `title_id`) as the game ID
- Tries regions `us`, `eu`, `jp` with languages `en`, `en-3`, `ja`
- Extracts `hero_image.urls` and `screens` from the API response
- Returns up to 5 screenshots
- No API key or authentication needed

**Integration:**
- `libs/rom-scraper/src/sources/sony_store.rs` — `GameScraper` trait implementation
- Automatically included in `ScraperRegistry` (always available, priority 500)
- CLI usage: `scraper-cli detail "UP4395-PCSE00890_00-..." --source sony-store`
- Replaces the old JS `fetchSonyScreenshots()` function — all scraping logic in Rust

### Traditional scrapers

- **ScreenScraper**: Requires `SS_DEVID` + `SS_DEVPASSWORD` (and optional `SS_USERNAME` + `SS_PASSWORD`) configured in Settings
- **IGDB**: Requires `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` configured in Settings
- **TheGamesDb**: Built-in API key, always available
