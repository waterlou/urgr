# scraper-cli

Retro game metadata scraper supporting multiple providers.

## Commands

| Command | Description |
|---------|-------------|
| `hash <file>` | Compute ROM hashes (CRC32, MD5, SHA1) |
| `search <query>` | Search games by name |
| `scrape <file>` | Match a ROM file, return metadata |
| `detail <game-id>` | Get full game details by ID |
| `test` | Check connectivity to all configured providers |

## Options

| Flag | Description |
|------|-------------|
| `--source <s>` | Provider: `thegamesdb` (default), `screenscraper`, `igdb`, `no-intro-pictures`, `sony-store`, `vgmuseum` |
| `--platform <p>` | Platform filter (e.g. `nes`, `snes`, `arcade`) |

## Environment

Credentials may be set in `.env` (CWD) or `data/.env`. The server **Settings UI** saves to `data/.env`.

| Variable | Used By | Required |
|----------|---------|----------|
| `SCRAPER_SOURCE` | All | Default provider when `--source` not given |
| `IGDB_CLIENT_ID` | IGDB | Yes |
| `IGDB_CLIENT_SECRET` | IGDB | Yes |
| `SS_DEVID` | ScreenScraper | Yes |
| `SS_DEVPASSWORD` | ScreenScraper | Yes |
| `SS_USERNAME` | ScreenScraper | Optional |
| `SS_PASSWORD` | ScreenScraper | Optional |
| `TGDB_API_KEY` | TheGamesDB | No (built-in key active by default) |

## Provider Status

| Provider | Search | Scrape | Detail | Download | Notes |
|----------|--------|--------|--------|----------|-------|
| **TheGamesDB** | ✅ | ✅ | ✅ | ✅ | Built-in API key, zero-config |
| **IGDB (Twitch)** | ✅ | ✅ | ✅ | ✅ | Needs `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` in `.env` |
| **ScreenScraper** | ❌ | ❌ | ❌ | ❌ | Not tested — needs `SS_DEVID` + `SS_DEVPASSWORD` |
| **no-intro-pictures** | ⬜ placeholder | ❌ | ✅ covers/screenshots | ❌ | No auth needed. Fetch box art from GitHub raw URLs by platform + game name. |
| **sony-store** | ⬜ placeholder | ❌ | ✅ screenshots | ❌ | No auth needed. Fetch screenshots from PlayStation Store API via content_id. |
| **vgmuseum** | ✅ real search | ❌ | ✅ screenshots | ❌ | No auth needed. ~13,766 games across 50+ retro platforms. Uses browser User-Agent to bypass bot detection. |

## scrape Flow

1. Compute ROM hashes (CRC32, MD5, SHA1)
2. Parse filename (title, region) — uses `rom-scraper::parse_filename()`
3. Try hash-based lookup against all providers (priority order)
4. Fall back to filename-based search across all providers
5. **Enrich:** call `get_game_detail()` for full metadata (description, genres, screenshots, etc.)

## scrape Output Fields

| Field | TGDB | IGDB |
|-------|------|------|
| `id` | ✅ Numeric ID | ✅ Numeric ID |
| `title` | ✅ | ✅ |
| `platform` | ✅ Platform name (e.g. "Super Nintendo (SNES)") | ✅ Platform name (e.g. "Game Boy Advance") |
| `platform_short` | ✅ Alias (e.g. "super-nintendo-snes") | ✅ Abbreviation (e.g. "GBA"), empty if same as name |
| `description` | ⬜ Empty (API limitation) | ✅ Full description |
| `publisher` | ⬜ None (API limitation) | ✅ |
| `developer` | ⬜ None (API limitation) | ✅ |
| `genres` | ⬜ Empty (API limitation) | ✅ |
| `rating` | ✅ | ✅ |
| `covers` | ✅ Box art URLs | ✅ Cover URLs (`https:` prefixed) |
| `screenshots` | ⬜ None | ✅ Screenshot URLs |
| `release_date` | ✅ | ✅ |

## Examples

```bash
# Search with default source (TheGamesDB)
scraper-cli search "Super Mario"

# Search with a specific provider
scraper-cli search "Street Fighter" --source igdb --platform arcade
scraper-cli search "Zelda" --source thegamesdb

# Scrape a ROM file (matches by hash first, then filename, enriches via detail)
scraper-cli scrape ~/roms/smb.zip

# Scrape using a specific provider
scraper-cli scrape ~/roms/smb.zip --source igdb

# Get full game detail by provider ID
scraper-cli detail 1070 --source igdb
scraper-cli detail 136 --source thegamesdb

# Fetch box art from no-intro-pictures (free, no auth)
scraper-cli detail "nes/1942 (Japan, USA)" --source no-intro-pictures

# Fetch screenshots from VGMuseum (free, no auth, 50+ retro platforms)
scraper-cli detail "snes/01/smw" --source vgmuseum

# Test all providers
scraper-cli test
```

