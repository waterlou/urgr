# OperationManager Specification

## Overview

The OperationManager is a unified system for tracking all long-running operations (build, scan, scrape, import, export, verify) in ROM Manager. It replaces the ephemeral in-memory jobs system with SQLite-backed persistence and a global SSE stream.

## Architecture

### Backend

```
server/
  operations/
    index.js          # Operation base class + OperationManager singleton
    build.js          # BuildOperation — scan/build via CLI
    scan.js           # ScanOperation — ROM scanning
    scrape.js         # ScrapeOperation — batch scraping
    import.js         # ImportOperation — DAT/TSV import (placeholder, not fully implemented)
    export.js         # ExportOperation — JSON manifest export
    verify.js         # VerifyOperation — ROM verification
  routes/
    operations.js     # API routes: SSE stream, list, cancel, create
```

### Frontend

```
src/
  hooks/
    useOperations.js  # React hook subscribing to global operations SSE
  components/
    OperationsPage.jsx # Operations page with filter, progress, cancel
  api.js             # getOperations, subscribeOperationsSSE, cancelOperation, createOperation
```

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS operations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,           -- build|scan|scrape|import|export|verify
    collection_id   INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|cancelled
    progress_pct    INTEGER DEFAULT 0,
    progress_msg    TEXT DEFAULT '',
    result          TEXT,                    -- JSON blob on completion
    error           TEXT,
    params          TEXT,                    -- JSON: version_id, dir, format, etc.
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);
```

### Startup Cleanup

Orphaned operations (pending/running) are marked as failed on server restart:
```sql
UPDATE operations SET status='failed', error='Server restarted' WHERE status IN ('pending','running');
```

### History Trimming

Keeps last 10 completed operations, deletes older ones.

## Operation Base Class

```javascript
class Operation {
  constructor(type, collectionId, params)
  async run()              // Override in subclass
  cancel()                 // Abort controller + broadcast
  updateProgress(pct, msg) // Persist + broadcast
  done(result)             // Persist + broadcast + close subs + trim history
  fail(error)              // Persist + broadcast + close subs
  subscribe(res)           // Add SSE subscriber, send snapshot
  broadcast(msg)           // Write to all subscribers
  closeSubs()              // End all SSE connections
  save()                   // INSERT OR REPLACE into operations table
  toJSON()                 // Serialize for API
  static fromDb(row)       // Deserialize from SQLite
}
```

## OperationManager Singleton

```javascript
class OperationManager {
  constructor() { this.active = new Map(); this._globalSubs = new Set(); }
  init()                   // Load active from DB, mark as failed
  create(type, collectionId, params)  // Instantiate subclass, run, track
  get(id)                  // Active or from DB
  list(collectionId?)      // Active + recent from DB, limit 30
  cancel(id)               // Cancel active operation
  subscribeAll(res)        // SSE for global operations stream
  unsubscribeAll(res)      // Remove SSE subscriber
  broadcastGlobal(msg)     // Broadcast to all global subscribers
  onOperationDone(op)      // Remove from active, broadcast update, trim history
  trimHistory()            // DELETE old completed, keep 10
}
```

### One-Operation-Per-Collection Rule

```javascript
// In create():
if (collectionId) {
  for (const op of this.active.values()) {
    if (op.collectionId === collectionId) {
      throw new Error('Another operation is already running on this collection');
    }
  }
}
```

Returns HTTP 409 Conflict when violated.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /api/operations` | `?collection_id=X` | SSE stream — global operations |
| `GET /api/operations/list` | `?collection_id=X` | JSON — initial load (must be before /:id) |
| `GET /api/operations/:id` | | SSE stream — single operation |
| `POST /api/operations` | | Create operation |
| `POST /api/operations/:id/cancel` | | Cancel operation |

### SSE Message Format

```json
{ "type": "snapshot", "operations": [...] }  // On connect
{ "type": "new", "operation": { ... } }       // New operation created
{ "type": "update", "operation": { ... } }    // Progress/status change
{ "type": "removed", "id": "..." }            // Operation cleared
```

