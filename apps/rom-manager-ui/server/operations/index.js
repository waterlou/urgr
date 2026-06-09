import crypto from 'crypto';
import { all, get, run } from '../helpers.js';
import { getDb, saveDb } from '../db.js';

let manager = null;

// =============================================================================
// Operation base class
// =============================================================================

export class Operation {
  constructor(type, collectionId = null, params = {}) {
    this.id = crypto.randomUUID();
    this.type = type;
    this.collectionId = collectionId;
    this.status = 'pending';
    this.progress = { pct: 0, msg: '' };
    this.result = null;
    this.error = null;
    this.params = params;
    this.createdAt = new Date().toISOString();
    this.subscribers = new Set();
    this._abort = null;
  }

  async run() {
    throw new Error('Subclass must implement run()');
  }

  cancel() {
    if (this.status !== 'running' && this.status !== 'pending') return false;
    this.status = 'cancelled';
    if (this._abort) this._abort.abort();
    this.broadcast({ type: 'cancelled' });
    this.save();
    this.closeSubs();
    return true;
  }

  updateProgress(pct, msg) {
    this.progress = { pct, msg };
    this.broadcast({ type: 'progress', pct, msg });
    this.save();
  }

  done(result) {
    this.status = 'done';
    this.result = result;
    this.progress = { pct: 100, msg: 'Complete' };
    this.broadcast({ type: 'result', data: result });
    this.save();
    this.closeSubs();
    if (manager) manager.onOperationDone(this);
  }

  fail(error) {
    this.status = 'failed';
    this.error = typeof error === 'string' ? error : error?.message || 'Unknown error';
    this.broadcast({ type: 'error', error: this.error });
    this.save();
    this.closeSubs();
    if (manager) manager.onOperationDone(this);
  }

  subscribe(res) {
    this.subscribers.add(res);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', operation: this.toJSON() })}\n\n`);
  }

  broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const sub of this.subscribers) {
      try { sub.write(data); } catch {}
    }
    if (manager) manager.broadcastGlobal({ ...msg, operation: this.toJSON() });
  }

  closeSubs() {
    for (const sub of this.subscribers) {
      try { sub.end(); } catch {}
    }
    this.subscribers.clear();
  }

  save() {
    run(`INSERT OR REPLACE INTO operations (id, type, collection_id, status, progress_pct, progress_msg, result, error, params, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [this.id, this.type, this.collectionId, this.status, this.progress.pct, this.progress.msg,
       this.result ? JSON.stringify(this.result) : null, this.error,
       JSON.stringify(this.params), this.createdAt]
    );
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      collection_id: this.collectionId,
      status: this.status,
      progress_pct: this.progress.pct,
      progress_msg: this.progress.msg,
      result: this.result,
      error: this.error,
      params: this.params,
      created_at: this.createdAt,
    };
  }

  static fromDb(row) {
    const op = new Operation(row.type, row.collection_id, row.params ? JSON.parse(row.params) : {});
    op.id = row.id;
    op.status = row.status;
    op.progress = { pct: row.progress_pct || 0, msg: row.progress_msg || '' };
    op.result = row.result ? JSON.parse(row.result) : null;
    op.error = row.error;
    op.createdAt = row.created_at;
    return op;
  }
}

// =============================================================================
// OperationManager singleton
// =============================================================================

export class OperationManager {
  constructor() {
    this.active = new Map();
    this._globalSubs = new Set();
  }

  init() {
    // Load active operations from DB and mark as failed (server restarted)
    try {
      run("UPDATE operations SET status='failed', error='Server restarted' WHERE status IN ('pending','running')");
    } catch {}
  }

  async create(type, collectionId, params = {}) {
    // Check one-operation-per-collection rule
    if (collectionId) {
      for (const op of this.active.values()) {
        if (op.collectionId === collectionId) {
          throw new Error('Another operation is already running on this collection');
        }
      }
    }

    // Dynamically import the subclass
    let OpClass;
    switch (type) {
      case 'build':
        const { BuildOperation } = await import('./build.js');
        OpClass = BuildOperation;
        break;
      case 'scan':
        const { ScanOperation } = await import('./scan.js');
        OpClass = ScanOperation;
        break;
      case 'scrape':
        const { ScrapeOperation } = await import('./scrape.js');
        OpClass = ScrapeOperation;
        break;
      case 'import':
        const { ImportOperation } = await import('./import.js');
        OpClass = ImportOperation;
        break;
      case 'export':
        const { ExportOperation } = await import('./export.js');
        OpClass = ExportOperation;
        break;
      case 'verify':
        const { VerifyOperation } = await import('./verify.js');
        OpClass = VerifyOperation;
        break;
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    const op = new OpClass(collectionId, params);
    this.active.set(op.id, op);
    op.save();
    this.broadcastGlobal({ type: 'new', operation: op.toJSON() });

    // Run in background
    op.status = 'running';
    op.save();
    this.broadcastGlobal({ type: 'update', operation: op.toJSON() });

    op.run().catch(err => {
      console.error(`[operations] ${type} failed:`, err.message);
      op.fail(err);
    });

    return op;
  }

  get(id) {
    if (this.active.has(id)) return this.active.get(id);
    // Try from DB
    const row = get('SELECT * FROM operations WHERE id = ?', [id]);
    return row ? Operation.fromDb(row) : null;
  }

  list(collectionId = null) {
    // Combine active + recent from DB
    let rows;
    if (collectionId) {
      rows = all('SELECT * FROM operations WHERE collection_id = ? ORDER BY created_at DESC LIMIT 30', [collectionId]);
    } else {
      rows = all('SELECT * FROM operations ORDER BY created_at DESC LIMIT 30');
    }

    const results = rows.map(r => {
      if (this.active.has(r.id)) return this.active.get(r.id).toJSON();
      return Operation.fromDb(r).toJSON();
    });

    return results;
  }

  cancel(id) {
    const op = this.active.get(id);
    if (!op) return false;
    return op.cancel();
  }

  subscribeAll(res) {
    this._globalSubs.add(res);
    // Send snapshot immediately
    const ops = this.list();
    res.write(`data: ${JSON.stringify({ type: 'snapshot', operations: ops })}\n\n`);
  }

  unsubscribeAll(res) {
    this._globalSubs.delete(res);
  }

  broadcastGlobal(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const sub of this._globalSubs) {
      try { sub.write(data); } catch {}
    }
  }

  onOperationDone(op) {
    this.active.delete(op.id);
    this.broadcastGlobal({ type: 'update', operation: op.toJSON() });
    this.trimHistory();
  }

  trimHistory() {
    // Keep only the last 10 completed operations
    run(`DELETE FROM operations WHERE status IN ('done','failed','cancelled') AND id NOT IN (
      SELECT id FROM operations WHERE status IN ('done','failed','cancelled') ORDER BY created_at DESC LIMIT 10
    )`);
  }
}

export function getManager() {
  if (!manager) {
    manager = new OperationManager();
    manager.init();
  }
  return manager;
}