## Examples: VGMuseum

```bash
# Search for Mario games on NES
scraper-cli search "Mario" --source vgmuseum --platform nes

# Get Super Mario World screenshots
scraper-cli detail "snes/01/smw" --source vgmuseum

# Get Dr. Mario screenshots
scraper-cli detail "nes/01/drmario" --source vgmuseum

# Get a Genesis game
scraper-cli detail "genesis/1607" --source vgmuseum
```

## Output

### `test`
JSON object with `results` array:
```json
{
  "results": [
    {"name": "thegamesdb",       "status": "ok",      "message": "Search returned 20 games"},
    {"name": "screenscraper",    "status": "skipped",  "message": "Not configured (SS_DEVID / SS_DEVPASSWORD)"},
    {"name": "igdb",             "status": "ok",      "message": "Search returned 1 games"},
    {"name": "no-intro-pictures","status": "ok",      "message": "GitHub raw reachable (HTTP 200)"},
    {"name": "sony-store",       "status": "ok",      "message": "Store reachable (HTTP 200)"},
    {"name": "vgmuseum",         "status": "ok",      "message": "Index page returned 982 game entries"}
  ]
}
```

Status values: `ok` (working), `skipped` (not configured), `error` (unreachable or failed).

### `search`
JSON array of matches with `id`, `title`, `platform` (full name), `release_date`.

### `scrape`
JSON object with:
- `hashes` — CRC32, MD5, SHA1, file size, filename, parsed title/region
- `matched` — full metadata (description, publisher, developer, genres, rating, covers, screenshots, roms)

### `detail`
JSON with full game metadata including `synopsis` (truncated to 500 chars).

## Known Issues & Limitations

### TheGamesDB
- API v1 does **not** return genre, developer, or publisher data for most games
- No screenshot support
- Description/overview empty for many games
- Platform data uses alias format (e.g. "super-nintendo-snes") as short name

### IGDB
- Platform "Arcade" abbreviation is "Arcade" (same as name) — short_name set to empty
- Some games are associated with incorrect platforms in IGDB's database (e.g. Super Mario World showing as "Arcade")
- Screenshots require the `get_game_detail` enrichment call; not available in basic search

### VGMuseum
- Bot detection on `/images/` path — scraper uses browser-like User-Agent to bypass
- No metadata (descriptions, developer, etc.) — screenshots only
- HTML-based parsing (no API) — may break if site layout changes
- Some game pages are missing closing `</a>` tags — parser handles gracefully

### General
- Hash-based ROM matching requires actual ROM content — empty/dummy files won't match
- The `--source` flag now also restricts the scrape enrichment call to that provider only
- Protocol-relative IGDB URLs (`//images.igdb.com/...`) are auto-prefixed with `https:`

### `--dataset-preset` (scraper CLI)
Added to `search` and `detail` commands. Passes the collection's `dataset_preset` (`mame`, `fbneo`) to platform-dependent scrapers. Libretro-thumbnails uses it to pick the correct libretro folder: when platform is `arcade`/`mame` and dataset_preset is `fbneo`, it looks in `FBNeo - Arcade Games` instead of `MAME`.

### `--no-clear` (parse CLI)
Skips `clear_game_roms_for_version` before importing. Used when importing multiple per-system DATs into the same version (FBNeo multi-DAT imports) so that the second DAT doesn't wipe the first DAT's game ROM sets. Without this flag, each DAT import clears all existing `game_rom_sets` for that version.

## Build System (build-cli)

### Platform-Aware Import Directory

The import directory can contain platform subdirectories for disambiguating games with the same name across different platforms. When a zip file sits under a known platform folder, the builder indexes it by both name and platform:

```
import/
├── arcade/
│   └── zoom909.zip
├── msx/
│   └── zoom909.zip
└── sg1000/
    └── zoom909.zip
```

Known platform folders: `arcade`, `coleco`, `fds`, `gamegear`, `megadriv`, `msx`, `neogeo`, `nes`, `ngp`, `pce`, `sg1000`, `sgx`, `sms`, `tg16`, `zxspectrum`.

Games in the output directory are stored in platform subdirectories (e.g., `roms/arcade/zoom909.zip`, `roms/msx/zoom909.zip`) — same convention as the import.

### Samples Directory

Sample files are copied to `{version_dir}/samples/`. The build creates this directory automatically if any sample files are found in the import directory.

## Server-side Scrape Orchestration

## Server-side Scrape Orchestration

The server (`server/routes/games.js`) wraps the Rust CLI and adds per-collection control:

### Per-Collection Scrape Source Priority

Each collection has a `scrape_source_priority` field (JSON array of source names). This is set via the collection's **Scrape Source Order** settings UI tab.