### Create Operation Request

```json
POST /api/operations
{
  "type": "build",
  "collection_id": 2,
  "version_id": 4,
  "dir": "/path/to/roms",
  "scan": true,
  "format": "dat"
}
```

### Create Operation Response

```json
{ "ok": true, "operationId": "uuid" }
```

### Create Operation Error (409)

```json
{ "error": "Another operation is already running on this collection" }
```

## Operation Subclasses

### BuildOperation

- `type`: `build`
- `params`: `{ version_id, dir, scan, format, import_dir }`
- Scan: uses `execCli(['scan', version_id, dir])` with version-specific path computation
- Build (DAT): uses `execCliStream(['scan', version_id, dir])` with progress streaming
- Build (NPS): uses `execCli(['build', ...])` synchronously

### ScanOperation

- `type`: `scan`
- `params`: `{ version_id, dir }`
- Uses `execCli(['scan', version_id, dir])` synchronously

### ScrapeOperation

- `type`: `scrape`
- `params`: `{ gameIds }` (optional — specific games or all unscraped)
- Iterates games, calls `scrapeSingleGame()` for each
- Rate limit detection: stops on 429 errors
- Progress: per-game text updates

### ImportOperation

- `type`: `import`
- `params`: `{ version, source, refresh, platform }`
- **NOT fully implemented** — delegates to CLI commands that may not exist
- Placeholder for future work

### ExportOperation

- `type`: `export`
- `params`: `{ version_id, format }`
- Queries games + ROM entries, builds JSON manifest

### VerifyOperation

- `type`: `verify`
- `params`: `{ version_id, dir, fallback_id }`
- Uses `execCli(['verify', version_id, dir])` synchronously

## Frontend Integration

### useOperations Hook

```javascript
function useOperations(collectionId = null) {
  // Subscribes to global SSE stream
  // Polls every 3s as fallback
  // Returns operations array
}
```

### OperationsPage

- Stat cards: running / completed / failed counts
- Collection filter dropdown
- List of operation cards, newest first
- Each card: type icon, collection name, status badge, progress bar, cancel button

### BuildManager

- Creates build/scan operations via `createOperation()`
- Polls for result after creation (every 1s, timeout 30s)
- Shows inline result on build page

### CollectionDetail

- Scrape-all creates scrape operation via `createOperation()`
- Shows inline progress from operations

### VersionManager

- **NOT migrated** — uses old import flow (complex source-specific logic)
- Import migration deferred to future work

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Operation base class | ✅ Done | Full lifecycle: run, cancel, progress, done, fail |
| OperationManager | ✅ Done | Singleton, one-per-collection, history trimming |
| BuildOperation | ✅ Done | Scan + build with path computation |
| ScanOperation | ✅ Done | Simple wrapper |
| ScrapeOperation | ✅ Done | Per-game with rate limit |
| ImportOperation | ⚠️ Placeholder | CLI commands may not exist |
| ExportOperation | ✅ Done | JSON manifest |
| VerifyOperation | ✅ Done | Simple wrapper |
| Operations API routes | ✅ Done | SSE, list, cancel, create |
| useOperations hook | ✅ Done | SSE + poll fallback |
| OperationsPage | ✅ Done | Full UI |
| BuildManager migration | ✅ Done | Uses operations for scan/build |
| CollectionDetail scrape-all | ✅ Done | Uses operations |
| VersionManager import | ❌ Not migrated | Old flow preserved (complex) |
| Remove old jobs.js | ❌ Not done | Kept for backward compat |

## Lessons Learned

1. **Don't rewrite working code from scratch** — wrap existing logic in the new system
2. **Hardcoded paths are wrong** — use relative path resolution from known locations
3. **SSE alone isn't reliable** — add polling fallback for instant-completion operations
4. **Check ALL code paths** — scan and build use different directory computation logic
5. **Preserve the original flow** — the old `POST /api/collections/:id/build` had working scan logic; the operation system should delegate to it, not reimplement it
