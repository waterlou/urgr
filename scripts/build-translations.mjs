#!/usr/bin/env node
/**
 * Standalone script: build data/translations.json from ScreenScraper.
 *
 * For each game in the database, calls scraper-cli search --source screenscraper,
 * extracts region_titles (localized names by region) from the best match.
 *
 * Usage:
 *   node scripts/build-translations.mjs
 *
 * Options:
 *   --db <path>       SQLite database path (default: data/roms.db)
 *   --scraper <path>  scraper-cli binary path (default: ./target/release/scraper-cli)
 *   --output <path>   output JSON path (default: data/translations.json)
 *   --resume          resume from existing progress file
 *   --limit <n>       max games to process (for testing)
 *   --delay <ms>      delay between requests in ms (default: 1100, for 1 req/s)
 *   --scrape-mode     use 'scrape' instead of 'search' for better matching
 *
 * Environment:
 *   SS_DEVID, SS_DEVPASSWORD  — ScreenScraper credentials (required)
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import initSqlJs from 'sql.js';

const PROGRESS_FILE = 'data/.translations-progress.json';
const DEFAULT_DB = 'data/roms.db';
const DEFAULT_SCRAPER = './target/release/scraper-cli';
const DEFAULT_OUTPUT = 'data/translations.json';
const DEFAULT_DELAY = 1100;

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--resume') { args.resume = true; continue; }
    if (a === '--scrape-mode') { args.scrapeMode = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { args[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        args[a.slice(2)] = process.argv[++i];
      } else { args[a.slice(2)] = true; }
    }
  }
  return args;
}

function execScraper(args, scraperPath) {
  const r = spawnSync(scraperPath, args, { encoding: 'utf8', timeout: 30000 });
  if (r.error) return { error: r.error.message };
  try { return JSON.parse(r.stdout); } catch { return { error: 'parse failed', stdout: r.stdout?.slice(0, 500) }; }
}

function loadTranslations(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function saveProgress(data) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function loadProgress() {
  try { return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function platformsForCollection(datasetPreset) {
  // Map dataset presets to ScreenScraper platform slugs
  // arcade presets search without platform (ScreenScraper handles it)
  if (datasetPreset === 'mame' || datasetPreset === 'fbneo') return null;
  return null; // Let scraper-cli handle platform resolution
}

async function main() {
  const args = parseArgs();
  const dbPath = args.db || DEFAULT_DB;
  const scraperPath = args.scraper || DEFAULT_SCRAPER;
  const outputPath = args.output || DEFAULT_OUTPUT;
  const delay = parseInt(args.delay) || DEFAULT_DELAY;
  const limit = args.limit ? parseInt(args.limit) : null;
  const scrapeMode = !!args.scrapeMode;

  if (!existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }
  if (!existsSync(scraperPath)) { console.error(`scraper-cli not found: ${scraperPath}`); process.exit(1); }

  // Check ScreenScraper credentials
  if (!process.env.SS_DEVID || !process.env.SS_DEVPASSWORD) {
    console.error('ScreenScraper credentials required: set SS_DEVID and SS_DEVPASSWORD');
    process.exit(1);
  }

  // Test scraper
  const test = execScraper(['test'], scraperPath);
  const ssStatus = test?.results?.find(r => r.name === 'screenscraper')?.status;
  if (ssStatus !== 'ok') {
    console.error(`ScreenScraper not available (status: ${ssStatus}). Check credentials.`);
    process.exit(1);
  }

  // Load SQLite via sql.js
  const SQL = await initSqlJs();
  const dbBuf = readFileSync(dbPath);
  const db = new SQL.Database(dbBuf);

  // Query games that have English descriptions, grouped by collection
  const games = db.exec(`
    SELECT g.name, g.description, g.platform, c.dataset_preset
    FROM games g
    JOIN collections c ON c.id = g.collection_id
    WHERE g.description IS NOT NULL AND g.description != ''
    ORDER BY c.dataset_preset, g.platform, g.name
  `);

  if (!games.length || !games[0].values.length) {
    console.log('No games found with descriptions.');
    process.exit(0);
  }

  const rows = games[0].values;
  console.log(`Found ${rows.length} games to process.`);

  if (limit) {
    console.log(`Limited to ${limit} games.`);
  }

  // Load existing translations for resume
  let translations = loadTranslations(outputPath);
  let processed = 0;
  let skipped = 0;

  // Load progress
  let progress = args.resume ? loadProgress() : null;
  let startIndex = 0;
  if (progress) {
    startIndex = progress.index || 0;
    console.log(`Resuming from index ${startIndex} (${progress.processed} processed, ${progress.skipped} skipped)`);
    processed = progress.processed || 0;
    skipped = progress.skipped || 0;
  }

  const toProcess = limit ? rows.slice(0, limit) : rows;
  const targetTotal = progress ? toProcess.length : toProcess.length;

  for (let i = startIndex; i < toProcess.length; i++) {
    const [name, description, platform, datasetPreset] = toProcess[i];

    // Skip if already in translations
    if (translations[name] && Object.keys(translations[name].translations || {}).length > 0) {
      skipped++;
      if (i % 100 === 0) {
        saveProgress({ index: i, processed, skipped, total: targetTotal });
      }
      continue;
    }

    const query = description || name;
    const searchArgs = ['search', query, '--source', 'screenscraper'];
    if (platform) searchArgs.push('--platform', platform);

    const result = execScraper(searchArgs, scraperPath);

    if (result?.results?.length) {
      const best = result.results[0];
      const titles = best.region_titles;

      if (titles && Object.keys(titles).length > 0) {
        translations[name] = {
          description,
          translations: titles,
        };
        processed++;
        if (i % 10 === 0 || processed % 10 === 0) {
          console.log(`[${i + 1}/${targetTotal}] ✓ ${name} → ${Object.keys(titles).join(', ')}`);
        }
      } else {
        translations[name] = { description, translations: {} };
        skipped++;
        if (i % 50 === 0) {
          console.log(`[${i + 1}/${targetTotal}] - ${name} (no translations)`);
        }
      }
    } else {
      translations[name] = { description, translations: {} };
      skipped++;
      if (i % 50 === 0) {
        console.log(`[${i + 1}/${targetTotal}] - ${name} (no match)`);
      }
    }

    // Save every 50 games
    if (i % 50 === 0 && i > 0) {
      writeFileSync(outputPath, JSON.stringify(translations, null, 2));
      saveProgress({ index: i, processed, skipped, total: targetTotal });
      console.log(`  → Saved ${Object.keys(translations).length} entries`);
    }

    await sleep(delay);
  }

  // Final save
  writeFileSync(outputPath, JSON.stringify(translations, null, 2));
  if (existsSync(PROGRESS_FILE)) {
    try { const fs = await import('fs'); fs.unlinkSync(PROGRESS_FILE); } catch {}
  }

  const total = processed + skipped;
  console.log(`\nDone! Processed ${total} games:`);
  console.log(`  ${processed} with translations`);
  console.log(`  ${skipped} without`);
  console.log(`  Output: ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
