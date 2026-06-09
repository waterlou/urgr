import { Router } from 'express';
import { getManager } from '../operations/index.js';

const router = Router();

// =============================================================================
// List operations (non-SSE, for initial load) — must be before /:id route
// =============================================================================
router.get('/api/operations/list', (req, res) => {
  const mgr = getManager();
  const collectionId = req.query.collection_id ? parseInt(req.query.collection_id) : null;
  const ops = mgr.list(collectionId);
  res.json(ops);
});

// =============================================================================
// SSE: All operations stream
// =============================================================================
router.get('/api/operations', (req, res) => {
  const mgr = getManager();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  mgr.subscribeAll(res);

  // Keepalive heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    mgr.unsubscribeAll(res);
  });
});

// =============================================================================
// SSE: Single operation stream
// =============================================================================
router.get('/api/operations/:id', (req, res) => {
  const mgr = getManager();
  const op = mgr.get(req.params.id);

  if (!op) {
    return res.status(404).json({ error: 'Operation not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  if (op.subscribe) {
    op.subscribe(res);
  } else {
    // Operation from DB (not active), send snapshot and close
    res.write(`data: ${JSON.stringify({ type: 'snapshot', operation: op.toJSON ? op.toJSON() : op })}\n\n`);
    res.end();
    return;
  }

  req.on('close', () => {
    if (op.subscribers) op.subscribers.delete(res);
  });
});

// =============================================================================
// Cancel operation
// =============================================================================
router.post('/api/operations/:id/cancel', (req, res) => {
  const mgr = getManager();
  const ok = mgr.cancel(req.params.id);
  res.json({ ok });
});

// =============================================================================
// Create operation
// =============================================================================
router.post('/api/operations', async (req, res) => {
  try {
    const mgr = getManager();
    const { type, collection_id, ...params } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });
    const op = await mgr.create(type, collection_id || null, params);
    res.json({ ok: true, operationId: op.id });
  } catch (e) {
    if (e.message?.includes('already running')) {
      return res.status(409).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

export default router;
