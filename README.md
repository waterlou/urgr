# URGR - Ultimate Retro Game Room

A retro game ROM collection manager with DAT parsing, metadata scraping, ROM building, game set playlists, and in-browser emulation via EmulatorJS.

## Features

- **DAT Import** — Parse MAME, FBNeo, OfflineList, DAT-O-MATIC, and custom DAT files
- **Metadata Scraping** — Fetch covers, screenshots, descriptions from TGDB, IGDB, ScreenScraper, VGMuseum, NoIntroPictures, SonyStore
- **ROM Building** — Build verified split-format ROM sets with parent/clone merge support
- **NPS Integration** — Import, scan, and build NoPayStation (PS Vita/PS3/PSP) collections
- **Internet Archive** — Search and download ROMs directly from archive.org
- **In-Browser Emulation** — Play games instantly via EmulatorJS (arcade + console)
- **Game Sets** — Create playlists and group games across collections
- **Recently Played** — Track your play history with TV-style dashboard cards
- **Search & Filter** — Filter by platform, version, favourites, parents-only, and more
- **Desktop App** — Electron build for macOS, Windows, and Linux

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite 6 |
| Server | Node.js + Express 5 |
| Database | SQLite via sql.js (in-memory with file persistence) |
| CLI Tools | Rust workspace (5 binaries) |
| Desktop | Electron 35 |

## Quick Start

### Prerequisites

- Node.js 22+
- Rust toolchain (for CLI binaries)
- npm

### Install

```bash
git clone https://github.com/water/gamemanager.git
cd gamemanager
npm install --ignore-scripts
cd apps/rom-manager-ui && npm install --ignore-scripts
```

### Build Rust CLIs

```bash
cargo build -p parse-cli --release
cargo build -p build-cli --release
cargo build -p nps-cli --release
cargo build -p scraper-cli --release
cargo build -p ia-cli --release
```

### Build Frontend

```bash
cd apps/rom-manager-ui
npx vite build
```

### Run

```bash
# Standalone server (default: http://localhost:3001)
cd apps/rom-manager-ui && node server/index.js

# Or use npm scripts
cd apps/rom-manager-ui && npm run dev      # development
cd apps/rom-manager-ui && npm run start    # production
```

### Run with Electron (Desktop App)

```bash
# Dev mode (server + Electron window)
cd apps/rom-manager-ui && npm run electron:dev

# Build for your platform
npm run electron:build:mac     # macOS (dmg + zip)
npm run electron:build:win     # Windows (exe + nsis)
npm run electron:build:linux   # Linux (AppImage + deb)
```

## Project Structure

```
gamemanager/
├── apps/
│   ├── rom-manager-ui/          # Web app (React + Express)
│   │   ├── electron/            # Electron main process
│   │   │   ├── main.cjs          # Main process entry (.cjs for ESM compat)
│   │   │   └── preload.cjs       # Context bridge
│   │   ├── server/              # Express API server
│   │   │   ├── index.js         # Server entry point
│   │   │   ├── paths.js         # Centralized path resolution
│   │   │   ├── db.js            # SQLite database
│   │   │   ├── helpers.js       # DB query helpers
│   │   │   ├── cli.js           # Rust CLI wrapper
│   │   │   ├── downloader.js    # Download queue manager
│   │   │   ├── ia-auth.js       # Internet Archive auth
│   │   │   ├── nps.js           # NoPayStation logic
│   │   │   └── routes/          # API route handlers
│   │   ├── src/                 # React frontend
│   │   │   ├── components/      # UI components (18)
│   │   │   ├── hooks/           # Custom React hooks
│   │   │   ├── api.js           # API client
│   │   │   └── App.jsx          # Root component
│   │   ├── dist/                # Built frontend (output)
│   │   └── package.json
│   ├── parse-cli/               # DAT file importer (Rust)
│   ├── build-cli/               # ROM set builder (Rust)
│   ├── nps-cli/                 # NoPayStation CLI (Rust)
│   ├── scraper-cli/             # Metadata scraper (Rust)
│   ├── ia-cli/                  # Internet Archive CLI (Rust)
│   └── db-cli/                  # Database inspector (Rust)
├── libs/
│   ├── rom-manager/             # Core library (DB, parsing, building)
│   ├── rom-scraper/             # Scraper API clients
│   └── ia-archive/              # Internet Archive client
├── data/
│   ├── roms.db                  # SQLite database
│   ├── roms/                    # ROM files by collection
│   └── .env                     # API credentials
├── docs/
│   ├── specs.md                 # Full architecture spec
│   ├── api-reference.md         # REST API documentation
│   ├── cli-reference.md         # CLI command reference
│   └── developer-notes.md       # Non-obvious constraints
└── icons/                       # Collection icons
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `ROM_DB` | `data/roms.db` | Database file path |
| `ROM_DATA` | `data/` | Data directory (Electron: `app.getPath('userData')/data`) |
| `ELECTRON_RUN` | - | Set to `1` by Electron main process |
| `SCRAPER_CLI_BINARY` | auto-detect | Path to scraper-cli binary |
| `PARSE_CLI_BINARY` | auto-detect | Path to parse-cli binary |
| `BUILD_CLI_BINARY` | auto-detect | Path to build-cli binary |
| `NPS_CLI_BINARY` | auto-detect | Path to nps-cli binary |

## API

Base URL: `http://localhost:3001/api`

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Row counts for all tables |
| `GET /api/collections` | List all collections |
| `GET /api/collections/:id/games` | Games in a collection |
| `POST /api/collections/:id/build` | Build a ROM set |
| `POST /api/collections/:id/scan` | Scan directory for available ROMs |
| `GET /api/games` | Browse all games (paginated) |
| `GET /api/games/:id` | Game detail with ROM entries |
| `GET /api/games/:id/play` | Serve ROM file for emulation |
| `POST /api/games/:id/scrape` | Scrape metadata for a game |
| `POST /api/games/:id/download-ia` | Download from Internet Archive |
| `GET /api/versions` | List imported versions |
| `POST /api/versions/import-online` | Import DAT from online sources |
| `GET /api/versions/available` | Available versions (MAME/FBNeo/NPS) |
| `PUT /api/settings` | Save API credentials |
| `GET /api/games/recently-played` | Recently played games |

