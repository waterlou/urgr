# GameManager — Project Specification

A retro game ROM collection manager. Import DAT files, scrape metadata from online providers, build verified ROM sets, and manage collections through a CLI and web UI.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  rom-manager-ui  (React + Express + SSE)                  │
│  Web UI for collections, game browsing, settings, jobs    │
├──────────────────────────────────────────────────────────┤
│  CLI Layer (Rust binaries)                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐│
│  │parse-cli │  │build-cli │  │ nps-cli  │  │scraper-cli ││
│  │          │  │          │  │          │  │            ││
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘│
│  ┌────┴─────────────┴─────────────┴───────────────┴──────┐│
│  │               rom-manager (lib)                       ││
│  │  DB, DAT parsing, scanner, verifier, builder          ││
│  └────────────────────────┬──────────────────────────────┘│
├───────────────────────────┼──────────────────────────────┤
│                    SQLite roms.db                         │
├──────────────────────────────────────────────────────────┤
│               rom-scraper (lib)                           │
│  TGDB / IGDB / ScreenScraper / VGMuseum / NoIntroPictures │
└──────────────────────────────────────────────────────────┘
```

### Crates

| Crate | Type | Purpose |
|-------|------|---------|
| `rom-scraper` | Library | HTTP clients, API models, scraper registry, hashing, filename parsing |
| `rom-manager` | Library | SQLite DB, DAT parsing, scanner, verifier, ROM set builder |
| `scraper-cli` | Binary | Game metadata scraping CLI |
| `parse-cli` | Binary | DAT file import CLI |
| `build-cli` | Binary | ROM collection build/scan/verify/diff CLI (DAT-based) |
| `nps-cli` | Binary | NoPayStation scan/build CLI (NPS-based) |
| `db-cli` | Binary | Database inspection CLI |
| `rom-manager-ui` | Web app | React frontend + Express API server |

---

## Data Model

### SQLite Tables

```
set_versions
  id          INTEGER PRIMARY KEY
  source      TEXT NOT NULL           -- e.g. "mame", "fbneo", "nps", "offlinelist", "datomatic"
  version     TEXT NOT NULL           -- e.g. "0.261", "PSV", "nightly"
  dir         TEXT                    -- ROM directory path
  created_at  TEXT
  UNIQUE(source, version)

game_entries
  id          INTEGER PRIMARY KEY
  version_id  INTEGER → set_versions
  name        TEXT NOT NULL           -- game short name (e.g. "sf2")
  description TEXT
  year        TEXT
  manufacturer TEXT
  cloneof     TEXT                    -- parent game name (MAME/FBNeo/NPS hierarchy)
  platform    TEXT                    -- platform folder (e.g. "PSV" for NPS)
  title_id    TEXT                    -- PSN title ID (NPS)
  content_id  TEXT                    -- PSN content ID (NPS)
  region      TEXT                    -- region code (NPS: "US", "EU", "JP", etc.)
  covers      TEXT DEFAULT '[]'       -- JSON array of cover URLs
  screenshots TEXT DEFAULT '[]'       -- JSON array of screenshot URLs
  synopsis    TEXT
  UNIQUE(version_id, name, region)

rom_entries
  id           INTEGER PRIMARY KEY
  game_entry_id INTEGER → game_entries
  filename     TEXT NOT NULL          -- PKG filename (NPS) or ROM file inside zip (DAT)
  size         INTEGER
  crc32        TEXT
  md5          TEXT
  sha1         TEXT
  status       TEXT                   -- "good", "nodump", etc.
  merge_target TEXT
  subtype      TEXT DEFAULT 'game'    -- "game", "dlc", "update" (NPS)
  pkg_url      TEXT                   -- full PKG download URL (NPS)
  UNIQUE(game_entry_id, filename)

scanned_games
  id          INTEGER PRIMARY KEY
  version_id  INTEGER → set_versions
  name        TEXT NOT NULL           -- game name
  filename    TEXT                    -- file path on disk
  sha1        TEXT
  size        INTEGER
  status      TEXT                    -- "ok", "missing", "mismatch"
  UNIQUE(version_id, name)

game_state
  game_entry_id INTEGER PRIMARY KEY → game_entries
  available     INTEGER DEFAULT 0    -- file found on disk
  rating        INTEGER DEFAULT 0
  favourite     INTEGER DEFAULT 0
  play_count    INTEGER DEFAULT 0
  updated_at    TEXT

