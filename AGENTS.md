# ROM Manager

A ROM collection manager with DAT parsing, metadata scraping, ROM building, game set playlists, and in-browser emulation via EmulatorJS.

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

## Reference Docs

- **Full specs**: `docs/specs.md` — architecture, data model, CLI tools, API, workflows
- **API reference**: `docs/api-reference.md` — all API endpoints with request/response examples
- **Developer notes**: `docs/developer-notes.md` — non-obvious constraints, download manager, CLI behavior
- **CLI reference**: `docs/cli-reference.md` — CLI command details
- **Session logs**: `docs/agent-sessions/` — per-session summaries

## Chrome CDP Debug

`browser-harness-js` is at `/opt/homebrew/bin/browser-harness-js` (skill at `~/.agents/skills/cdp/`).

```bash
# Chrome Canary starts with --remote-debugging-port=9222
WS_URL=$(curl -s http://localhost:9222/json/version | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.webSocketDebuggerUrl)")
browser-harness-js "await session.connect({ wsUrl: '$WS_URL' })"
browser-harness-js 'const tabs = await listPageTargets(); return tabs.map(t => t.title)'
browser-harness-js 'await session.use(tabs[0].targetId)'
```

Key commands: `browser-harness-js --start`, `--stop`, `--restart`, `--status`, `--logs`.

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

## Design Decisions

- **Version fallback**: When looking for a ROM across versions, ALWAYS prefer **older** versions over newer ones. Newer versions (e.g., nightly) may have different ROM sets. Older versions are more stable and predictable.
- **EmulatorJS core names**: Use `fbneo` (not `arcade`) for FBNeo/MAME arcade games. The CDN core files are named `fbneo-wasm.data`, not `arcade-wasm.data`.
- **Region field**: Always store `''` (empty string) for region, never `NULL`. SQLite treats `NULL != NULL` in UNIQUE constraints, causing duplicate entries. The Rust code enforces this with `game.region.as_deref().unwrap_or("")`.
- **Scanner directory**: DAT builds scan `collectionDir/{version}` (version-specific), NOT the collection root. Scanning the root causes cross-version ROM misassignment.
