# Extract No-Intro Variant Info at Parse Time

**Status:** Planned (not started)  
**Priority:** Medium  
**Depends on:** None  

## Goal

Add `region`, `languages`, `revision`, `status` columns to the `games` table,
extracted from the No-Intro game description during DAT import. This enables
grouping, filtering, and badge display for game variants (e.g. USA vs Europe,
Beta vs Retail, Rev 1 vs Rev A).

## Motivation

No-Intro console sets (N64, NES, SNES, GBA, etc.) do not use `cloneof`/`romof`
to relate variants. Every variant is an independent entry with all metadata
embedded in the `description` field as parenthetical tokens:

```
007 - The World Is Not Enough (Europe) (En,Fr,De)
007 - The World Is Not Enough (Europe) (En,Fr,De) (Beta)
007 - The World Is Not Enough (USA)
007 - The World Is Not Enough (USA) (Beta 1) (1998-12-15)
007 - The World Is Not Enough (USA) (Beta 2)
```

Without extraction, the UI cannot group or filter these meaningfully.

## Schema change

Add 4 columns to `games`:

```sql
ALTER TABLE games ADD COLUMN region TEXT DEFAULT '';
ALTER TABLE games ADD COLUMN languages TEXT DEFAULT '';
ALTER TABLE games ADD COLUMN revision TEXT DEFAULT '';
ALTER TABLE games ADD COLUMN status TEXT DEFAULT '';
```

`description` stays as the full original string (for display). A `base_name`
for grouping can be computed at query time by stripping parenthetical tokens.

## Naming convention

No-Intro parenthetical groups follow a positional convention:

| Position | Pattern | Examples |
|---|---|---|
| 1st — Region | Country names, comma-separated | `USA`, `Europe`, `Japan`, `World`, `Brazil`, `Australia`, `Asia`, `Japan, USA`, `Europe, Australia` |
| 2nd — Languages | `^[A-Z][a-z](,[A-Z][a-z])*$` | `En,Fr,De`, `En,Ja`, `Es,It,Pt` |
| 3rd+ — Revision | `Rev \d+`, `Rev [A-Z]`, `v[\d.]+[a-z]?` | `Rev 1`, `Rev A`, `v1.0`, `v3.3`, `v0.00b`, `v1.0.0.6` |
| 3rd+ — Date | `\d{4}-\d{2}-\d{2}(T\d+)?` | `1998-12-15`, `2000-07-16T211412` |
| 3rd+ — Status | Everything else | `Beta`, `Beta 1`, `Proto`, `Demo`, `Sample`, `Test Program`, `Aftermarket`, `Unl`, `Pirate`, `Kiosk`, `Debug`, `GameCube`, `LodgeNet`, `Piko Interactive`, `NTSC`, `PAL` |
| End — Badge | `\[[a-z]+\]$` (TOSEC-style) | `[b]`, `[f]`, `[h]` — ignore |

Open question: should `status` be a single string or comma-separated for
combinations like `Aftermarket,Unl` or `Demo (Kiosk)`?

## Implementation

### 1. Rust parser (`libs/rom-manager/`)

- **`src/models.rs`** — Add `VariantInfo { region, languages, revision, status }` to `ParsedGame`.
- **`src/dat/logiqx.rs`** — Write extraction function that strips parenthetical
  groups from the description and classifies each by the rules above. Add a
  shared helper in `src/dat/mod.rs` so `offlinelist.rs` can use it too.
- **`src/db/mod.rs`** — Update INSERT to write `region`, `languages`,
  `revision`, `status` to the `games` table.

### 2. Migration script for existing data

Write `scripts/extract-game-variants.mjs` (Node.js) that:
- Reads all games from `roms.db`
- Applies the same extraction logic in JS
- Runs `UPDATE games SET region=?, languages=?, revision=?, status=? WHERE id=?`
- Handles all collections (not just N64)

### 3. Rebuild

```bash
cargo build -p parse-cli --release
```

Existing collections need a DAT re-import (`POST /api/versions/import-online`)
or the migration script to populate the new columns.

## UI changes (future)

- Show region/status as chips/badges in game list rows
- Optional: group by base title with collapsible variant list
- Optional: filter/sort by region, status, revision