download_queue
  id              INTEGER PRIMARY KEY
  game_entry_id   INTEGER → game_entries
  version_id      INTEGER → set_versions
  pkg_url         TEXT                -- download URL
  filename        TEXT                -- output filename
  file_size       INTEGER
  expected_sha256 TEXT
  subtype         TEXT                -- "game", "dlc", "update"
  status          TEXT                -- "pending", "downloading", "completed", "failed"
  progress        INTEGER
  error           TEXT
  retry_count     INTEGER
  created_at      TEXT
  completed_at    TEXT

collections
  id          INTEGER PRIMARY KEY
  name        TEXT NOT NULL
  slug        TEXT NOT NULL
  platform    TEXT
  logo        TEXT DEFAULT ''
  folder      TEXT                    -- folder in data/roms/
  has_dataset INTEGER DEFAULT 0
  dataset_preset TEXT                 -- "MAME", "FBNEO", "NPS", "OFFLINELIST", "DATOMATIC"
  created_at  TEXT
  updated_at  TEXT

collection_versions
  id            INTEGER PRIMARY KEY
  collection_id INTEGER → collections
  version_id    INTEGER → set_versions
  UNIQUE(collection_id, version_id)

collection_builds
  id            INTEGER PRIMARY KEY
  collection_id INTEGER → collections
  version_id    INTEGER → set_versions
  status        TEXT                  -- "not_started", "building", "complete", "failed"
  format        TEXT
  games_total   INTEGER
  games_built   INTEGER
  games_missing INTEGER
  started_at    TEXT
  completed_at  TEXT
  created_at    TEXT
  UNIQUE(collection_id, version_id)

game_sets
  id          INTEGER PRIMARY KEY
  name        TEXT NOT NULL
  icon        TEXT
  description TEXT
  platforms   TEXT
  created_at  TEXT

game_set_games
  id            INTEGER PRIMARY KEY
  game_set_id   INTEGER → game_sets
  game_entry_id INTEGER → game_entries

scrape_jobs
  id              TEXT PRIMARY KEY
  status          TEXT
  total_games     INTEGER
  scraped         INTEGER
  skipped         INTEGER
  failed          INTEGER
  rate_limited    INTEGER
  progress_msg    TEXT
  result          TEXT
  created_at      TEXT
  updated_at      TEXT
