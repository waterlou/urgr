# ROM Manager UI — API Documentation

Base URL: `http://localhost:3001/api`

---

## Status

### GET /api/status

Returns row counts from all key tables.

**Response `200`**
```json
{
  "versions": 2,
  "games": 0,
  "roms": 0,
  "scanned": 0,
  "collections": 6,
  "game_sets": 0
}
```

---

## Platforms (reference)

### GET /api/platforms

Known platform list.

**Response `200`**
```json
[
  "Arcade", "Multi", "NES", "SNES", "Nintendo 64",
  "Game Boy", "Game Boy Color", "Game Boy Advance",
  "Nintendo DS", "Nintendo 3DS", "Sega Genesis",
  "Sega Saturn", "Sega Dreamcast", "PlayStation",
  "PlayStation 2", "PlayStation Portable", "MSX",
  "Commodore 64", "Amiga", "Atari 2600", "Atari 7800",
  "TurboGrafx-16", "Neo Geo", "Neo Geo Pocket", "WonderSwan"
]
```

---

## Collections

### GET /api/collections

Lists all collections sorted by name, with computed game count from linked versions.

**Response `200`**
```json
[
  {
    "id": 1,
    "name": "MAME",
    "slug": "mame",
    "platform": "Arcade",
    "logo": "🕹️",
    "folder": "mame",
    "dataset_preset": null,
    "has_dataset": 1,
    "created_at": "2026-05-23 03:24:22",
    "updated_at": "2026-05-23 03:24:22",
    "total_games": 0
  }
]
```

---

### POST /api/collections

Creates a new collection. Slug is auto‑deduplicated if it already exists.

