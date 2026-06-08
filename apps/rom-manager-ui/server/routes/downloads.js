import { Router } from 'express'
import { enqueueGame, getQueue, subscribeSSE, retryDownload, clearDownload, clearCompleted } from '../downloader.js'

const router = Router()

router.post('/api/downloads/enqueue', (req, res) => {
  try {
    const { game_entry_id } = req.body
    if (!game_entry_id) return res.status(400).json({ error: 'game_entry_id required' })
    const result = enqueueGame(game_entry_id)
    res.json({ ok: true, ...result })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.get('/api/downloads', (req, res) => {
  try {
    const queue = getQueue()
    res.json({ queue })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/api/downloads/status', (req, res) => {
  subscribeSSE(res)
})

router.post('/api/downloads/:id/retry', (req, res) => {
  try {
    retryDownload(Number(req.params.id))
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/api/downloads/:id/clear', (req, res) => {
  try {
    clearDownload(Number(req.params.id))
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/api/downloads/clear-completed', (req, res) => {
  try {
    clearCompleted()
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

export default router