```

---

## CLI Tools

### `scraper-cli` — Game Metadata Scraper

Searches and scrapes game metadata from online providers. Outputs JSON to stdout.

| Command | Description |
|---------|-------------|
| `hash <file>` | Compute ROM hashes |
| `search <query>` | Search games by name |
| `scrape <file>` | Match a ROM and enrich via detail |
| `detail <game-id> --source <s>` | Full game details by provider ID |
| `test` | Check connectivity to all configured providers |

**Providers:** TheGamesDB (default, built-in key), IGDB (needs Client ID/Secret), ScreenScraper (untested, needs dev account), MobyGames (needs API key, 1 req/s, full metadata), RetroAchievements (needs API key, 4 req/s, hash matching + metadata), SteamGridDB (needs API key, artwork only), VGMuseum (always-on, screenshots only), NoIntroPictures (always-on, box art), SonyStore (always-on, PSN screenshots), ArcadeDB (always-on, MAME arcade), LibretroThumbnails (always-on, libretro covers).

**scrape flow:** hash → filename parse → hash search → name search → `get_game_detail` enrichment.

**Config:** `.env` or `data/.env`. Settings UI saves to `data/.env`.

---

### `parse-cli` — DAT Importer

Imports ROM DAT files into the database.

```
parse-cli import <file> <source> <version> [--dir <dir>] [--json] --db <path>
```

**Format detection:** MAME ListXML, Logiqx XML, ClrMAMEPro, OfflineList XML (auto-detected).

**Writes to:** `set_versions`, `game_entries`, `rom_entries`.

**Upsert behavior:** Re-importing the same DAT is safe — `INSERT OR IGNORE` on versions, `ON CONFLICT DO UPDATE` on games and ROMs.

---

### `build-cli` — ROM Set Builder & Verifier

Builds, scans, verifies, and diffs ROM collections against DAT versions.

| Command | Description |
|---------|-------------|
| `dat list` | List imported versions |
| `dat info <id>` | Version details |
| `scan <id> <dir> [--game-id <id>]` | Scan ROM directory → `scanned_games` (single game with --game-id) |
| `verify <id> <dir> [--fallback]` | Hash verify against DAT |
| `diff <a> <b>` | Compare two versions |
| `build <source> <import-dir>` | Build ROM collection (see below) |

#### `build <source> <import-dir>` — Full Spec

Auto-detects the latest version for `<source>` from the database. No version IDs required.

**Modes:**
- **Collect** (default): Each version gets its own delta folder. Only new/changed ROMs stored per version.
- **Update** (`--update`): In-place upgrade. Renames old folder, deletes old version from DB. Only latest folder exists.

**Build phases:**
1. loading (0-5%) — Read versions, enforce mode consistency
2. diff (5-10%) — Compare against previous version
3. setup (10-15%) — Create/rename folders
4. cleanup (15-20%) — Remove obsolete ROMs to `deleted_roms/`
5. index (20-30%) — Build hash index of import folder
6. copying (30-95%) — Match and copy ROMs (hash-verified)
7. saving (95-98%) — Write status files
8. done (100%)

**Matching:** Filename match first (`<game_name>.zip`), then extract ZIP + hash internal files + compare SHA1 against `rom_entries`.

**Idempotent:** Safe to re-run. Skips already-copied ROMs with correct hashes.

**Cancellation:** `SIGTERM`/`SIGINT` → sets cancel flag → returns early at next phase boundary.

**Progress:** `--progress` flag emits JSON lines to stderr. Progress file written to `_build_progress.json`.

**File layout:**
```
<base>/<source>/<version>/_build_status.json   -- resume state
<base>/<source>/<version>/_build_progress.json  -- live progress
<base>/<source>/_build_mode.json                 -- mode enforcement
<base>/deleted_roms/<name>_v<version>.zip       -- removed ROMs
```

---

### `nps-cli` — NoPayStation

Manages PlayStation game downloads from NoPayStation.

| Command | Description |
|---------|-------------|
| `scan <id> <dir> [--game-id <id>]` | Scan directory for `.pkg` files → `scanned_games` |
| `build <id> <collection-dir> [--input-dir <dir>]` | Copy/download PKG files into collection folder |
| `scrape <id> [--game-id <id>]` | Fetch Sony Store screenshots |

**PKG filename format:** `{content-id}_bg_{n}_{hash}.pkg` where `content-id` contains the title_id after the first `-`.

**File layout after build:**
```
<collection-dir>/<platform>/Games/<filename>.pkg
<collection-dir>/<platform>/DLCs/<filename>.pkg
<collection-dir>/<platform>/Updates/<filename>.pkg
```

---

### `db-cli` — Database Inspector

Read-only CLI for querying the SQLite database.

```
db-cli summary <db>                          -- row counts
db-cli versions <db> [--source <s>]          -- list versions
db-cli games <db> <version-id> [--search]    -- list games
db-cli roms <db> <game-id>                   -- list ROMs
```

---

## Server API

Base: `http://localhost:3001/api`

### Resources
- **Status & Platforms** — `GET /status`, `GET /platforms`
- **Collections** — CRUD + scan/verify/build/export (unified endpoint routes to correct CLI by source type)
- **Game Sets** — CRUD + games/export
- **Games** — list, detail (includes per-ROM `downloaded` flag), rating, cover, scrape
- **Versions** — list, games, available, import (DAT/online/NPS)
- **Scraper** — search, scrape, hash, test-connection
- **Jobs** — SSE progress, cancel
- **Downloads** — enqueue, list, SSE status, retry, clear
- **Settings** — read/write `.env`

### Long-running operations (SSE)
```
POST /api/collections/:id/build          → { "jobId": "uuid" }  (unified, scan=true for scan)
POST /api/collections/:id/scan|verify|build/:bid/run  → { "jobId": "uuid" }
GET  /api/jobs/:jobId                   → SSE progress stream
POST /api/jobs/:jobId/cancel            → kill child process
```

**SSE events:**
```
data: {"type":"progress","pct":30,"msg":"copying: Copying ROMs (500/1233)"}
data: {"type":"result","data":{"matched":1203,"missing":0,...}}
data: {"type":"error","error":"Build failed: ..."}
```

**Unified scan result format:**
```
{ exists: number, reused: number, missing: number }
```
- `reused` only for versioned collections (FBNeo/MAME), checked against prior version dirs
- NPS scans always return `reused: 0`

**Download endpoints:**
```
POST /api/downloads/enqueue             → { game_entry_id } queues all ROMs (game+dlc+update)
GET  /api/downloads                     → list queue
GET  /api/downloads/status              → SSE stream for queue changes
POST /api/downloads/:id/retry           → reset failed to pending
POST /api/downloads/:id/clear           → remove item
POST /api/downloads/clear-completed     → clear all completed/failed
```

