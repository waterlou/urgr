import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { closeDb, saveDb } from './db.js';
import { all, run, dbReady } from './helpers.js';
import { initUsersDb, closeUsersDb, saveUsersDb } from './db-users.js';
import { distDir, iconsDir, dataDir, isElectron } from './paths.js';
import collectionsRouter from './routes/collections.js';
import gamesRouter from './routes/games.js';
import gameSetsRouter from './routes/game-sets.js';
import versionsRouter from './routes/versions.js';
import scraperRouter from './routes/scraper.js';
import iaRouter from './routes/ia.js';
import miscRouter from './routes/misc.js';
import downloadsRouter from './routes/downloads.js';
import operationsRouter from './routes/operations.js';
import filesystemRouter from './routes/filesystem.js';
import { loadFromEnv } from './ia-auth.js';

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(operationsRouter);     // /api/operations/*
app.use(filesystemRouter);     // /api/filesystem/*

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
app.use('/assets', express.static(path.join(distDir, 'assets')));

app.use('/icons', express.static(iconsDir));

const arcadeMediaDir = path.join(dataDir, 'media', 'arcadedb');
fs.mkdirSync(arcadeMediaDir, { recursive: true });
app.use('/media/arcadedb', express.static(arcadeMediaDir));

const libretroDir = path.join(dataDir, 'media', 'libretro-thumbnails');
fs.mkdirSync(libretroDir, { recursive: true });
app.use('/media/libretro-thumbnails', express.static(libretroDir));

const sonyStoreDir = path.join(dataDir, 'media', 'sony-store');
fs.mkdirSync(sonyStoreDir, { recursive: true });
app.use('/media/sony-store', express.static(sonyStoreDir));

const igdbDir = path.join(dataDir, 'media', 'igdb');
fs.mkdirSync(igdbDir, { recursive: true });
app.use('/media/igdb', express.static(igdbDir));

const progettosnapsDir = path.join(dataDir, 'media', 'progettosnaps');
fs.mkdirSync(progettosnapsDir, { recursive: true });
app.use('/media/progettosnaps', express.static(progettosnapsDir));

app.use((req, res) => {
  const filePath = path.join(distDir, 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(200).json({ message: 'ROM Manager API' });
  }
});

// =============================================================================
// Start
// =============================================================================
// Startup cleanup: reset orphaned builds and stale scrape jobs (server crashed/restarted)
dbReady.then(() => {
  const orphans = all("SELECT id FROM collection_builds WHERE status = 'building'");
  if (orphans.length > 0) {
    console.log(`Resetting ${orphans.length} orphaned build(s) to 'failed'`);
    for (const o of orphans) {
      run("UPDATE collection_builds SET status = 'failed' WHERE id = ?", [o.id]);
    }
  }
  const staleJobs = all("SELECT id FROM scrape_jobs WHERE status = 'running'");
  if (staleJobs.length > 0) {
    console.log(`Resetting ${staleJobs.length} stale scrape job(s) to 'failed'`);
    for (const j of staleJobs) {
      run("UPDATE scrape_jobs SET status = 'failed', progress_msg = 'Server restarted' WHERE id = ?", [j.id]);
    }
  }
});

let server;
function shutdown() {
  saveDb();
  closeDb();
  saveUsersDb();
  closeUsersDb();
  if (!isElectron) process.exit(0);
}

server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`ROM Manager API running at http://localhost:${actualPort}`);
  loadFromEnv();
  initUsersDb().then(() => console.log('users.db ready'));
  // In Electron, signal the main process that the server is ready
  if (isElectron && process.send) {
    process.send({ type: 'server-ready', port: actualPort });
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack || err?.message || err);
  if (!isElectron) process.exit(1);
});

export { app, server };
