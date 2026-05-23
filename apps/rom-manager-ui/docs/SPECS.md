# ROM Manager UI — Specification

## Overview

A web-based ROM management dashboard with Netflix‑style UI. Users organise retro game ROMs into collections and game sets, import DAT files to enable hash‑based verification, track versioned builds (MAME forward‑only), and export manifests.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React 19 SPA)                                 │
│  src/App.jsx                                            │
│  ├── Sidebar (collections, game sets, theme toggle)     │
│  ├── GameBrowser (grid/list/large view, sort, search)   │
│  ├── CollectionDetail (MAME versions, builds, export)   │
│  ├── GameDetail (modal: ROMs, scanned, rating)          │
│  ├── CollectionForm (modal: create/edit, 3 modes)       │
│  └── GameSetForm (modal: create/edit)                   │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP /api/*
               ▼
┌─────────────────────────────────────────────────────────┐
│  Express 5 Server (server/index.js)                     │
│  ├── Collections CRUD                                   │
│  ├── Game Sets CRUD                                     │
│  ├── Browse / Search / Game Detail                      │
│  ├── MAME DAT version scraper                           │
│  ├── DAT file upload & parser                           │
│  ├── Build management (forward-only)                    │
│  └── Export manifest generation                         │
└──────────────┬──────────────────────────────────────────┘
               │ sql.js (WASM)
               ▼
┌─────────────────────────────────────────────────────────┐
│  SQLite Database (roms.db)                              │
│  9 tables, 5 indexes                                    │
│  Persisted via saveDb() on every write                  │
└─────────────────────────────────────────────────────────┘
```

### Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | React | ^19.2.6 |
| Bundler | Vite | ^6.0.0 |
| Backend | Express | ^5.0.0 (beta) |
| Database | sql.js (SQLite WASM) | ^1.11.0 |
| Runtime | Node.js | >=22 (tested on 26) |
| Container | Alpine + Node 26 | |

### Key Design Decisions

- **sql.js over better-sqlite3**: better-sqlite3 native addon fails on Node 26 arm64 (no prebuilt binary). sql.js is pure WASM, no native deps.
- **Express 5 over Express 4**: catch‑all route uses `app.use()` instead of `app.get('/*')` because path‑to-regexp v8 removed bare‑star patterns.
- **No TypeScript**: pure JSX to minimise build complexity.
- **No ORM**: raw SQL via sql.js for full control and simplicity.
- **Single CSS file**: one monolithic `App.css` (1376 lines) avoids build‑time CSS processing.

---

## Features

### 1. Collections

User‑defined groups of ROMs. Each collection has:
- **Name, slug, platform, icon**
- **Dataset preset** (MAME, Final Burn Neo) or none (manual)
- **Uploaded DAT** parsed into a version

Three creation modes:
| Mode | Description | has_dataset |
|---|---|---|
| Manual | Folder‑based browsing, no hash checking | 0 |
| Preset Dataset | Select MAME/FBNeo, version chosen later via import | 1 |
| Upload DAT | Parse .dat file directly | 1 |

### 2. Game Sets

Curated cross‑collection game lists with platform chips.

### 3. MAME DAT Version Checker

Scrapes `https://www.progettosnaps.net/dats/MAME/` to list available DAT versions (253+). Cross‑references with imported versions to show what's missing. 10‑minute cache.

**Version format**: `major.minor[beta]` (e.g., `0.37`, `0.287`, `0.37b1`). Parsed as `[major, minor, beta]` tuple for comparison.

### 4. Build Management

Tracks ROM set building for a collection:
- **Forward‑only enforcement**: cannot build a version older than the last completed build
- **Must‑complete‑current**: cannot start a new build while one is in progress
- **Format tracking**: split / merged / non‑merged
- **Progress**: games_total / games_built

### 5. Export

Generates a full manifest of all games and ROMs grouped by game. Includes SHA1, CRC32, MD5 hashes, size, merge target, and ROM status.

### 6. Theme

Dark/light toggle persisted in `localStorage`. Netflix‑inspired dark theme (`#0e0e0e` bg, `#e50914` accent). Light theme overrides all 10 color variables.

### 7. Rating & Favourites

1‑5 star rating per game, favourite toggle, sort by name/rating/favourite.

---

## Database Schema (9 tables)

```
set_versions        (id, source, version, dir, created_at)
game_entries        (id, version_id → set_versions, name, description, year, manufacturer, cloneof)
rom_entries         (id, game_entry_id → game_entries, filename, size, crc32, md5, sha1, status, merge_target)
scanned_games       (id, version_id → set_versions, name, filename, sha1, size, status)
meta                (key, value)
collections         (id, name, slug, platform, logo, folder, has_dataset, created_at, updated_at)
collection_versions (id, collection_id → collections, version_id → set_versions)
game_sets           (id, name, icon, description, platforms, created_at)
game_set_games      (id, game_set_id → game_sets, game_entry_id → game_entries)
game_ratings        (id, game_entry_id → game_entries, rating, favourite, play_count, updated_at)
collection_builds   (id, collection_id → collections, version_id → set_versions, status, format, games_total, games_built, started_at, completed_at, created_at)
```

---

## Component Tree

```
<App>
  <Sidebar>
    "All Games" button
    Collections section (list + CRUD)
    Game Sets section (list + CRUD)
    Theme toggle footer
  </Sidebar>
  <main>
    <CollectionDetail>  (when activeView='collection' && subView='detail')
      MAME DAT version section (if folder='mame')
      Build management (table + form)
      Export (format selector + manifest)
    </CollectionDetail>
    <GameBrowser>       (all other views)
      Toolbar (view mode, sort, search)
      Grid / List / Large icon views
      Game cards with rating, favourite, add-to-set
    </GameBrowser>
  </main>
  <GameDetail />       (modal)
  <CollectionForm />   (modal)
  <GameSetForm />      (modal)
</App>
```

---

## Route Design (Frontend)

| Route Concept | activeView | activeId | Collection Sub‑view |
|---|---|---|---|
| Browse all games | `'browse'` | null | — |
| Collection detail | `'collection'` | collection.id | `'detail'` |
| Collection games | `'collection'` | collection.id | `'games'` |
| Game set | `'game-set'` | set.id | — |

---

## Theming

CSS custom properties on `:root` and `[data-theme="light"]`.

| Variable | Dark | Light |
|---|---|---|
| `--bg` | `#0e0e0e` | `#f5f5f5` |
| `--bg-elevated` | `#1a1a1a` | `#fff` |
| `--bg-card` | `#222` | `#fff` |
| `--sidebar-bg` | `#111` | `#fff` |
| `--text` | `#eee` | `#111` |
| `--accent` | `#e50914` | `#d40812` |
| `--border` | `#2a2a2a` | `#ddd` |

---

## Error Handling

- API routes: `try/catch` wrapping every handler → `res.status(500).json({ error: e.message })`
- Client API: `fetchJson` throws `Error('HTTP ${status}')` on non‑ok responses
- CollectionForm `handleSubmit` catches errors and shows inline `.notification.error`

---

## Security & Constraints

- Slug uniqueness enforced via `UNIQUE INDEX`; auto‑dedup (`mame` → `mame-1` → `mame-2`)
- MAME builds: forward‑only, cannot build while another is in progress
- DAT upload: validates content before inserting (minimum 10 chars, extracts games)
- SQLite `UNIQUE` constraints prevent duplicate version links and game entries

---

## Docker

- **`Dockerfile`**: 3‑stage Alpine build (Rust cross‑compile → npm ci → vite build → copy to node:26-alpine).
- **`docker-compose.yml`**: `rom-manager-ui` service on port 3001, mounts `roms.db` read‑write.

---

## Testing

No automated test suite. Manual verification via:
- API: curl / python3
- Frontend: Chrome DevTools Console (debug `console.log` statements exist)
- CDP automation: `/tmp/chrome-debug.mjs` (Chrome DevTools Protocol)