## Download Manager

### Queue Processing

The download manager (`server/downloader.js`) is a singleton that processes one file at a time:
1. Fetch PKG URL with streaming, compute SHA-256 on the fly
2. Verify SHA-256 against expected hash
3. Move file to `data/roms/{collection_folder}/{platform}/{Games|DLCs|Updates}/{filename}`
4. Run `nps-cli scan --game-id <id>` to update `scanned_games`
5. Set `game_state.available = 1` for the game entry
6. Start next item in queue

**Retry logic:** Up to 3 retries before marking as failed.
**Timeout:** 120s per download via `AbortSignal.timeout(120000)`.

### Per-ROM Availability

Game detail API (`GET /api/games/:id`) includes `downloaded: bool` per ROM entry, checked against `download_queue` entries with `status='completed'`.

---

## Scraper Providers

| Provider | API | Auth | Platform Data | Genres | Screenshots |
|----------|-----|------|--------------|--------|-------------|
| **TheGamesDB** | v1 REST | Built-in key | ✅ name + alias | ❌ | ❌ |
| **IGDB (Twitch)** | v4 Apicalypse | OAuth Client Credentials | ✅ name + abbreviation | ✅ | ✅ |
| **ScreenScraper** | API v2 | Dev ID + Password | Unknown | Unknown | Unknown |
| **VGMuseum** | HTML scrape | None (browser UA) | ❌ | ❌ | ✅ ~13,766 games |
| **NoIntroPictures** | GitHub raw | None | ❌ | ❌ | ✅ covers/screenshots |
| **SonyStore** | PSN REST | None | ❌ | ❌ | ✅ screenshots |

### TGDB Details
- Base URL: `https://api.thegamesdb.net/v1`
- Platform data from `include.platform.data.{id}` (search: flat keys, detail: nested in `data`)
- Boxart from CDN: `https://cdn.thegamesdb.net/images/original/`
- Does not return genres/developers/publishers names via v1 API

### IGDB Details
- Token: `POST https://id.twitch.tv/oauth2/token` (client_credentials)
- API: `POST https://api.igdb.com/v4/games` (plain text body)
- Cover URLs: `//images.igdb.com/...` → prepended with `https:`
- Screenshots via `screenshots.url` field
- Platform abbreviation via `platforms.abbreviation` (skipped if same as name)

### VGMuseum Details
- Base URL: `https://www.vgmuseum.com/images/`
- Bot protection blocks requests with non-browser User-Agents — scraper uses `Mozilla/5.0 ... Chrome/120`
- `search_by_name` scrapes platform index pages (`{platform}_b.html`) for `<li><a>` game entries
- `get_game_detail` parses `<img>` tags from individual game pages (`{platform}/{dir}/{slug}.html`)
- Images are `.png` or `.gif`, served from same directory as the HTML page
- No metadata — screenshots only (endings screenshots, quality varies)
- URL patterns vary by platform: NES/SNES use two-digit subdirectories (`nes/01/`), Genesis is flat (`genesis/`)
- Some pages have missing `</a>` tags; parser uses `<br>` as fallback

---

## File Layout

```
gamemanager/
├── apps/
│   ├── scraper-cli/         Rust binary — game metadata scraping
│   ├── parse-cli/           Rust binary — DAT import
│   ├── build-cli/           Rust binary — ROM set build/verify (DAT-based)
│   ├── nps-cli/             Rust binary — NoPayStation scan/build
│   ├── db-cli/              Rust binary — DB inspection
│   └── rom-manager-ui/      React + Express web app
├── libs/
│   ├── rom-scraper/         Library — HTTP clients, API models, hashing
│   └── rom-manager/         Library — DB, DAT parsing, scanner, builder
├── data/                    Runtime data directory
│   ├── .env                 Environment variables (credentials, config)
│   ├── roms.db              SQLite database
│   ├── roms/                Built/downloaded ROM files
│   │   ├── {collection}/
│   │   │   ├── PSV/
│   │   │   │   ├── Games/
│   │   │   │   ├── DLCs/
│   │   │   │   └── Updates/
│   │   │   └── ...
│   ├── downloads/           Temp directory for in-progress downloads
│   └── media/               Downloaded scraper media
├── docs/
│   ├── specs.md             This file
│   ├── cli-reference.md     Full CLI command reference
│   ├── api-reference.md     Full server API reference
│   └── scraper-cli.md       Scraper-specific documentation
└── target/                  Rust build output
```

