import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb } from './db.js'
import { all, get, run } from './helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let currentJob = null

export function getQueue() {
  return all('SELECT * FROM download_queue ORDER BY created_at DESC')
}

export function getQueueItem(id) {
  return get('SELECT * FROM download_queue WHERE id = ?', [id])
}

export function enqueueGame(gameEntryId) {
  const game = get('SELECT g.*, sv.source FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id WHERE g.id = ?', [gameEntryId])
  if (!game) throw new Error('Game not found')
  if (game.source !== 'NPS') throw new Error('Only NPS downloads are supported')

  // Get all ROMs for this game (game + dlc + update)
  const roms = all('SELECT * FROM rom_entries WHERE game_entry_id = ? AND pkg_url != ""', [gameEntryId])
  if (roms.length === 0) throw new Error('No downloadable files found for this game')

  let enqueued = 0
  for (const rom of roms) {
    const existing = get('SELECT id FROM download_queue WHERE game_entry_id = ? AND filename = ? AND status IN (?, ?)',
      [gameEntryId, rom.filename, 'pending', 'downloading'])
    if (existing) continue

    run('INSERT INTO download_queue (game_entry_id, version_id, pkg_url, filename, file_size, expected_sha256, subtype) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gameEntryId, game.version_id, rom.pkg_url, rom.filename, rom.size || 0, rom.sha1 || '', rom.subtype || 'game'])
    enqueued++
  }

  processNext()

  return { enqueued }
}

const subscribers = new Set()

export function subscribeSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  // Send current queue state
  const queue = getQueue()
  res.write(`data: ${JSON.stringify({ type: 'queue', queue })}\n\n`)
  subscribers.add(res)
  res.on('close', () => subscribers.delete(res))
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const sub of subscribers) {
    try { sub.write(msg) } catch { subscribers.delete(sub) }
  }
}

function broadcastQueue() {
  const queue = getQueue()
  broadcast({ type: 'queue', queue })
}

export async function processNext() {
  if (currentJob) return

  const item = get("SELECT * FROM download_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
  if (!item) return

  currentJob = item

  try {
    run('UPDATE download_queue SET status = ?, progress = 0 WHERE id = ?', ['downloading', item.id])
    broadcastQueue()

    // Find the collection directory for this version
    const col = get(`SELECT c.folder, c.slug FROM collections c
      JOIN collection_versions cv ON cv.collection_id = c.id
      WHERE cv.version_id = ? LIMIT 1`, [item.version_id])
    const colFolder = col?.folder || col?.slug || String(item.version_id)
    const game = get('SELECT platform FROM game_entries WHERE id = ?', [item.game_entry_id])
    const platform = game?.platform || 'Games'

    const dataDir = path.resolve(__dirname, '..', '..', '..', 'data')
    const romsDir = path.join(dataDir, 'roms', colFolder, platform)
    const subDir = item.subtype === 'dlc' ? 'DLCs' : item.subtype === 'update' ? 'Updates' : 'Games'
    const subPath = path.join(romsDir, subDir)
    fs.mkdirSync(subPath, { recursive: true })

    const tempFile = path.join(dataDir, 'downloads', `.${item.filename}.part`)
    const finalFile = path.join(subPath, item.filename)

    // Skip if already exists
    if (fs.existsSync(finalFile)) {
      run('UPDATE download_queue SET status = ?, progress = 100, completed_at = datetime(\'now\') WHERE id = ?', ['completed', item.id])
      broadcastQueue()
      await checkGameComplete(item.game_entry_id)
      currentJob = null
      processNext()
      return
    }

    // Download with streaming
    const resp = await fetch(item.pkg_url, { signal: AbortSignal.timeout(120000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)

    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10)
    const reader = resp.body.getReader()
    const writer = fs.createWriteStream(tempFile)
    const hash = createHash('sha256')

    let downloaded = 0
    let lastBroadcast = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      writer.write(Buffer.from(value))
      hash.update(Buffer.from(value))
      downloaded += value.length

      const pct = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0
      if (pct - lastBroadcast >= 5 || pct === 100) {
        run('UPDATE download_queue SET progress = ? WHERE id = ?', [pct, item.id])
        broadcastQueue()
        lastBroadcast = pct
      }
    }

    writer.end()
    await new Promise(resolve => writer.on('finish', resolve))

    const sha256 = hash.digest('hex')

    // Verify SHA-256
    if (item.expected_sha256 && sha256 !== item.expected_sha256) {
      fs.unlinkSync(tempFile)
      throw new Error(`SHA-256 mismatch: expected ${item.expected_sha256}, got ${sha256}`)
    }

    // Move to final location
    fs.renameSync(tempFile, finalFile)

    run('UPDATE download_queue SET status = ?, progress = 100, completed_at = datetime(\'now\') WHERE id = ?', ['completed', item.id])
    broadcastQueue()

    await checkGameComplete(item.game_entry_id)
  } catch (err) {
    const retries = (item.retry_count || 0) + 1
    if (retries >= 3) {
      run('UPDATE download_queue SET status = ?, error = ?, retry_count = ? WHERE id = ?', ['failed', err.message, retries, item.id])
    } else {
      run('UPDATE download_queue SET status = ?, error = ?, retry_count = ? WHERE id = ?', ['pending', err.message, retries, item.id])
    }
    broadcastQueue()
  } finally {
    currentJob = null
    processNext()
  }
}

async function checkGameComplete(gameEntryId) {
  const pending = get('SELECT COUNT(*) as cnt FROM download_queue WHERE game_entry_id = ? AND status NOT IN (?, ?)',
    [gameEntryId, 'completed', 'failed'])
  if (pending.cnt > 0) return

  // All downloads for this game entry are done — scan collection dir to detect ALL files
  try {
    const game = get('SELECT g.*, c.folder FROM game_entries g JOIN set_versions sv ON sv.id = g.version_id LEFT JOIN collection_versions cv ON cv.version_id = sv.id LEFT JOIN collections c ON c.id = cv.collection_id WHERE g.id = ?', [gameEntryId])
    if (game && game.folder) {
      const collectionDir = path.resolve(__dirname, '..', '..', '..', 'data', 'roms', game.folder)
      if (fs.existsSync(collectionDir)) {
        const foundFiles = []
        function walkDir(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walkDir(path.join(dir, entry.name))
            else if (entry.name.endsWith('.pkg')) foundFiles.push(entry.name)
          }
        }
        walkDir(collectionDir)
        // Match PKG filenames against rom_entries and update game_state
        for (const fname of foundFiles) {
          run(`INSERT INTO game_state (game_entry_id, available, updated_at)
            SELECT r.game_entry_id, 1, datetime('now') FROM rom_entries r
            WHERE r.filename = ? AND r.game_entry_id IN (SELECT id FROM game_entries WHERE version_id = ?)
            ON CONFLICT(game_entry_id) DO UPDATE SET available = 1, updated_at = datetime('now')`, [fname, game.version_id])
        }
      }
    }
  } catch (_) {}
  broadcastQueue()
}

export function retryDownload(id) {
  run('UPDATE download_queue SET status = ?, error = NULL, progress = 0, retry_count = 0 WHERE id = ?', ['pending', id])
  broadcastQueue()
  processNext()
}

export function clearDownload(id) {
  run('DELETE FROM download_queue WHERE id = ?', [id])
  broadcastQueue()
}

export function clearCompleted() {
  run("DELETE FROM download_queue WHERE status IN ('completed', 'failed')")
  broadcastQueue()
}
