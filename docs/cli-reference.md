# CLI Reference

Five CLI tools operate on the `data/roms.db` SQLite database (plus `ia-cli` for Internet Archive):

| CLI | Purpose | Writes to DB | Reads from DB |
|-----|---------|-------------|---------------|
| [`parse-cli`](#parse-cli) | Import DAT files | `set_versions`, `game_entries`, `rom_entries` | — |
| [`build-cli`](#build-cli) | Build/verify ROM collections | `scanned_games` | `set_versions`, `game_entries`, `rom_entries` |
| [`scraper-cli`](#scraper-cli) | Scrape game metadata | — (outputs JSON) | — |
| [`db-cli`](#db-cli) | Inspect database | — | All tables |
| [`ia-cli`](#ia-cli) | Search/download from Internet Archive | — (outputs JSON) | — |

---

## Database Schema

```
set_versions  (id, source, version, dir, created_at)  — imported DAT sets
game_entries  (id, version_id, name, description, year, manufacturer, cloneof)
rom_entries   (id, game_entry_id, filename, size, crc32, md5, sha1, status, merge_target)
scanned_games (id, version_id, name, filename, sha1, size, status)
meta          (key, value)
```

Relationships:
```
set_versions  ─< game_entries ─< rom_entries
set_versions ─< scanned_games
```

---

## parse-cli

**Purpose:** Import ROM DAT files into the database as versioned sets.

### Usage
```
parse-cli import <file> <source> <version> [--dir <dir>] [--json] --db <path>
```

### Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `<file>` | path | DAT file (.dat, .xml, .txt) — auto-detects MAME listxml, Logiqx XML, ClrMAMEPro, OfflineList XML |
| `<source>` | string | Source label (e.g., `mame`, `fbneo`, `offlinelist`, `datomatic`) |
| `<version>` | string | Version identifier stored verbatim (e.g., `0.261`, `2024-01-01`, `Nintendo Game Boy`) |

### Options

| Flag | Description |
|------|-------------|
| `--dir <dir>` | Base directory for ROM files, stored on the version row |
| `--db <path>` | SQLite database path (required, or `$ROM_DB` env) |
| `--json` | Output import summary as JSON |

### Behavior

1. Opens the DAT file, auto-detects format (MAME ListXML / Logiqx XML / ClrMAMEPro / OfflineList XML)
2. Parses all `<game>`/`<machine>` entries into `GameEntry` records
3. Parses all `<rom>` entries, linked to their parent game
4. Creates a row in `set_versions` with the given source and version
5. Inserts all games into `game_entries` (upserted on `version_id, name`)
6. Inserts all ROMs into `rom_entries` (upserted on `game_entry_id, filename`)
7. Prints summary: games parsed, ROMs parsed, games/ROMs inserted, version ID

### Duplicate Import Behavior
| Table | Conflict handling |
|-------|------------------|
| `set_versions` | `INSERT OR IGNORE` — returns existing ID, skips |
| `game_entries` | `ON CONFLICT(version_id, name) DO UPDATE` — updates fields |
| `rom_entries` | `ON CONFLICT(game_entry_id, filename) DO UPDATE` — updates hashes |

### Output (JSON mode)
```json
{
  "format": "MameListXml",
  "total_games_parsed": 50000,
  "total_roms_parsed": 400000,
  "games_inserted": 50000,
  "roms_inserted": 400000,
  "version_id": 1,
  "warnings": []
}
```

### Examples
```bash
parse-cli import mame.xml mame 0.261 --db roms.db
parse-cli import fbneo.dat fbneo 1.0.3 --dir /roms/fbneo --db roms.db
parse-cli import "Official No-Intro Nintendo Gameboy.xml" offlinelist "Nintendo Gameboy" --json --db roms.db
parse-cli import "Nintendo - Game Boy.dat" datomatic "Nintendo - Game Boy" --json --db roms.db
```

---

## build-cli

**Purpose:** Build, scan, verify, and diff ROM collections against DAT versions.

### Commands

| Command | Description |
|---------|-------------|
| `dat list` | List all imported version sets |
| `dat info <version-id>` | Show details for a version set |
| `scan <version-id> <dir>` | Scan ROM directory, record found/missing in `scanned_games` |
| `verify <version-id> <dir> [--fallback <id>]` | Verify ROM hashes against DAT, check fallback versions |
| `diff <version-id-a> <version-id-b>` | Compare two version sets |
| `build <source> <import-dir> [--update] [--base-dir <dir>] [--progress]` | Build ROM collection |

### `build <source> <import-dir>`

Automatically detects the latest version for `<source>` from `set_versions` and builds a ROM collection.

**Arguments:**
- `<source>` — source label from `parse-cli import`
- `<import-dir>` — directory containing ROM zip files to match from

**Options:**
| Flag | Description |
|------|-------------|
| `--base-dir <dir>` | Root directory for collection folders (default: `.`) |
| `--update` | In-place upgrade mode — renames old folder, deletes old version from DB |
| `--progress` | Emit JSON progress lines to stderr for live monitoring |
| `--json` | Output build result as JSON |
| `--db <path>` | Database path (required, or `$ROM_DB` env) |

**Modes:**

#### Collect mode (default)
Each version gets its own delta folder. Only new and changed ROMs are stored per version. Unchanged ROMs remain in the previous version's folder.

```
base/mame/0.261/   ← ROMs unique to 0.261 (new + changed)
base/mame/0.260/   ← ROMs unique to 0.260 (unchanged stay here)
```

#### Update mode (`--update`)
In-place upgrade. The previous version folder is renamed to the new version. Changed/removed ROMs move to `deleted_roms/`. New ROMs copied from import folder. After build, only the latest version folder exists and the old version row is deleted from the DB.

```
base/mame/0.260/  → renamed to 0.261/
Old version deleted from set_versions (cascades to games/roms)
```

### Build Process (Phase Order)

| Phase | Progress % | Description |
|-------|-----------|-------------|
| loading | 0-5 | Read versions from DB, enforce mode consistency |
| diff | 5-10 | Compare against previous version |
| setup | 10-15 | Create/rename folders |
| cleanup | 15-20 | Remove old/changed ROMs to `deleted_roms/` |
| index | 20-30 | Build hash index of import folder |
| copying | 30-95 | Match and copy ROMs (hash-verified) |
| saving | 95-98 | Write status files |
| done | 100 | Complete |

### Matching Logic
1. For each game in `need_copy`: try `<game_name>.zip` in import folder
2. Extract the zip, hash all internal files (SHA1 via `rom_scraper::compute_hashes_from_bytes`)
3. Compare against expected hashes from `rom_entries`
4. If all expected ROMs found → copy zip to collection folder
5. If not found → mark as missing

### Idempotency
The build is safe to re-run at any time:
- Already-copied ROMs with correct hashes → skipped
- Folder rename only happens once
- Status/progress files track last state
- `_build_status.json` and `_build_progress.json` persist across runs

### Mode Enforcement
Once a build mode is chosen for a source, it's enforced across all future builds. Stored in `_build_mode.json` at the source level (e.g., `base/mame/_build_mode.json`).

### Cancellation & Progress (`--progress`)
- JSON progress lines emitted to stderr each phase
- `SIGTERM`/`SIGINT` sets cancel flag → builder returns early at next phase boundary
- Progress file `_build_progress.json` written after each phase for resume

### File Layout
```
<base>/
├── <source>/
│   ├── <version>/
│   │   ├── game1.zip
│   │   ├── game2.zip
│   │   ├── _build_status.json
│   │   └── _build_progress.json
│   └── _build_mode.json
└── deleted_roms/
    ├── game_v0.260.zip
    └── ...
```

### Output (text mode)
```
Built mame 0.29 (update mode)
  from v0.28 → v0.29
  total:     9632
  matched:   9582 (copied)
  unchanged: 0 (kept from prev)
  missing:   50
  cleaned:   130 (moved to deleted_roms)
```

### Output (JSON mode)
```json
{
  "source": "mame",
  "version": "0.29",
  "mode": "update",
  "prev_version": "0.28",
  "total_games": 9632,
  "matched": 9582,
  "unchanged": 0,
  "missing": 50,
  "cleaned": 130,
  "missing_games": ["game_a", "game_b"]
}
```

### Other Commands

**`scan <version-id> <dir>`**
Walks a ROM directory looking for `<game_name>.zip` files matching games in the DAT. Computes SHA1 of each zip, records status in `scanned_games`.

**`verify <version-id> <dir> [--fallback <id>]`**
Reads `scanned_games` and checks each game against the DAT. If `--fallback` is given, searches the fallback version's ROM files for missing games (inherited status).

**`diff <version-id-a> <version-id-b>`**
Compares game lists and ROM hashes between two versions. Returns: added, removed, changed (same name, different ROMs), unchanged.

---

## ia-cli

**Purpose:** Search and download ROM files from Internet Archive. Used by the web UI's "Download from Internet Archive" button.

### Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search IA items by query string |
| `list <id> [--filter <name>]` | List files in an IA item |
| `download <id> <path> -o <dir>` | Direct download from an IA item |
| `find <source> <game> [--version <v>]` | Search, find, and download a game ROM |

### `find <source> <game>`

**Search strategy (tried in order):**
1. If `--cached-id` provided → check that IA item first
2. Search `"{source} {version} roms"` (version-specific, e.g. "MAME 0.287 roms")
3. Search `"{source} roms"` (generic, e.g. "MAME roms")
4. Search by game name directly (e.g. "1943kai")
5. For each result: fetch item metadata, find file matching game name

**Options:**

| Flag | Description |
|------|-------------|
| `--version <v>` | Version string for targeted search (e.g. "0.287") |
| `--cached-id <id>` | IA item identifier to check first (avoids search) |
| `--crc <name:crc,...>` | Comma-separated expected CRCs for verification (e.g. "1943kai.01:7544B926,1943kai.02:DBA1C66E") |
| `--output <dir>` | Directory to save downloaded file |
| `--username <u>` | IA email for private file access |
| `--password <p>` | IA password |

**CRC verification:**
- Downloads the ZIP to a temp directory
- Reads entry CRCs from zip headers (no decompression, same as scanner)
- Compares against expected CRCs from `rom_entries`
- On mismatch: rejects the download, provides `download_url` for manual inspection
- On match: moves file to final destination

**Output (single JSON line on stdout):**

Success:
```json
{"ok":true,"file":"1943kai.zip","size":313346,"path":"/data/roms/mame/0.287/roms/1943kai.zip","identifier":"mame-roms-non-merged","cached_id":"mame-roms-non-merged","crc_match":true,"download_url":"https://archive.org/download/mame-roms-non-merged/MAME%20ROMs%20(non-merged)/1943kai.zip"}
```

Game not found:
```json
{"ok":false,"error":"Game not found on Internet Archive","tried_items":["item1","item2"]}
```

CRC mismatch:
```json
{"ok":false,"error":"CRC mismatch","crc_mismatches":[{"file":"1943kai.01","expected":"ABCD1234","got":"5678EF90"}],"download_url":"https://archive.org/download/.../1943kai.zip"}
```

### Examples
```bash
# Download a game named 1943kai from MAME 0.287
ia-cli find MAME 1943kai --version 0.287 --output /roms/mame

# With CRC verification
ia-cli find MAME 1943kai --version 0.287 --crc "1943kai.01:7544B926,1943kai.02:DBA1C66E" --output /roms/mame

# With authenticated access to private files
ia-cli find MAME 1943kai --version 0.287 --username user@example.com --password mypass --output /roms/mame

# Skip search, check a known IA item directly
ia-cli find MAME 1943kai --cached-id mame-roms-non-merged --output /roms/mame

# List files in an IA item
ia-cli list mame-roms-non-merged --filter 1943kai

# Search IA for items
ia-cli search "MAME 0.287 roms"
```

---

## scraper-cli

**Purpose:** Scrape retro game metadata from online providers. Outputs JSON to stdout, optionally downloads media.

### Commands

| Command | Description |
|---------|-------------|
| `hash <file>` | Compute ROM hashes (CRC32, MD5, SHA1) |
| `search <query>` | Search games by name |
| `scrape <file>` | Match a ROM file and return metadata |
| `detail <game-id>` | Get full game details by ID |

### Options

| Flag | Description |
|------|-------------|
| `--source <s>` | Provider: `thegamesdb` (default), `screenscraper`, `igdb` |
| `--platform <p>` | Platform filter (e.g., `nes`, `snes`, `arcade`) |
| `--download` | Download cover/screenshot images to `data/media/` |

### Providers

| Provider | Status | Config Needed | Notes |
|----------|--------|--------------|-------|
| **TheGamesDB** | ✅ Tested | None (built-in key) | Platform data, covers. No genres/descriptions for most games. |
| **IGDB (Twitch)** | ✅ Tested | `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` | Full metadata: description, genres, publisher, developer, screenshots. |
| **ScreenScraper** | ❌ Untested | `SS_DEVID` + `SS_DEVPASSWORD` | Requires dev account. |

### Environment

Credentials via `.env` (CWD) or `data/.env`. See [`docs/scraper-cli.md`](scraper-cli.md) for full setup.

### `scrape <file> [--download] [--source <s>]`

**Flow:**
1. Compute ROM hashes (CRC32, MD5, SHA1)
2. Parse filename for title and region
3. Try hash-based lookup in the provider
4. Fall back to filename-based search
5. Call `get_game_detail` to enrich with full metadata (description, screenshots, genres, etc.)
6. If `--download`: download cover and screenshot images to `data/media/<platform>-<year>-<title>/`

### Output fields (`scrape` match)

| Field | TGDB | IGDB |
|-------|------|------|
| `id` | ✅ Numeric ID | ✅ Numeric ID |
| `title` | ✅ | ✅ |
| `platform` | ✅ Platform name (e.g., "Super Nintendo (SNES)") | ✅ Platform name (e.g., "Game Boy Advance") |
| `platform_short` | ✅ Alias (e.g., "super-nintendo-snes") | ✅ Abbreviation (e.g., "GBA"), empty if same as name |
| `description` | ⬜ Empty (API limitation) | ✅ Full description |
| `publisher` | ⬜ None (API limitation) | ✅ |
| `developer` | ⬜ None (API limitation) | ✅ |
| `genres` | ⬜ Empty (API limitation) | ✅ |
| `rating` | ✅ | ✅ |
| `covers` | ✅ Box art URLs | ✅ Cover URLs (`https:` prefixed) |
| `screenshots` | ⬜ None | ✅ Screenshot URLs |
| `release_date` | ✅ | ✅ |

---

## db-cli

**Purpose:** Inspect and query the SQLite database from the command line.

### Commands

| Command | Description |
|---------|-------------|
| `summary <db>` | Show row counts for all tables |
| `versions <db> [--source <s>]` | List version sets |
| `games <db> <version-id> [--search <q>] [--limit <n>]` | List games in a version |
| `roms <db> <game-id>` | List ROM entries for a game |

### Examples
```bash
db-cli summary roms.db
db-cli versions roms.db --source mame
db-cli games roms.db 1 --search "1942" --limit 20
db-cli roms roms.db 42
```

---

## Typical Workflow

```bash
# 1. Import a DAT
parse-cli import mame0261.xml mame 0.261 --db roms.db

# 2. Inspect
db-cli summary roms.db

# 3. Build the ROM collection
build-cli build mame /roms/import/ --base-dir /roms/ --db roms.db

# 4. Scan for missing ROMs
build-cli scan 1 /roms/mame --db roms.db
build-cli verify 1 /roms/mame --fallback 2 --db roms.db

# 5. Scrape metadata for a ROM
scraper-cli scrape /roms/mame/sf2.zip --source igdb --download

# 6. Import a new version
parse-cli import mame0262.xml mame 0.262 --db roms.db

# 7. Diff versions
build-cli diff 1 2 --db roms.db

# 8. Upgrade collection
build-cli build mame /roms/import/ --update --base-dir /roms/ --db roms.db
```

### Cancellation & Progress (Server Integration)

When called from the UI server:
1. CLI spawned with `--progress` flag → JSON progress lines on stderr
2. Server parses stderr, broadcasts via SSE to UI
3. Cancel button → `AbortController.abort()` → `SIGTERM` → CLI cleanly exits
4. Build survives UI close — re-open auto-reconnects to running job
5. Orphaned builds reset to `failed` on server restart
