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

## Test Coverage

20 unit tests in `apps/scraper-cli/src/main.rs`:
- `truncate` — 5 tests (short, exact, long, empty, zero)
- `parse_source` — 8 tests (flags, env var, fallback, override)
- `game_to_match` — 3 tests (fields, covers/screenshots, roms)
- Serialization — 3 tests (ScrapeMatch, DetailOutput, SearchResult)
