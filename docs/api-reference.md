# API Reference

Base URL: `http://localhost:3001/api`

All `POST`/`PUT` bodies are JSON. All responses are JSON.

---

## Status & Platforms

### `GET /status`
Database summary counts.

**Response:**
```json
{ "versions": 2, "games": 2466, "roms": 58444, "scanned": 0, "collections": 1, "game_sets": 0 }
```

### `GET /platforms`
List of known platform names.

---

## Collections

### `GET /collections`
List all ROM collections.

**Response:**
```json
[{ "id": 1, "name": "MAME", "icon": "..., "has_dataset": 1, ... }]
```

### `POST /collections`
Create a new collection.

**Body:** `{ "name": "MAME", "icon": "arcade", "folder": "mame", ... }`
**Response:** `{ "id": 1, ... }`

### `PUT /collections/:id`
Update collection metadata.

### `DELETE /collections/:id`
Delete collection and all linked data.

### `GET /collections/:id/games`
List games in the collection, with optional `?sort` and pagination.

### `POST /collections/:id/versions`
Link a version to the collection.

**Body:** `{ "version_id": 1 }`

### `DELETE /collections/:id/versions/:versionId`
Unlink a version from the collection.

### `POST /collections/:id/scan`
Scan a ROM directory. Returns `{ jobId }`, use SSE for progress.

**Body:** `{ "version_id": 1, "dir": "/roms/mame" }`
**Response:** `{ "jobId": "uuid" }`

### `POST /collections/:id/verify`
Verify ROM files against a DAT version with optional fallback.

**Body:** `{ "version_id": 1, "dir": "/roms/mame", "fallback_id": 2 }`
**Response:** `{ "jobId": "uuid" }`

### `GET /collections/:id/builds`
List all builds for the collection.

**Response:**
```json
[{ "id": 1, "version_id": 1, "status": "building", "games_total": 1233,
   "games_built": 500, "version": "0.28", "source": "mame", ... }]
```

### `POST /collections/:id/builds`
Start a new build entry (creates the build row, does NOT run it yet).

**Body:** `{ "version_id": 1, "format": "split" }`
**Response:** `{ "id": 1, "version_id": 1, "status": "not_started", ... }`

### `PUT /collections/:id/builds/:buildId`
Update build status and progress.

**Body:** `{ "status": "complete", "games_built": 1233 }`

### `POST /collections/:id/builds/:buildId/run`
Actually execute the build CLI. Spawns `build-cli build --progress`, returns jobId for SSE.

**Body:**
```json
{
  "source": "mame",
  "import_dir": "/roms/import/",
  "base_dir": "/roms/",
  "update": false
}
```
**Response:** `{ "jobId": "uuid" }`

### `POST /collections/:id/exports`
Generate an export manifest.

**Body:** `{ "format": "split", "version_id": 1 }`

---

## Game Sets

### `GET /game-sets`
List all game sets.

### `POST /game-sets`
Create a new game set.

### `PUT /game-sets/:id`
Update game set metadata.

### `DELETE /game-sets/:id`
Delete a game set.

### `GET /game-sets/:id/games`
List games in the set, with pagination.

### `POST /game-sets/:id/games`
Add a game to the set.

**Body:** `{ "game_entry_id": 42 }`

### `DELETE /game-sets/:id/games/:gameId`
Remove a game from the set.

### `GET /game-sets/:id/exports`
Export the game set.

---

## Games

### `GET /games`
List games, with optional `?search`, `?platform`, `?source`, `?limit`, `?offset`.

### `GET /games/:id`
Get a single game with full metadata and ROM info.

### `PUT /games/:id/rating`
Update a game's rating.

**Body:** `{ "rating": 4 }`

### `GET /games/:id/cover`
Get the primary cover image metadata.

---

## Versions

### `GET /versions`
List all version sets (from `set_versions` table).

**Response:**
```json
[{ "id": 1, "source": "mame", "version": "0.28", "total_games": 1233, "total_roms": 29290, "dir": "/roms/mame", ... }]
```

### `GET /versions/:id/games`
List games in a specific version set.

### `GET /versions/available`
Check for available DAT updates (MAME presets). Returns latest version + list of missing versions.

### `POST /versions/import-dat`
Import a DAT file. Wraps `parse-cli import`.

**Body:** `{ "file": "/path/to/mame.xml", "source": "mame", "version": "0.29", "dir": "/roms/mame" }`

### `POST /versions/import-online`
Download and import a DAT from the internet (MAME presets).

