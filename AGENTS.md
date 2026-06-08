# ROM Manager

A ROM collection manager with DAT parsing, metadata scraping, ROM building, and game set playlists.

## Tech Stack

- **Frontend**: React 19 + Vite 6 (`apps/rom-manager-ui/src/`)
- **Server**: Node.js + Express 5 (`apps/rom-manager-ui/server/`)
- **Database**: SQLite via sql.js (`data/roms.db`)
- **CLI tools**: Rust workspace (`apps/parse-cli`, `apps/build-cli`, `apps/nps-cli`, `apps/scraper-cli`, `apps/db-cli`)
- **Shared libs**: Rust (`libs/rom-manager`, `libs/rom-scraper`)

## Commands

```bash
# Start server (production mode, serves built frontend)
cd apps/rom-manager-ui && node server/index.js

# Build frontend (required after JSX/CSS edits)
cd apps/rom-manager-ui && npx vite build

# Run tests
cd apps/rom-manager-ui && bash server/test-api.sh      # API tests (14)
cd apps/rom-manager-ui && npm run test:nps              # NPS unit tests (21)
cd apps/rom-manager-ui && npx playwright test           # UI tests

# Build Rust CLI tools
cargo build -p parse-cli --release
cargo build -p build-cli --release
cargo build -p nps-cli --release
cargo build -p scraper-cli --release
cargo build -p db-cli --release
```

## Architecture

- Express server at `apps/rom-manager-ui/server/index.js` serves API + built frontend from `dist/`
- All API routes under `/api/`; SSE job progress at `/api/jobs/:jobId`
- DB schema in `apps/rom-manager-ui/server/db.js` (tables: `set_versions`, `game_entries`, `rom_entries`, `scanned_games`, `game_state`, `collections`, `collection_versions`, `collection_builds`, `download_queue`, `scrape_jobs`, `game_sets`, `game_set_games`, `meta`, etc.)
- Frontend API client in `apps/rom-manager-ui/src/api.js`
- Rust CLIs communicate via JSON stdout; `execCli`/`execCliStream` helpers in `server/cli.js`
- Game state (available/rating/favourite) stored in sparse `game_state` table (no row = defaults)
- Router: custom `useRouter` hook with query params (`?view=`, `?id=`, `?game=`)

## Non-obvious Constraints

- **WAL files** (`roms.db-wal`, `roms.db-shm`) must be deleted when doing direct `sqlite3` updates — they shadow the main DB
- **Frontend changes require rebuild**: server serves `dist/` statically; run `npx vite build` after JSX/CSS edits
- **Rust changes require recompilation**: run `cargo build -p <name> --release` after modifying Rust source
- **sql.js in-memory DB**: server loads DB into memory at startup; autosave happens 200ms after each write via debounce. Direct file edits while server runs get overwritten.
- DB path injection: `execCli` automatically appends `--json --db <path>` for Rust binaries
- `findBinary` checks: env var → PATH → `target/release/` → `target/debug/` → `/usr/local/bin/`

## Chrome CDP Debug

`browser-harness-js` is at `/opt/homebrew/bin/browser-harness-js` (skill at `~/.agents/skills/cdp/`).

```bash
# Chrome Canary starts with --remote-debugging-port=9222
# Use explicit wsUrl since auto-detect doesn't work for Canary:
WS_URL=$(curl -s http://localhost:9222/json/version | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.webSocketDebuggerUrl)")
browser-harness-js "await session.connect({ wsUrl: '$WS_URL' })"
browser-harness-js 'const tabs = await listPageTargets(); return tabs.map(t => t.title)'
browser-harness-js 'await session.use(tabs[0].targetId)'
browser-harness-js 'await session.Page.navigate({url:"http://localhost:3001"})'
browser-harness-js '(await session.Runtime.evaluate({expression:"document.title",returnByValue:true})).result.value'
```

Key commands: `browser-harness-js --start`, `--stop`, `--restart`, `--status`, `--logs`.

## CLI Specifications

### `build-cli` (DAT-based collections: FBNeo, MAME)

Commands:
- `scan <version-id> <dir> [--game-id <id>]` — Walk dir for `.zip` files, match by stem (filename without extension) against game names. With `--game-id`, scans a single game instead of all. Updates `scanned_games` table: matched = `filename` set + `status='ok'`, unmatched = `filename=''` + `status='missing'`. Output: `{ total_files, matched_games, missing_games }`. No `game_state` writes.
- `build <source> <import-dir> [--version-id <id>] [--base-dir <dir>] [--collection-dir <dir>] [--dry-run] [--progress]` — Build ROM set from `import-dir` into collection dir. `--dry-run` reports what would happen without copying. Handles reuse from previous version builds. Output: `{ added, exists, reused, missing, missing_games, cleaned }`.

