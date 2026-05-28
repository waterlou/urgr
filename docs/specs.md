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
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │parse-cli │  │build-cli │  │scraper-  │  │db-cli    │ │
│  │          │  │          │  │  cli     │  │          │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
├───────┼─────────────┼─────────────┼─────────────┼───────┤
│       │       ┌─────┴─────┐       │             │       │
│       └───────┤ rom-manager│       │             │       │
│               │  (lib)    │       │             │       │
│               └─────┬─────┘       │             │       │
├─────────────────────┼─────────────┼─────────────┼───────┤
│                     │    SQLite   │             │       │
│                  roms.db          │             │       │
├───────────────────────────────────┼─────────────┼───────┤
│                                   │             │       │
│               ┌───────────────────┴─────────────┴─────┐ │
│               │           rom-scraper (lib)           │ │
│               │  TGDB / IGDB / ScreenScraper APIs     │ │
│               └───────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Crates

| Crate | Type | Purpose |
|-------|------|---------|
| `rom-scraper` | Library | HTTP clients, API models, scraper registry, hashing, filename parsing |
| `rom-manager` | Library | SQLite DB, DAT parsing, scanner, verifier, ROM set builder |
| `scraper-cli` | Binary | Game metadata scraping CLI |
| `parse-cli` | Binary | DAT file import CLI |
| `build-cli` | Binary | ROM collection build/scan/verify/diff CLI |
| `db-cli` | Binary | Database inspection CLI |
| `rom-manager-ui` | Web app | React frontend + Express API server |

---

## Data Model

### SQLite Tables

```
set_versions
  id          INTEGER PRIMARY KEY
  source      TEXT NOT NULL           -- e.g. "mame", "fbneo", "offlinelist", "datomatic"
  version     TEXT NOT NULL           -- e.g. "0.261", "2024-01-01"
  dir         TEXT                    -- ROM directory path
  created_at  TEXT
  UNIQUE(source, version)

game_entries
  id          INTEGER PRIMARY KEY
  version_id  INTEGER → set_versions  -- which DAT version
  name        TEXT NOT NULL           -- game short name (e.g. "sf2")
  description TEXT
  year        TEXT
  manufacturer TEXT                   -- e.g. "Capcom"
  cloneof     TEXT                    -- parent game name
  UNIQUE(version_id, name)

rom_entries
  id           INTEGER PRIMARY KEY
  game_entry_id INTEGER → game_entries
  filename     TEXT NOT NULL          -- ROM filename inside zip
  size         INTEGER
  crc32        TEXT
  md5          TEXT
  sha1         TEXT
  status       TEXT                   -- "good", "nodump", etc.
  merge_target TEXT
  UNIQUE(game_entry_id, filename)

scanned_games
  id          INTEGER PRIMARY KEY
  version_id  INTEGER → set_versions
  name        TEXT NOT NULL           -- game name
  filename    TEXT                    -- zip path on disk
  sha1        TEXT
  size        INTEGER
  status      TEXT                    -- "ok", "missing", "mismatch"
  UNIQUE(version_id, name)
```

### Foreign Key Cascades
```
DELETE FROM set_versions → cascades to game_entries → cascades to rom_entries
```

---

## CLI Tools

### `scraper-cli` — Game Metadata Scraper

Searches and scrapes game metadata from online providers. Outputs JSON to stdout.

| Command | Description |
|---------|-------------|
| `hash <file>` | Compute ROM hashes |
| `search <query>` | Search games by name |
| `scrape <file> [--download]` | Match a ROM, enrich via detail, optional media download |
| `detail <game-id> --source <s>` | Full game details by provider ID |

**Providers:** TheGamesDB (default, built-in key), IGDB (needs Client ID/Secret), ScreenScraper (untested, needs dev account).

**scrape flow:** hash → filename parse → hash search → name search → `get_game_detail` enrichment → optional download.

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
| `scan <id> <dir>` | Scan ROM directory → `scanned_games` |
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
- **Collections** — CRUD + scan/verify/build/export
- **Game Sets** — CRUD + games/export
- **Games** — list, detail, rating, cover
- **Versions** — list, games, available, import (DAT/online)
- **Scraper** — search, scrape, hash, test-connection
- **Jobs** — SSE progress, cancel
- **Settings** — read/write `.env`

### Long-running operations (SSE)
```
POST /api/collections/:id/scan|verify|build/:bid/run  → { "jobId": "uuid" }
GET  /api/jobs/:jobId                                   → SSE progress stream
POST /api/jobs/:jobId/cancel                            → kill child process
```

**SSE events:**
```
data: {"type":"progress","pct":30,"msg":"copying: Copying ROMs (500/1233)"}
data: {"type":"result","data":{"matched":1203,"missing":0,...}}
data: {"type":"error","error":"Build failed: ..."}
```

**Surviving builds:** CLI keeps running when browser tab closes. On page reload, finds builds with `status: "building"` and auto-reconnects SSE. Orphaned builds (server restart) reset to `failed`.

---

## Scraper Providers

| Provider | API | Auth | Platform Data | Genres | Screenshots |
|----------|-----|------|--------------|--------|-------------|
| **TheGamesDB** | v1 REST | Built-in key | ✅ name + alias | ❌ | ❌ |
| **IGDB (Twitch)** | v4 Apicalypse | OAuth Client Credentials | ✅ name + abbreviation | ✅ | ✅ |
| **ScreenScraper** | API v2 | Dev ID + Password | Unknown | Unknown | Unknown |

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

---

## File Layout

```
gamemanager/
├── apps/
│   ├── scraper-cli/         Rust binary — game metadata scraping
│   ├── parse-cli/           Rust binary — DAT import
│   ├── build-cli/           Rust binary — ROM set build/verify
│   ├── db-cli/              Rust binary — DB inspection
│   └── rom-manager-ui/      React + Express web app
├── libs/
│   ├── rom-scraper/         Library — HTTP clients, API models, hashing
│   └── rom-manager/         Library — DB, DAT parsing, scanner, builder
├── data/                    Runtime data directory
│   ├── .env                 Environment variables (credentials, config)
│   ├── roms.db              SQLite database
│   └── media/               Downloaded scraper media
│       └── <platform>-<year>-<title>/
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
scraper-cli scrape /roms/mame/sf2.zip --source igdb --download

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

DAT-O-MATIC (datomatic.no-intro.org) provides No-Intro DATs in Logiqx XML format. DATs are downloaded automatically via a three-step form flow.

```bash
# Import via server (auto-download):
# POST /api/versions/import-online { collection_id: 1, version: "Nintendo - Game Boy", source: "DATOMATIC" }

# Or import manually:
# 1. Download DAT from https://datomatic.no-intro.org/index.php?page=download
# 2. Import the DAT
parse-cli import "Nintendo - Game Boy.dat" datomatic "Nintendo - Game Boy" --db data/roms.db

# 3. Build ROM set
build-cli build datomatic-nintendo-game-boy /roms/import/ --base-dir /roms/ --db data/roms.db
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
