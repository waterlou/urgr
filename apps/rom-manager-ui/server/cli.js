import { execFileSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getDb, saveDb, initDb, getDbPath } from './db.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const CLI_NAMES = {
  scraper: 'scraper-cli',
  parse: 'parse-cli',
  build: 'build-cli',
  nps: 'nps-cli',
};

const SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'data', '.env');
const SETTINGS_KEYS = [
  'SS_DEVID', 'SS_DEVPASSWORD', 'SS_USERNAME', 'SS_PASSWORD',
  'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET',
  'TGDB_API_KEY',
  'SCRAPER_SOURCE',
];

function loadScraperEnv() {
  const env = { ...process.env };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const text = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (SETTINGS_KEYS.includes(key)) {
          env[key] = val;
        }
      }
    }
  } catch (e) {
    console.error('Error reading .env for scraper:', e.message);
  }
  return env;
}

function findBinary(binary) {
  const envKey = binary === 'scraper' ? 'SCRAPER_CLI_BINARY'
    : binary === 'parse' ? 'PARSE_CLI_BINARY'
    : binary === 'nps' ? 'NPS_CLI_BINARY'
    : 'BUILD_CLI_BINARY';
  const envBin = process.env[envKey];
  if (envBin && (envBin.includes('/') || fs.existsSync(envBin))) return envBin;
  if (envBin) return envBin;

  const name = CLI_NAMES[binary];
  const candidates = [
    name,
    path.join(__dirname, '..', '..', '..', 'target', 'release', name),
    path.join(__dirname, '..', '..', '..', 'target', 'debug', name),
    `/usr/local/bin/${name}`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
    try { execSync(`which ${c}`, { encoding: 'utf-8', stdio: 'ignore' }); return c; } catch {}
  }
  return name;
}

export function execCli(args, { binary = 'build' } = {}) {
  const bin = findBinary(binary);
  const dbPath = getDbPath();

  const needsDb = binary === 'parse' || binary === 'build' || binary === 'nps';
  if (needsDb) saveDb();

  const cmdArgs = [bin, ...args, '--json', '--db', dbPath];

  let stdout;
  try {
    const opts = { encoding: 'utf-8', timeout: 120000, maxBuffer: 100 * 1024 * 1024 };
    if (binary === 'scraper') opts.env = loadScraperEnv();
    stdout = execFileSync(cmdArgs[0], cmdArgs.slice(1), opts);
  } catch (e) {
    const msg = e.stderr?.trim() || e.message;
    throw new Error(`CLI error: ${msg}`);
  }

  if (needsDb) initDb(dbPath);

  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { raw: stdout.trim() };
  }
}

export function execCliStream(args, { binary = 'build', onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findBinary(binary);
    const dbPath = getDbPath();

  const needsDb = binary === 'parse' || binary === 'build' || binary === 'nps';
    if (needsDb) saveDb();

    const cmdArgs = [...args, '--json', '--progress', '--db', dbPath];
    const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };
    if (binary === 'scraper') spawnOpts.env = loadScraperEnv();
    const child = spawn(bin, cmdArgs, spawnOpts);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (onProgress) {
        const lines = chunk.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const progress = JSON.parse(line);
            if (progress.phase && progress.pct !== undefined) {
              onProgress(progress);
            }
          } catch {
            // non-JSON stderr output (log messages)
          }
        }
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (needsDb) initDb(dbPath);

      if (signal?.aborted) {
        reject(new Error('Build cancelled'));
        return;
      }

      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch {
          resolve({ raw: stdout.trim() });
        }
      } else {
        // Try to extract error from stderr (skip JSON progress lines)
        const stderrLines = stderr.split('\n').filter(l => l.trim());
        const nonJson = stderrLines.filter(l => !l.trim().startsWith('{'));
        let errMsg = nonJson.pop() || '';
        // If stderr has no useful error, try stdout
        if (!errMsg) {
          try {
            const out = JSON.parse(stdout.trim());
            errMsg = out.error || JSON.stringify(out);
          } catch {
            errMsg = stdout.trim().slice(0, 200) || `CLI exited with code ${code}`;
          }
        }
        console.error(`[cli] ${binary} exited with code ${code}: ${errMsg}`);
        reject(new Error(`CLI error: ${errMsg}`));
      }
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      });
    }
  });
}
