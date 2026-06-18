# New Schema Design

## Problem

The previous schema had no direct link between games and collections:

```
games (global, no collection_id)
  → game_rom_sets (global)
    → set_versions (global, has 'source' field)
      → collection_versions (junction table)
        → collections (has dataset_preset, scrape_source_priority)
```

This required 4 joins to answer "which collection is this game in?". The `source` field on `set_versions` was unreliable — it had values like `MAME`, `FBNeo`, `FBAlpha43`, `FBAlpha44` — inconsistent and hard to map.

## New Schema

### Tables

**`collections`** — unchanged
```sql
id, name, slug, dataset_preset, scrape_source_priority, ...
```

**`set_versions`** — added `collection_id`, removed `source`
```sql
id, collection_id, version, dir, created_at
UNIQUE(collection_id, version)
```

**`games`** — added `collection_id`, now unique per-collection
```sql
id, collection_id, name, description, year, manufacturer, platform, ...
UNIQUE(collection_id, name)
```

**`game_rom_sets`** — unchanged
```sql
id, game_id, version_id, romof, status, available
UNIQUE(game_id, version_id)
```

**`game_rom_files`** — unchanged
```sql
id, rom_set_id, filename, size, crc32, md5, sha1, status, merge_target, ...
```

**`game_media`** — unchanged
```sql
name, platform, synopsis, covers, screenshots, fanarts, videos, source, scraped_at
PRIMARY KEY (name, platform)
```

### Removed tables

- `collection_versions` — no longer needed. Versions belong to collections via `set_versions.collection_id`.

### Relationships

```
collections
  ├── dataset_preset  →  "mame", "fbneo", "nps"
  ├── scrape_source_priority → ["libretro-thumbnails"]
  │
  ├── set_visions (versions belong to collection directly)
  │
  └── games (games belong to collection directly)
        │
        ├── game_rom_sets (ROM data per version)
        │     └── game_rom_files
        │
        └── game_media (scraped media, shared by name+platform)
```

### Key changes

| Before | After |
|---|---|
| `games` global, `UNIQUE(name)` | `games` per-collection, `UNIQUE(collection_id, name)` |
| `set_versions` global, has `source` | `set_versions` per-collection, no `source` |
| `collection_versions` junction table | Removed |
| `game.source` from `set_versions` (fragile) | `collection.dataset_preset` is source of truth |
| 4 joins to find collection | 1 join: `game.collection_id → collection` |

### How queries simplify

**Before**: find collection for a game
```sql
SELECT c.* FROM collections c
JOIN collection_versions cv ON cv.collection_id = c.id
JOIN set_versions sv ON sv.id = cv.version_id
JOIN game_rom_sets grs ON grs.version_id = sv.id
WHERE grs.game_id = ?;
```

**After**: find collection for a game
```sql
SELECT c.* FROM collections c
JOIN games g ON g.collection_id = c.id
WHERE g.id = ?;
```

### `dataset_preset` usage

The `dataset_preset` on `collections` replaces `set_versions.source` for platform rules:

| dataset_preset | Libretro folder | ProgettoSnaps | Example |
|---|---|---|---|
| `mame` | `MAME` | Yes | MAME arcade |
| `fbneo` | `FBNeo - Arcade Games` | No | Final Burn Neo |
| `nps` | N/A | No | PlayStation Vita/PSP |

Scrapers check `dataset_preset` to decide if they apply:

```js
const SCRAPER_PLATFORM = [
  { sources: ['progettosnaps'],        datasetPresets: ['mame'] },
  { sources: ['libretro-thumbnails'],   datasetPresets: ['mame', 'fbneo'] },
  { sources: ['arcadedb'],             datasetPresets: ['mame', 'fbneo'] },
  { sources: ['sony-store'],           datasetPresets: ['nps'] },
  { sources: ['thegamesdb', 'igdb', 'screenscraper'], datasetPresets: [] }, // all
];
```

### Unversioned collections (NPS)

For collections without versioning (NPS), `set_versions` has a single row:

```
collection: PS Vita (dataset_preset = 'nps')
  set_versions: 1 row, version = 'PSV'
  games: all PS Vita games, collection_id = 3
```

The version is just the platform identifier. Same structure as versioned collections.