---

## Typical Workflow

### MAME Collection Example

```bash
# 1. Import DATs
parse-cli import mame0261.xml mame 0.261 --db data/roms.db
parse-cli import mame0262.xml mame 0.262 --db data/roms.db

# 2. Build ROM set
build-cli build mame /roms/import/ --base-dir /roms/ --db data/roms.db

# 3. Inspect database
db-cli summary data/roms.db
db-cli versions data/roms.db --source mame

# 4. Scan for missing ROMs
build-cli scan 1 /roms/mame --db data/roms.db
build-cli verify 1 /roms/mame --db data/roms.db

# 5. Scrape metadata for individual ROMs
scraper-cli scrape /roms/mame/sf2.zip --source igdb

# 6. Import new version, diff, upgrade
parse-cli import mame0263.xml mame 0.263 --db data/roms.db
build-cli diff 1 3 --db data/roms.db
build-cli build mame /roms/import/ --update --base-dir /roms/ --db data/roms.db
```

### OfflineList (No-Intro) Collection Example

OfflineList DATs from nointro.free.fr use a proprietary XML format with CRC32 checksums only (no MD5/SHA1).

```bash
# 1. Download DAT from http://nointro.free.fr
# 2. Import the DAT
parse-cli import "Official No-Intro Nintendo Gameboy.xml" offlinelist "Nintendo Gameboy" --db data/roms.db

# 3. Build ROM set (same as MAME)
build-cli build offlinelist-nintendo-gameboy /roms/import/ --base-dir /roms/ --db data/roms.db
```

### DAT-O-MATIC Collection Example

DAT-O-MATIC (datomatic.no-intro.org) provides No-Intro DATs in Logiqx XML format.

```bash
# Import via server (auto-download):
# POST /api/versions/import-online { collection_id: 1, version: "Nintendo - Game Boy", source: "DATOMATIC" }

# Build ROM set
build-cli build datomatic-nintendo-game-boy /roms/import/ --base-dir /roms/ --db data/roms.db
```

### NPS (NoPayStation) Collection Example

NPS provides PlayStation game PKG files for PSV, PS3, PSP, PSX, and PSM.

```bash
# 1. Import game list (fetches TSV from nopaystation.com)
nps-cli scan 1 /data/roms/nps-psv --db data/roms.db

# 2. Scan for downloaded files
nps-cli scan 6 /data/roms/nps-psv --db data/roms.db

# 3. Scan a single game after download
nps-cli scan 6 /data/roms/nps-psv --game-id 53978 --db data/roms.db

# 4. Build (copy/download PKG files into structured dirs)
nps-cli build 6 /data/roms/nps-psv --input-dir /path/to/pkgs --db data/roms.db
```

**NPS folder structure:**
```
data/roms/nps-psv/PSV/Games/<filename>.pkg
data/roms/nps-psv/PSV/DLCs/<filename>.pkg
data/roms/nps-psv/PSV/Updates/<filename>.pkg
```

### UI Workflow

```
1. Open web UI → collections list
2. Create "MAME" collection
3. Import DAT → Settings → Versions → Import
4. Start Build → loads DAT from DB → spawns build-cli
5. Watch progress bar → see matched/missing counts in real-time
6. Cancel if needed → clean exit → resume later
7. Close browser → build continues → reopen → auto-reconnects
```

---

## Key Design Decisions

1. **SQLite as single source of truth** — all state in `data/roms.db`, sharable between CLI and server
2. **CLIs are stateless processable** — each CLI reads DB, works, returns result. No daemons.
3. **Server spawns CLIs as child processes** — clean separation, cancellation via SIGTERM
4. **Delta version storage** — each version folder contains only ROMs unique to that version, saving disk space
5. **Idempotent builds** — any build can be re-run at any time, picking up where it left off
6. **Mode enforcement** — once a build mode is chosen for a source, it's locked in
7. **Hash-based ROM matching** — extract ZIP, hash internal files, compare against DAT's `rom_entries`
8. **sql.js in-memory DB** — server loads DB into memory at startup; autosave overwrites file edits
9. **CLIs write to `scanned_games`, server reads and updates `game_state`** — consistent pattern for NPS and DAT
10. **Reuse from prior version dirs** — server checks `{collectionDir}/{priorVersion}/roms/` for matched `.zip` files
11. **Per-ROM download status** — checked against `download_queue` completed entries, shown as ✓/✗ in ROM table