Controls two things:
1. **Which sources are used during scraping** — `scrapeSingleGame()` currently tries ArcadeDB first for arcade games, then searches across all configured sources. (Respecting the priority order during scraping is a future enhancement.)
2. **Which media is displayed** — The `getEnabledSourceSet(versionId)` helper reads the priority and filters media at display time in all serving paths:
   - Collection game listing (`GET /api/collections/:id/games`)
   - Game detail (`GET /api/games/:id`)
   - Individual media (`GET /api/games/:id/media`, `GET /api/games/:id/cover`)
   - Global game list (`GET /api/games`)

### Source-aware `game_media` Entries

The `game_media` table has a `source TEXT` column (default `''`) that tracks which scraper created each entry:

| Source | Set By |
|--------|--------|
| `arcadedb` | `scrapeSingleGame()` from `first.source` |
| `thegamesdb` | `scrapeSingleGame()` from `first.source` |
| `screenscraper` | `scrapeSingleGame()` from `first.source` |
| `igdb` | `scrapeSingleGame()` from `first.source` |
| `libretro-thumbnails` | `scrapeSingleGame()` from `first.source` |
| `no-intro-pictures` | No-Intro fallback in `scrapeSingleGame()` |
| `sony-store` | NPS fanart fetch in `scrapeSingleGame()` |
| `progettosnaps` | `serveGameMedia()` when serving pre-downloaded files |
| `''` (empty) | Legacy entries created before this column existed |

Behavior:
- `scrape_source_priority = null` (not configured) → all sources allowed (backward compatible)
- `scrape_source_priority = []` (empty) → no media shown
- `scrape_source_priority = ["arcadedb"]` → only ArcadeDB entries from `game_media` shown
- Legacy entries with `source = ''` are **excluded** when `scrape_source_priority` is explicitly set, to avoid showing media from unknown sources

### Media Serving Flow

```
GET /api/games/:id/media?type=title
  │
  ├─ Check progettosnaps pre-downloaded files (if source is enabled)
  │   data/media/progettosnaps/title/<game.name>.png
  │
  ├─ Check game_media for stored URLs (filtered by enabled sources)
  │   → getMedia() fetches/returns cached file
  │   → On first fetch, saves to data/media/<source>/<game>/ and stores localUrl
  │
  └─ Fallback: SVG placeholder (for cover only) or 404
```

### ProgettoSnaps (Pre-downloaded Media)

Not a real scraper — no Rust CLI, no API. Images are downloaded via the Settings UI's **ProgettoSnaps (MAME Images)** operation:

1. Downloads `pS_snap_fullset_287.zip` and `pS_titles_fullset_287.zip` from `progettosnaps.net`
2. Extracts nested `.7z` archives inside the zips
3. PNGs extracted to `data/media/progettosnaps/snap/<game>.png` and `data/media/progettosnaps/title/<game>.png`
4. Only works for MAME collections (source = `mame`)

When a progettosnaps file exists for a game, it takes priority over scraped URLs in all serving paths (controlled by the `progettosnaps` source toggle in the scrape priority UI).

### Media Caching

After the first successful fetch of a remote URL, the `getMedia()` function in `server/mediaCache.js`:

1. Saves the file to `data/media/<source>/<gameName>/<mediaType>.<ext>`
2. Updates the `game_media` URL to point to the local path (`/media/<source>/...`)
3. Future requests are served directly by `express.static` (no network fetch)

Cache directories:
- `data/media/arcadedb/`
- `data/media/libretro-thumbnails/`
- `data/media/sony-store/`
- `data/media/igdb/`
- `data/media/progettosnaps/`

## Source Platform Dependencies

| Source | Works On | Reason |
|--------|----------|--------|
| **ArcadeDB** | MAME arcade only | Uses MAME short names for lookup |
| **ProgettoSnaps** | MAME arcade only | Pre-downloaded sets named by MAME short name |
| **SonyStore** | NPS (PSN) only | Looks up by PSN content_id / title_id |
| **LibretroThumbnails** | All libretro-supported platforms | Folder structure mirrors libretro platform slugs |
| **NoIntroPictures** | No-Intro / DAT-O-MATIC collections | Uses No-Intro naming conventions |
| **VGMuseum** | 50+ retro platforms (NES, SNES, Genesis, etc.) | Mapped explicitly in Rust source |
| **TheGamesDB** | All platforms | API-based, platform-agnostic |
| **IGDB** | All platforms | API-based, platform-agnostic |
| **ScreenScraper** | All platforms | API-based, platform-agnostic |

## Test Coverage

20 unit tests in `apps/scraper-cli/src/main.rs`:
- `truncate` — 5 tests (short, exact, long, empty, zero)
- `parse_source` — 8 tests (flags, env var, fallback, override)
- `game_to_match` — 3 tests (fields, covers/screenshots, roms)
- Serialization — 3 tests (ScrapeMatch, DetailOutput, SearchResult)
