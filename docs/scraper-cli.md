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
| `--source <s>` | Provider: `thegamesdb` (default), `screenscraper`, `igdb` |
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

## Examples

```bash
# Search with default source (TheGamesDB)
scraper-cli search "Super Mario"

# Search with a specific provider
scraper-cli search "Street Fighter" --source igdb --platform arcade
scraper-cli search "Zelda" --source thegamesdb

# Scrape a ROM file (matches by hash first, then filename)
scraper-cli scrape ~/roms/smb.zip

# Scrape + download cover images
scraper-cli scrape ~/roms/smb.zip --download

# Scrape using a specific provider
scraper-cli scrape ~/roms/smb.zip --download --source igdb

# Get full game detail by provider ID
scraper-cli detail 1070 --source igdb
scraper-cli detail 136 --source thegamesdb
```

## Output

### `search`
JSON array of matches with `id`, `title`, `platform`, `release_date`.

### `scrape`
JSON object with:
- `hashes` — CRC32, MD5, SHA1, file size, filename, parsed title/region
- `matched` — full metadata (description, publisher, developer, genres, rating, covers, screenshots, roms)
  - `downloaded` — list of local file paths (only present when `--download` used)

### `detail`
JSON with full game metadata.

## Notes

- The `--source` flag restricts the query to a single provider. Without it, the first provider in priority order that returns results is used.
- TheGamesDB has a built-in API key; no configuration required.
- IGDB uses Twitch OAuth (Client Credentials grant). Get credentials at https://dev.twitch.tv/console/apps.
- ScreenScraper requires a free account at https://www.screenscraper.fr.
- Protocol-relative URLs from IGDB (`//images.igdb.com/...`) are automatically prefixed with `https:` when downloading.
- Downloaded media directory format: `data/media/<platform>-<year>-<title_slug>/`.
