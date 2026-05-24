import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(__dirname, '..', '..', 'target', 'release');

function findBinary(name) {
  const bin = name === 'scraper-cli' ? 'rom-scraper-cli' : 'rom-manager-cli';
  const searchPaths = [cliDir, '/usr/local/bin', process.cwd()];
  for (const dir of searchPaths) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return bin;
}

export function runCli(cliName, args, { onProgress, onResult, onError, onExit, signal }) {
  const bin = findBinary(cliName);
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t);
        if (msg.type === 'progress') onProgress?.(msg);
        else if (msg.type === 'result') onResult?.(msg.data);
        else if (msg.type === 'error') onError?.(msg.error);
      } catch { /* ignore malformed */ }
    }
  });

  child.stderr.on('data', () => {});

  child.on('error', (err) => onError?.(err.message));
  child.on('close', (code) => {
    // flush remaining
    if (buf.trim()) {
      try {
        const msg = JSON.parse(buf.trim());
        if (msg.type === 'result') onResult?.(msg.data);
        else if (msg.type === 'error') onError?.(msg.error);
      } catch {}
    }
    onExit?.(code);
  });

  if (signal) {
    signal.addEventListener('abort', () => { child.kill('SIGTERM'); }, { once: true });
  }

  return child;
}
