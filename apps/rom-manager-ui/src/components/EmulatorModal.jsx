import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getEmulatorCore } from '../platformEmulator.js'
import { playUrl } from '../api.js'

const EJS_CDN = 'https://cdn.emulatorjs.org/nightly/data/'

let scriptLoaded = false

function loadScript() {
  // Remove any previous loader script
  document.querySelectorAll('script[src*="loader.js"]').forEach(s => s.remove())
  scriptLoaded = false
  // Always load fresh — no caching (EmulatorJS doesn't support re-init)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = EJS_CDN + 'loader.js?_=' + Date.now()
    s.onload = () => { scriptLoaded = true; resolve() }
    s.onerror = () => reject(new Error('Failed to load EmulatorJS'))
    document.head.appendChild(s)
  })
}

export default function EmulatorModal({ game, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Force fresh container on each mount (cache-bust timestamp)
  const containerKey = `ejs-${Date.now()}`

  useEffect(() => {
    let destroyed = false

    async function init() {
      try {
        const core = getEmulatorCore(game.platform, game.source)
        if (!core) {
          setError(`Platform "${game.platform}" is not supported by EmulatorJS`)
          setLoading(false)
          return
        }

        // Set globals BEFORE loading script
        window.EJS_player = '#emulator-game'
        window.EJS_core = core
        window.EJS_gameName = game.name
        window.EJS_gameUrl = playUrl(game.id)
        window.EJS_color = '#1a1a2e'
        window.EJS_fullscreenOnExit = false
        window.EJS_startOnLoaded = true
        window.EJS_volume = 1.0
        window.EJS_lang = 'en'
        window.EJS_pathtodata = EJS_CDN

        await loadScript()

        if (!destroyed) setLoading(false)
      } catch (err) {
        if (!destroyed) { setError(err.message); setLoading(false) }
      }
    }

    init()

    return () => {
      destroyed = true

      try {
        const emu = window.EJS_emulator
        if (emu) {
          const al = emu.Module?.AL?.currentCtx
          if (al?.audioCtx) al.audioCtx.close().catch(() => {})
          if (emu.Module?.pauseMainLoop) emu.Module.pauseMainLoop()
        }
      } catch {}

      document.querySelectorAll('canvas').forEach(c => c.remove())
      document.querySelectorAll('iframe').forEach(c => c.remove())
      const el = document.getElementById('emulator-game')
      if (el) el.innerHTML = ''
      document.querySelectorAll('script[src*="loader.js"]').forEach(s => s.remove())

      try { delete window.EJS_gameUrl } catch {}
      try { delete window.EJS_emulator } catch {}
      try { delete window.EJS_core } catch {}
    }
  }, [game])

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return createPortal(
    <div className="emulator-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="emulator-modal">
        <div className="emulator-header">
          <span className="emulator-title">{game.name}</span>
          <button className="emulator-close" onClick={onClose}>
            <span className="icon">close</span>
          </button>
        </div>
        <div className="emulator-body">
          {loading && !error && (
            <div className="emulator-loading">
              <div className="loading-spinner" />
              <p>Loading emulator...</p>
            </div>
          )}
          {error && (
            <div className="emulator-error">
              <span className="icon" style={{ fontSize: 48, opacity: 0.3 }}>error</span>
              <p>{error}</p>
            </div>
          )}
          <div id="emulator-game" key={containerKey} className="emulator-game-container" />
        </div>
      </div>
    </div>,
    document.body
  )
}