**Versioned** (FBNeo, MAME): `reused` is calculated server-side after scan — checks if matched `.zip` files also exist in prior version directories (`{collectionDir}/{priorVersion}/roms/`). Only older versions (lower `sv.id`) are considered prior.

### `nps-cli` (NoPayStation)

Commands:
- `scan <version-id> <dir> [--game-id <id>]` — Walk dir for `.pkg` files, extract `title_id` from filename (pattern: `{prefix}-{title_id}_{num}-...`). With `--game-id`, scans a single game. Updates `scanned_games` table: matched = `filename` set + `status='ok'`, unmatched = `filename=''` + `status='missing'`. Output: `{ total_files, matched_games, missing_games }`. No `game_state` writes.
- `build <version-id> <collection-dir> [--input-dir <dir>]` — Copy/download PKG files into `{collection-dir}/{platform}/{Games|DLCs|Updates}/`. Output: `{ built, skipped, total }`.

**Unversioned** (NPS, No-Intro): no reuse concept — `reused` is always 0.

### `POST /api/collections/:id/build`

Unified endpoint for both scan and build. Behavior:
- **scan=true**: Calls the appropriate `* scan` CLI (nps-cli or build-cli), then server reads `scanned_games` and updates `game_state.available`. **No `import_dir` needed**. Uses `data/roms/{collection_folder}` as scan dir. Returns `{ exists, reused, missing }`.
- **scan=false & NPS**: Calls `nps-cli build`. No `import_dir` needed.
- **scan=false & DAT**: Calls `build-cli build` with progress streaming. Requires `import_dir`.

### Frontend (BuildManager scan result)

Displays: `✓ {exists} exist · ♻ {reused} reused · ✗ {missing} missing`
- For unversioned collections: `reused` is always 0 (not shown by frontend)
- For versioned collections: `reused` calculated by checking prior version directories

## Download Manager

### `server/downloader.js`

Singleton managing download queue. Key behaviors:
- **One download at a time**: Queue processes sequentially
- **SHA-256 verification**: Downloaded file hashed and compared against expected
- **Auto-move**: After download, file moved to `data/roms/{collection_folder}/{platform}/{Games|DLCs|Updates}/{filename}`
- **Game completion**: After all files for a game entry are done, runs `nps-cli scan --game-id <id>` to update `scanned_games`, then sets `game_state.available = 1`
- **Retry**: Up to 3 retries before marking as failed
- **120s timeout**: Fetch uses `AbortSignal.timeout(120000)`

### `POST /api/downloads/enqueue`

`{ game_entry_id }` → queues all ROM entries for that game (base game, DLCs, updates). Returns `{ enqueued: N }`.

### Per-ROM Availability

Game detail response includes `downloaded` flag per ROM entry, checked against `download_queue` entries with `status='completed'`.

## Git Workflow

1. Never commit to `main` or `master`
2. Before editing: `git checkout -b agent/<short-task-name>`
3. Before committing: run `npm run test:api` and `npm run test:ui`
4. Commit messages: `feat: ...`, `fix: ...`, `refactor: ...`, `chore: ...`
5. After each session: `opencode export` and save summary to `docs/agent-sessions/<date>-session.md`

## Code Style

- React: functional components, hooks, no class components
- JSX: destructure props inline, 2-space indent
- CSS: CSS custom properties for theming (`--bg`, `--text`, `--accent`, etc.)
- SQL: parameterized queries with `get()`, `all()`, `run()` helpers
- Avoid `try/catch` where possible; use early returns
- Keep components focused and under 400 lines

## Interaction with user

- If the bug is trival, you can skip the test part if you have high confident that you will fix it.  But if same bug happen after you though you've fixed, you should setup a testable environement so that you can find the bug and debug it by yourself.
- The project is developed in express.js for the server, but having lot of cli app written in rust for performance issues.  Don't write same features twice in both languages.  For CLI that is a long running process, you must consider how to communicate with the server for prgress update and cancellation.
- Avoid patch here and there for fixing bugs.  Also consider where to fix the bug is the cleanest method.  Suggest user about refactoring if any part of the project is complicate enough for refactoring.
 