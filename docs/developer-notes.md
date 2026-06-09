# Developer Notes

## Non-obvious Constraints

- **WAL files** (`roms.db-wal`, `roms.db-shm`) must be deleted when doing direct `sqlite3` updates — they shadow the main DB
- **Frontend changes require rebuild**: server serves `dist/` statically; run `npx vite build` after JSX/CSS edits
- **Rust changes require recompilation**: run `cargo build -p <name> --release` after modifying Rust source
- **sql.js in-memory DB**: server loads DB into memory at startup; autosave happens 200ms after each write via debounce. Direct file edits while server runs get overwritten.
- DB path injection: `execCli` automatically appends `--json --db <path>` for Rust binaries
- `findBinary` checks: env var → PATH → `target/release/` → `target/debug/` → `/usr/local/bin/`

## Download Manager

### `server/downloader.js`

Singleton managing download queue. Key behaviors:
- **One download at a time**: Queue processes sequentially
- **SHA-256 verification**: Downloaded file hashed and compared against expected
- **Auto-move**: After download, file moved to `data/roms/{collection_folder}/{platform}/{Games|DLCs|Updates}/{filename}`
- **Game completion**: After all files for a game entry are done, runs `nps-cli scan --game-id <id>` to update `scanned_games`, then sets `game_state.available = 1`
- **Retry**: Up to 3 retries before marking as failed
- **120s timeout**: Fetch uses `AbortSignal.timeout(120000)`

### Per-ROM Availability

Game detail response includes `downloaded` flag per ROM entry, checked against `download_queue` entries with `status='completed'`.

## Frontend

- Router: custom `useRouter` hook with query params (`?view=`, `?id=`, `?game=`)
- BuildManager scan result displays: `✓ {exists} exist · ♻ {reused} reused · ✗ {missing} missing`
- For unversioned collections (NPS, No-Intro): `reused` is always 0 (not shown by frontend)
- For versioned collections (FBNeo, MAME): `reused` calculated by checking prior version directories. Also shown in scan results via `GET /api/collections/:id/build?scan=true`.
- EmulatorJS CDN: `https://cdn.emulatorjs.org/nightly/data/` (nightly channel has more up-to-date cores)

## CLI Behavior

### ROM Verification

- **Zip-based ROMs (FBNeo, MAME, No-Intro)**: Use **CRC32** read from zip entry headers. No decompression needed — `zip::ZipArchive::by_index_raw().crc32()` reads the stored CRC directly from the zip's local file header.
- **NPS (PKG files)**: Uses **SHA-256** for download verification (`downloader.js` compares downloaded file hash against `expected_sha256`).
- `scanned_games` table was removed. CLI now outputs match results as JSON; server writes directly to `game_state.available`.

### Scan commands (`nps-cli scan`, `build-cli scan`)

Both CLIs accept `--game-id <id>` to scan a single game instead of the entire collection.
- `nps-cli scan` — extracts `title_id` from `.pkg` filename (pattern: `{prefix}-{title_id}_{num}-...`)
- `build-cli scan` — matches by stem (filename without `.zip` extension), then verifies CRC from zip entry headers against expected ROM entries. A zip is only considered matched if at least one expected CRC is found in its entry headers.
- Both output JSON with `{ matches: [{name, filename}], missing_names: [...] }`. Server parses this and updates `game_state.available`.

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