**Request Body**
```json
{
  "name": "MAME 0.287",
  "slug": "mame-0287",
  "platform": "Arcade",
  "logo": "🕹️",
  "folder": "mame",
  "has_dataset": 1,
  "dataset_preset": "MAME",
  "uploaded_version_id": null
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Display name |
| `slug` | Yes | URL‑friendly identifier (deduped if taken) |
| `platform` | No | e.g. "Arcade", "NES" |
| `logo` | No | Emoji icon (default "📁") |
| `folder` | No | Filesystem folder name (defaults to slug) |
| `has_dataset` | No | 1 for hash‑managed collections |
| `dataset_preset` | No | "MAME", "Final Burn Neo", etc. |
| `uploaded_version_id` | No | If set, links the version immediately |

**Response `201`**
```json
{
  "id": 7,
  "name": "MAME 0.287",
  "slug": "mame-0287",
  "platform": "Arcade",
  "logo": "🕹️",
  "folder": "mame",
  "has_dataset": 1,
  "created_at": "2026-05-23 03:24:26",
  "updated_at": "2026-05-23 03:24:26"
}
```

---

### PUT /api/collections/:id

Partial update of collection fields.

**Request Body**
```json
{
  "name": "MAME Updated",
  "platform": "Arcade",
  "logo": "🎮",
  "folder": "mame-updated"
}
```

All fields optional. Only provided fields are updated. Sets `updated_at` to current timestamp.

**Response `200`** — full updated collection row.

---

### DELETE /api/collections/:id

Deletes a collection and its version links (CASCADE).

**Response `200`**
```json
{ "ok": true }
```

---

### GET /api/collections/:id/games

Paginated games for a collection. Games are gathered from all versions linked to the collection.

**Query Parameters**
| Param | Default | Description |
|---|---|---|
| `limit` | 200 | Max results |
| `offset` | 0 | Pagination offset |
| `sort` | `name` | `name`, `rating`, `favourite`, `play_count` |
| `order` | `asc` | `asc` or `desc` |

**Response `200`**
```json
{
  "collection": { "id": 1, "name": "MAME", ... },
  "games": [ ... ],
  "platforms": ["Arcade"],
  "total": 100,
  "limit": 200,
  "offset": 0
}
```

---

### POST /api/collections/:id/versions

Links an existing version to a collection.

**Request Body**
```json
{ "version_id": 2 }
```

**Response `200`**
```json
{ "ok": true }
```

---

### DELETE /api/collections/:id/versions/:versionId

Unlinks a version from a collection.

**Response `200`**
```json
{ "ok": true }
```

---

### POST /api/collections/:id/scan

Scans a ROM directory against a DAT version. Returns a job ID — poll or subscribe via SSE to get the result.

**Request Body**
```json
{
  "version_id": 2,
  "dir": "/roms/mame"
}
```

**Response `202`**
```json
{ "jobId": "uuid" }
```

---

### POST /api/collections/:id/verify

Verifies a ROM set against a DAT version. Returns a job ID.

**Request Body**
```json
{
  "version_id": 2,
  "dir": "/roms/mame",
  "fallback_id": null
}
```

**Response `202`**
```json
{ "jobId": "uuid" }
```

---

### GET /api/collections/:id/builds

All builds for a collection, joined with version info, ordered by created_at DESC.

**Response `200`**
```json
[
  {
    "id": 1,
    "collection_id": 1,
    "version_id": 2,
    "status": "complete",
    "format": "split",
    "games_total": 100,
    "games_built": 100,
    "started_at": "2026-05-23 03:24:26",
    "completed_at": "2026-05-23 03:24:30",
    "created_at": "2026-05-23 03:24:26",
    "version": "0.37",
    "source": "MAME"
  }
]
```

Status values: `not_started`, `building`, `complete`, `failed`

---

### POST /api/collections/:id/builds

Starts a new build. Enforces two rules:
1. **Forward‑only**: cannot build older version than last completed build (MAME versioned only)
2. **Must‑complete‑current**: cannot start a new build while one is in `building` status

**Request Body**
```json
{
  "version_id": 2,
  "format": "split"
}
```

`format`: `"split"`, `"merged"`, or `"non-merged"`

**Response `200`** — full build row with version info.

**Error `400`**
```json
{ "error": "Build already in progress for version ..." }
```
```json
{ "error": "Cannot build version 0.37: already built 0.287. Only forward builds allowed." }
```

---

### PUT /api/collections/:id/builds/:buildId

Updates build status.

**Request Body**
```json
{
  "status": "complete",
  "games_built": 100
}
```

When status is `complete`, `completed_at` is set automatically. `games_built` is optional.

**Response `200`** — updated build row.

---

### POST /api/collections/:id/exports

Generates a full ROM manifest for a collection.

**Request Body**
```json
{
  "format": "split",
  "version_id": 2
}
```

`format`: `"split"`, `"merged"`, or `"non-merged"`. If `version_id` is omitted, uses the latest completed build.

**Response `200`**
```json
{
  "collection": "MAME",
  "version": "0.37",
  "format": "split",
  "total_games": 100,
  "total_roms": 250,
  "games": [ ... ]
}
```

**Error `400`**
```json
{ "error": "No completed builds to export" }
```

---

## Game Sets

### GET /api/game-sets

Lists all game sets with computed game count.

**Response `200`**
```json
[
  {
    "id": 1,
    "name": "Fighting Games",
    "icon": "🥊",
    "description": "",
    "platforms": "Arcade,SNES",
    "created_at": "2026-05-23 03:24:26",
    "total_games": 5
  }
]
```

---

### POST /api/game-sets

**Request Body**
```json
{
  "name": "Fighting Games",
  "description": "Best fighting games",
  "icon": "🥊",
  "platforms": "Arcade,SNES"
}
```

**Response `201`** — full game set row.

---

### PUT /api/game-sets/:id

Partial update.

**Response `200`** — updated row.

---

### DELETE /api/game-sets/:id

**Response `200`**
```json
{ "ok": true }
```

---

### GET /api/game-sets/:id/games

Paginated games in a set with ratings and total ROM size.

**Query Parameters**: `limit` (200), `offset` (0), `sort`, `order`

**Response `200`**
```json
{
  "game_set": { "id": 1, "name": "Fighting Games", ... },
  "games": [ ... ],
  "total": 5,
  "total_size": 567890,
  "limit": 200,
  "offset": 0
}
```

---

### POST /api/game-sets/:id/games

Adds one or more games to a set.

**Request Body**
```json
{ "game_entry_ids": [1, 2, 3] }
```

**Response `200`**
```json
{ "ok": true, "added": 3 }
```

---

### DELETE /api/game-sets/:id/games/:gameId

**Response `200`**
```json
{ "ok": true }
```

---

### GET /api/game-sets/:id/exports

Exports game set metadata (no ROM details).

**Response `200`**
```json
{
  "game_set": { ... },
  "games": [ ... ],
  "total_games": 1
}
```

---

## Games (global)

### GET /api/games

Paginated search and browse across all games. Merges old `/api/browse` and `/api/search`.

**Query Parameters**
| Param | Default | Description |
|---|---|---|
| `limit` | 200 | Max results |
| `offset` | 0 | Pagination |
| `sort` | `name` | `name`, `rating`, `favourite`, `play_count` |
| `order` | `asc` | `asc` or `desc` |
| `q` | — | Text filter (LIKE on name, description, source) |
| `collection_id` | — | Filter by collection (games from linked versions) |
| `version_id` | — | Filter by specific version |

**Response `200`**
```json
{
  "games": [
    {
      "id": 1,
      "version_id": 1,
      "name": "pacman",
      "description": "Pac-Man",
      "year": "1980",
      "manufacturer": "Namco",
      "cloneof": null,
      "source": "MAME",
      "version": "0.37",
      "rating": 0,
      "favourite": 0,
      "play_count": null
    }
  ],
  "total": 5000,
  "limit": 200,
  "offset": 0
}
```

---

### GET /api/games/:id

Full game detail with ROM entries, scanned games, and rating.

**Response `200`**
```json
{
  "id": 1,
  "version_id": 1,
  "name": "pacman",
  "source": "MAME",
  "version": "0.37",
  "roms": [
    {
      "filename": "pacman.rom",
      "size": 16384,
      "crc32": "ABCD1234",
      "md5": "abc...",
      "sha1": "def...",
      "status": "good",
      "merge_target": null
    }
  ],
  "scanned_games": [ ... ],
  "rating": { "rating": 4, "favourite": 1 }
}
```

---

### PUT /api/games/:id/rating

Upserts rating and/or favourite for a game.

**Request Body**
```json
{
  "rating": 4,
  "favourite": true
}
```

`rating`: 0–5 integer. `favourite`: boolean. All fields optional.

**Response `200`**
```json
{ "ok": true }
```

---

### GET /api/games/:id/cover

Deterministic SVG placeholder cover. MD5 hash of game name generates HSL color. Shows first letter.

**Response `200`**: `image/svg+xml`, cached 86400s.

---

### GET /api/games/:id/play

Serve a ROM file for in-browser emulation via EmulatorJS. Auto-finds the correct file:
- **Arcade/MAME/FBNeo**: serves zip from `scanned_games`
- **NPS**: finds downloaded file from the NPS directory tree
- **No-Intro/DAT**: serves first available ROM from disk

**Response `200`**: ROM file binary with appropriate `Content-Type` (`application/zip`, `application/octet-stream`, etc.).
**Response `404`**: `{ "error": "ROM file not found on disk" }`

---

## Versions

### GET /api/versions

All imported versions with game counts, sorted by created_at DESC.

**Response `200`**
```json
[
  {
    "id": 2,
    "source": "MAME",
    "version": "0.287",
    "dir": null,
    "created_at": "2026-05-23 03:24:26",
    "total_games": 12000
  }
]
```

---

### GET /api/versions/:id/games

Paginated games for a specific version.

**Query Parameters**: `limit` (100), `offset` (0), `q` (text filter)

**Response `200`**
```json
{
  "games": [ ... ],
  "limit": 100,
  "offset": 0
}
```

---

### GET /api/versions/available

Scrapes `progettosnaps.net` for available MAME DAT versions. Cross-references with DB to show imported vs missing. Cached for 10 minutes.

**Response `200`**
```json
{
  "latest": "0.287",
  "latestParsed": [0, 287, 0],
  "hasNewer": true,
  "available": [ ... ],
  "imported": [ ... ],
  "missing": [ ... ]
}
```

| Field | Description |
|---|---|
| `latest` | Latest version string found on the page |
| `hasNewer` | True if latest is NOT in the imported list |
| `available` | All versions that have a DAT file available |
| `imported` | Versions already imported into set_versions |
| `missing` | Versions with DAT files but not yet imported |

---

### POST /api/versions/import-online

Creates a `set_versions` entry for a MAME version and links it to a collection.

**Request Body**
```json
{
  "collection_id": 1,
  "version": "0.37"
}
```

**Response `200`**
```json
{ "ok": true, "version_id": 2 }
```

---

### POST /api/versions/import-dat

Parses a raw DAT file (XML or ClrMAMEPro format) and creates a version with extracted games.

Accepts:
- **MAME listxml**: `<mame><game name="pacman">...</game></mame>`
- **ClrMAMEPro XML**: `<datafile><game name="pacman">...</game></datafile>`
- **Simple DAT**: `game ( name "pacman" )`

**Request Body** (JSON):
```json
{
  "content": "<datafile><game name=\"pacman\">...</game></datafile>"
}
```

**Response `200`**
```json
{
  "ok": true,
  "version_id": 2,
  "source": "DAT",
  "version": "1.0",
  "total_games": 2
}
```

**Error `400`**
```json
{ "error": "No games found in DAT file" }
```

---

## Scraper (external metadata)

### POST /api/scraper/search

ScreenScraper search by game name.

**Request Body**
```json
{
  "query": "pacman",
  "platform": "Arcade"
}
```

**Response `200`** — delegate to `scraper-cli`.

### POST /api/scraper/scrape

Hash a file and look up metadata on ScreenScraper.

**Request Body**
```json
{
  "file": "/roms/mame/pacman.zip",
  "game_name": "pacman",
  "platform": "Arcade"
}
```

### POST /api/scraper/hash

Compute hashes only (no network lookup).

**Request Body**
```json
{
  "file": "/roms/mame/pacman.zip"
}
```

---

## Jobs (SSE progress streams)

### GET /api/jobs/:jobId

If job is still running, returns an SSE stream with progress events. If job is done, returns the result directly as JSON.

**SSE Events**
```
data: {"type":"progress","pct":50,"msg":"Scanning..."}
data: {"type":"result","data":{...}}
data: {"type":"error","error":"..."}
data: {"type":"cancelled"}
```

**Direct response (completed job)**
```json
{
  "type": "done",
  "data": { ... }
}
```

### POST /api/jobs/:jobId/cancel

Cancels a running job (sends SIGTERM to child process).

**Response `200`**
```json
{ "ok": true }
```

---

## Error Format

All errors follow a consistent format:

```json
{ "error": "Human-readable error message" }
```

HTTP status codes used:
- `200` — Success
- `201` — Created
- `202` — Accepted (job started)
- `400` — Bad request (validation error)
- `404` — Resource not found
- `500` — Internal server error
