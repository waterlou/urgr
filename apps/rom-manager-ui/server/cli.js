import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getDb, saveDb, initDb, getDbPath } from './db.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const CLI_NAMES = {
  scraper: 'scraper-cli',
  parse: 'parse-cli',
  build: 'build-cli',
};

function findBinary(binary) {
  const envKey = binary === 'scraper' ? 'SCRAPER_CLI_BINARY'
    : binary === 'parse' ? 'PARSE_CLI_BINARY'
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

  const needsDb = binary === 'parse' || binary === 'build';
  if (needsDb) saveDb();

  const cmd = [bin, ...args, '--json', '--db', dbPath].join(' ');

  let stdout;
  try {
    stdout = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
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

    const needsDb = binary === 'parse' || binary === 'build';
    if (needsDb) saveDb();

    const cmdArgs = [...args, '--json', '--progress', '--db', dbPath];
    const child = spawn(bin, cmdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
        const errMsg = stderr.split('\n').filter(l => !l.startsWith('{')).pop() || `CLI exited with code ${code}`;
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