Full API docs: [`docs/api-reference.md`](docs/api-reference.md)

## Supported Sources

| Source | Import | Build | Notes |
|--------|--------|-------|-------|
| MAME | Online + Upload | Split format | progettosnaps.net DATs |
| FBNeo | GitHub tags | Split format | Nightly + tagged releases |
| FBAlpha43 | GitHub | Split format | Legacy 0.2.97.43 |
| FBAlpha44 | GitHub | Split format | Legacy 0.2.97.44 |
| OfflineList | nointro.free.fr | No build | No-Intro DATs |
| DAT-O-MATIC | datomatic.no-intro.org | No build | Per-system DATs |
| NPS | NoPayStation API | PKG build | PS Vita/PS3/PSP |
| Custom DAT | Upload | Split format | Any Logiqx/ClrMAMEPro XML |

## Scraper Providers

| Provider | Type | Auth | Data |
|----------|------|------|------|
| **TheGamesDB** | REST API | Built-in key (zero-config) | Platform data, covers |
| **IGDB (Twitch)** | Apicalypse API | `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` | Full metadata, covers, screenshots |
| **ScreenScraper** | API v2 | Dev ID + Password | Metadata + media (untested) |
| **VGMuseum** | HTML scrape | None (browser UA) | Screenshots only (~13,766 games, 50+ platforms) |
| **NoIntroPictures** | GitHub raw | None | Box art / screenshots |
| **SonyStore** | PSN API | None | Screenshots |

Run `scraper-cli test` to check connectivity to all configured providers.

## Docker

```bash
docker build -t rom-manager .
docker run -p 3001:3001 -v ./data:/app/data rom-manager
```

## CI/CD

GitHub Actions workflow (`.github/workflows/build-electron.yml`) builds Electron apps for all platforms on tag push:

```bash
git tag v1.0.0
git push origin v1.0.0
# → Builds macOS (universal dmg), Windows (nsis exe), Linux (AppImage + deb)
# → Creates draft GitHub Release with artifacts
```

## Testing

```bash
cd apps/rom-manager-ui

# API tests (14 tests)
bash server/test-api.sh

# NPS unit tests (21 tests)
npm run test:nps

# Version sort tests (14 tests)
node --test server/test-version-sort.mjs

# UI tests (Playwright)
npx playwright test
```

## Documentation

- [`docs/specs.md`](docs/specs.md) — Full architecture, data model, CLI tools, API
- [`docs/api-reference.md`](docs/api-reference.md) — REST API with request/response examples
- [`docs/cli-reference.md`](docs/cli-reference.md) — CLI command details
- [`docs/developer-notes.md`](docs/developer-notes.md) — Non-obvious constraints and design decisions
- [`docs/version-fallback.md`](docs/version-fallback.md) — Version fallback strategy

## License

Private — All rights reserved.
