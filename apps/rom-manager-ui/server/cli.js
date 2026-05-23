import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getDb, saveDb, initDb, getDbPath } from './db.js'

function findBinary() {
  const envBin = process.env.CLI_BINARY
  if (envBin && (envBin.includes('/') || fs.existsSync(envBin))) return envBin
  if (envBin) return envBin

  const candidates = [
    'rom-scraper-cli',
    path.join(__dirname, '..', '..', '..', 'target', 'release', 'rom-scraper-cli'),
    path.join(__dirname, '..', '..', '..', 'target', 'debug', 'rom-scraper-cli'),
    '/usr/local/bin/rom-scraper-cli',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
    try { execSync(`which ${c}`, { encoding: 'utf-8', stdio: 'ignore' }); return c }
    catch {}
  }
  return 'rom-scraper-cli'
}

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const CLI_BINARY = findBinary()

export function execCli(args) {
  saveDb()

  const dbPath = getDbPath()
  const cmd = [CLI_BINARY, ...args, '--json', '--db', dbPath].join(' ')

  let stdout
  try {
    stdout = execSync(cmd, { encoding: 'utf-8', timeout: 120000 })
  } catch (e) {
    const msg = e.stderr?.trim() || e.message
    throw new Error(`CLI error: ${msg}`)
  }

  initDb(dbPath)

  try {
    return JSON.parse(stdout.trim())
  } catch {
    return { raw: stdout.trim() }
  }
}
