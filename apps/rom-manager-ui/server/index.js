import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { closeDb, saveDb } from './db.js';
import { all, run, dbReady } from './helpers.js';
import collectionsRouter from './routes/collections.js';
import gamesRouter from './routes/games.js';
import gameSetsRouter from './routes/game-sets.js';
import versionsRouter from './routes/versions.js';
import scraperRouter from './routes/scraper.js';
import iaRouter from './routes/ia.js';
import miscRouter from './routes/misc.js';
import downloadsRouter from './routes/downloads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const distPath = path.join(__dirname, '..', 'dist');

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Mount route modules
// Routers with full /api/* paths are mounted at root; games.js uses relative paths
app.use(collectionsRouter);    // /api/status, /api/platforms, /api/collections/*
app.use('/api/games', gamesRouter);  // handles /api/games, /api/games/:id/scrape, etc.
app.use(gameSetsRouter);       // /api/game-sets/*
app.use(versionsRouter);       // /api/versions/*
app.use(scraperRouter);        // /api/scraper/*
app.use(iaRouter);             // /api/ia/*
app.use(miscRouter);           // /api/jobs/*, /api/settings/*
app.use(downloadsRouter);      // /api/downloads/*

// =============================================================================
// Global error handler
// =============================================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err?.stack || err?.message || err);
  res.status(500).json({ error: err?.message || 'Internal server error' });
});

// =============================================================================
// Static files + SPA fallback
// =============================================================================
app.use('/assets', express.static(path.join(distPath, 'assets')));

const iconsDir = path.join(__dirname, '..', '..', '..', 'icons');
app.use('/icons', express.static(iconsDir));

app.use((req, res) => {
  const filePath = path.join(distPath, 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(200).json({ message: 'ROM Manager API' });
  }
});

// =============================================================================
// Start
// =============================================================================
// Startup cleanup: reset orphaned builds (server crashed/restarted)
dbReady.then(() => {
  const orphans = all("SELECT id FROM collection_builds WHERE status = 'building'");
  if (orphans.length > 0) {
    console.log(`Resetting ${orphans.length} orphaned build(s) to 'failed'`);
    for (const o of orphans) {
      run("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [o.id]);
    }
  }
});

app.listen(PORT, () => {
  console.log(`ROM Manager API running at http://localhost:${PORT}`);
});

function shutdown() { saveDb(); closeDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.stack || err?.message || err);
});