**Body:** `{ "version": "0.29" }`

---

## Scraper

### `POST /scraper/search`
Search games by name via a scraper provider.

**Body:** `{ "query": "Super Mario", "platform": "snes" }`
**Response:**
```json
{"results": [{"id":"136","title":"Super Mario World","platform":"Super Nintendo (SNES)","release_date":"1991-08-23"}]}
```

### `POST /scraper/scrape`
Scrape a ROM file. Computes hashes, searches by hash then filename, returns full metadata. Optionally downloads media.

**Body:** `{ "file": "/roms/smw.zip", "game_name": "Super Mario World", "platform": "snes" }`
**Response:**
```json
{
  "hashes": { "crc32": "...", "md5": "...", "sha1": "..." },
  "matched": {
    "id": "1070", "title": "Super Mario World", "platform": "Arcade",
    "description": "...", "publisher": "Nintendo", "genres": ["Platform"],
    "covers": ["https://..."], "screenshots": ["https://..."], ...
  }
}
```

### `POST /scraper/hash`
Compute ROM hashes only (no scrape).

**Body:** `{ "file": "/roms/smw.zip" }`

### Settings UI: Test Connection
Test provider credentials live:

- **`POST /settings/test-igdb`** — body: `{ "client_id": "...", "client_secret": "..." }` → `{ "ok": true/false, "error": "..." }`
- **`POST /settings/test-tgdb`** — body: `{ "api_key": "..." }` → `{ "ok": true/false, "error": "..." }`

---

## Jobs

Jobs track long-running CLI operations (scan, verify, build). Progress is pushed via **Server-Sent Events**.

### `GET /jobs/:jobId`
Subscribe to job progress via SSE.

**SSE events:**
```
data: {"type":"progress","pct":30,"msg":"Copying ROMs (500/1233)"}
data: {"type":"result","data":{...}}
data: {"type":"error","error":"Build failed: ..."}
data: {"type":"cancelled"}
```

If the job is already finished (not `running`), returns plain JSON:
```json
{ "type": "done", "data": { ... } }
```

### `POST /jobs/:jobId/cancel`
Cancel a running job. Sends `SIGTERM` to the CLI process (or calls `AbortController.abort()` for build jobs).

**Response:** `{ "ok": true }` or `{ "ok": false, "error": "Job not running" }`

---

## Settings

Settings are read/written to `data/.env`. Only whitelisted keys are exposed.

### `GET /settings`
Read current settings.

**Response:**
```json
{
  "SS_DEVID": "...",
  "IGDB_CLIENT_ID": "...",
  "TGDB_API_KEY": "...",
  "SCRAPER_SOURCE": "thegamesdb"
}
```

### `PUT /settings`
Save settings. Only whitelisted keys are written. Setting a value to `null`/`""` removes the key.

**Body:** `{ "IGDB_CLIENT_ID": "xxx", "SCRAPER_SOURCE": "igdb" }`
**Response:** `{ "ok": true }`

### Settings Keys
| Key | Description |
|-----|-------------|
| `SCRAPER_SOURCE` | Default scraper provider |
| `SS_DEVID` | ScreenScraper dev ID |
| `SS_DEVPASSWORD` | ScreenScraper dev password |
| `SS_USERNAME` | ScreenScraper username (optional) |
| `SS_PASSWORD` | ScreenScraper password (optional) |
| `IGDB_CLIENT_ID` | Twitch Client ID |
| `IGDB_CLIENT_SECRET` | Twitch Client Secret |
| `TGDB_API_KEY` | TheGamesDB API key (optional) |

---

## Common Patterns

### Long-running operations (scan, verify, build)
```
POST /api/collections/:id/scan       → { "jobId": "uuid" }
GET  /api/jobs/uuid                   → SSE stream with progress
POST /api/jobs/uuid/cancel            → Cancels the running job
```

### Build lifecycle
```
POST /api/collections/:id/builds      → Create build row (status: not_started)
POST /api/collections/:id/builds/:id/run → Execute build CLI, returns jobId
GET  /api/jobs/:jobId                 → SSE progress
POST /api/jobs/:jobId/cancel          → Cancel build
```

### Surviving builds across UI sessions
- Build CLI keeps running when UI tab is closed
- On page reload, fetch `GET /collections/:id/builds`, find any with `status: "building"`, reconnect SSE via `GET /jobs/:buildId`
- Orphaned builds (server restart) are reset to `failed` on startup
