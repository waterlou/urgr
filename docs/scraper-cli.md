# scraper-cli

Retro game metadata scraper supporting multiple providers.

## Commands

| Command | Description |
|---------|-------------|
| `hash <file>` | Compute ROM hashes (CRC32, MD5, SHA1) |
| `search <query>` | Search games by name |
| `scrape <file>` | Match a ROM file, return metadata + optional media download |
| `detail <game-id>` | Get full game details by ID |

## Options

| Flag | Description |
|------|-------------|
| `--source <s>` | Provider: `thegamesdb` (default), `screenscraper`, `igdb`, `no-intro-pictures` |
| `--platform <p>` | Platform filter (e.g. `nes`, `snes`, `arcade`) |
| `--download` | Download cover/screenshot media to `data/media/<platform>-<year>-<title_slug>/` |

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
| **no-intro-pictures** | ⬜ placeholder | ❌ | ✅ covers/screenshots | ❌ | No auth needed. Fetch box art from GitHub raw URLs. `search` returns placeholder; `detail` fetches images by platform + game name. |

## scrape Flow

1. Compute ROM hashes (CRC32, MD5, SHA1)
2. Parse filename (title, region) — uses `rom-scraper::parse_filename()`
3. Try hash-based lookup against the provider
4. Fall back to filename-based search
5. **Enrich:** call `get_game_detail()` for full metadata (description, genres, screenshots, etc.)
6. If `--download`: download cover and screenshot images

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
| `downloaded` | Only with `--download` | Only with `--download` |

## Examples

```bash
# Search with default source (TheGamesDB)
scraper-cli search "Super Mario"

# Search with a specific provider
scraper-cli search "Street Fighter" --source igdb --platform arcade
scraper-cli search "Zelda" --source thegamesdb

# Scrape a ROM file (matches by hash first, then filename, enriches via detail)
scraper-cli scrape ~/roms/smb.zip

# Scrape + download cover images
scraper-cli scrape ~/roms/smb.zip --download

# Scrape using a specific provider
scraper-cli scrape ~/roms/smb.zip --download --source igdb

# Get full game detail by provider ID
scraper-cli detail 1070 --source igdb
scraper-cli detail 136 --source thegamesdb

# Fetch box art from no-intro-pictures (free, no auth)
scraper-cli detail "nes/1942 (Japan, USA)" --source no-intro-pictures
```

## Output

### `search`
JSON array of matches with `id`, `title`, `platform` (full name), `release_date`.

### `scrape`
JSON object with:
- `hashes` — CRC32, MD5, SHA1, file size, filename, parsed title/region
- `matched` — full metadata (description, publisher, developer, genres, rating, covers, screenshots, roms)
  - `downloaded` — list of local file paths (only present when `--download` used)

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

### General
- Hash-based ROM matching requires actual ROM content — empty/dummy files won't match
- The `--source` flag now also restricts the scrape enrichment call to that provider only
- Protocol-relative IGDB URLs (`//images.igdb.com/...`) are auto-prefixed with `https:`

## Test Coverage

30 unit tests in `apps/scraper-cli/src/main.rs`:
- `slugify` — 6 tests (basic, uppercase, special chars, slugged, truncation, trim underscores)
- `normalize_url` — 3 tests (https, protocol-relative, http)
- `truncate` — 5 tests (short, exact, long, empty, zero)
- `parse_source` — 8 tests (flags, env var, fallback, override)
- `game_to_match` — 4 tests (fields, covers/screenshots, roms, downloaded)
- Serialization — 3 tests (ScrapeMatch, DetailOutput, SearchResult)
