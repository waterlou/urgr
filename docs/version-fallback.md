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
- Format: one version string per line, oldest first, nightly last
- Created/updated by: `import-online` endpoint (FBNeo/MAME only)
- **Not written by the builder** — only import-online manages this file
- Sort logic: `server/versionSort.js` (`sortVersions()`) — shared between version list display and `.version` file write
- Example (fbneo):
  ```
  0.2.97.44
  v1.0.0.01
  nightly
  ```
- Example (mame):
  ```
  0.139
  0.260
  ```

## Fallback Rules

### Direction: OLDER ONLY

When looking for a ROM across versions:
1. Check the current version's directory first
2. If not found, check **older** versions only (earlier lines in `.version`)
3. Never fall forward to newer versions
4. Prefer the closest older version

### Play Endpoint Priority

1. `game_rom_sets.available` for the game's exact version_id
2. `.version` fallback: read file → find current version index → scan older lines (reversed) → check each older version's `roms/` dir for a matching ROM on disk
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

After a build completes, the server scans output dirs to set `game_rom_sets.available` for the version. The scan must follow the version chain from `.version`:

1. Read `.version` file at `{collectionDir}/.version`
2. Walk versions **in order** (oldest first)
3. Stop at the version that was just built
4. Scan each version's `roms/` subdirectory for `.zip` files and CHD directories

This picks up both newly-added games (in the current version's dir) and reused games (copied to an older version's dir via prior-version fallback during the CLI build).

**Never** scan the collection root recursively — that causes cross-version ROM misassignment (e.g., 0.256 ROMs attributed to 0.41).

References: `apps/rom-manager-ui/server/routes/collections.js` lines ~470 and ~625.

## Version Sort Logic

`server/versionSort.js` exports `sortVersions(versions)`:
- Strips `v`/`V` prefix, splits by `.`, compares numerically (component by component)
- `nightly` always sorts last (`u64::MAX` in Rust equivalent)
- Used by: FBNeo version list, MAME version list, `.version` file write after import
- Tests: `server/test-version-sort.mjs` (14 tests covering FBNeo, MAME, edge cases)

## Database Constraints

- `game_entries.region`: always store `''` (never NULL) — SQLite UNIQUE treats NULL != NULL
- Enforced in Rust: `game.region.as_deref().unwrap_or("")`
- `UNIQUE(version_id, name, region)` prevents duplicates only when region is non-NULL
