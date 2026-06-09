# Version Fallback Logic

## Sources That Support Versioning

| Source | Has `.version` | Fallback via `.version` |
|--------|---------------|------------------------|
| FBNeo  | yes           | yes                    |
| MAME   | yes           | yes                    |
| NPS    | no            | no                     |
| No-Intro | no          | no                     |
| DAT-O-MATIC | no       | no                     |
| OfflineList | no       | no                     |

## `.version` File

- Location: `data/roms/{collectionFolder}/.version`
- Format: one version string per line, oldest first, newest last
- Example (fbneo):
  ```
  v1.0.0.02
  nightly
  ```
- Example (mame):
  ```
  0.139
  0.163
  ```

## Fallback Rules

### Direction: OLDER ONLY

When looking for a ROM across versions:
1. Check the current version's directory first
2. If not found, check **older** versions only (earlier lines in `.version`)
3. Never fall forward to newer versions
4. Prefer the closest older version

### Play Endpoint Priority

1. `scanned_games` for the game's exact version_id
2. `.version` fallback: read file → find current version index → scan older lines (reversed) → check each older version's `scanned_games` for a matching ROM on disk
3. NPS: filesystem search for PKG file
4. No-Intro/DAT/others: filesystem search by `rom_entries.filename` (zip checked first, then individual file)

### Filesystem Search Order (step 4)

```
1. {collectionDir}/{rom.filename}.zip
2. {collectionDir}/Games/{rom.filename}.zip
3. {collectionDir}/{rom.filename}
4. {collectionDir}/Games/{rom.filename}
```

## Scanner Directory Rule

DAT builds **must** scan `collectionDir/{version}` (version-specific), never the collection root. Scanning the root causes cross-version ROM misassignment (e.g., nightly ROMs assigned to v1.0.0.02).

References: `apps/rom-manager-ui/server/routes/collections.js` line ~347.

## Database Constraints

- `game_entries.region`: always store `''` (never NULL) — SQLite UNIQUE treats NULL != NULL
- Enforced in Rust: `game.region.as_deref().unwrap_or("")`
- `UNIQUE(version_id, name, region)` prevents duplicates only when region is non-NULL
