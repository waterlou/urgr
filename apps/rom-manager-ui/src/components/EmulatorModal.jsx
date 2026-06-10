import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getEmulatorCore } from '../platformEmulator.js'
import { playUrl } from '../api.js'

const EJS_CDN = 'https://cdn.emulatorjs.org/nightly/data/'

export default function EmulatorModal({ game, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const core = getEmulatorCore(game.platform, game.source)

  // Listen for iframe loaded signal
  useEffect(() => {
    function handler(e) {
      if (e.data === 'ejs-loaded') setLoading(false)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Escape key handler
  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!core && !error) {
    // Need setTimeout to avoid setState during render
    setTimeout(() => setError(`Platform "${game.platform}" is not supported by EmulatorJS`), 0)
  }

  // Build iframe as a self-contained HTML page (complete isolation from main page)
  const iframeHtml = core ? `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;overflow:hidden;width:100vw;height:100vh}
  #emulator-game{width:100%;height:100%}
</style>
</head>
<body>
<div id="emulator-game"></div>
<script>
  window.EJS_player='#emulator-game';
  window.EJS_core='${core.replace(/'/g, "\\'")}';
  window.EJS_gameName='${game.name.replace(/'/g, "\\'")}';
  window.EJS_gameUrl='${playUrl(game.id)}';
  window.EJS_color='#1a1a2e';
  window.EJS_fullscreenOnExit=false;
  window.EJS_startOnLoaded=true;
  window.EJS_volume=1.0;
  window.EJS_lang='en';
  window.EJS_pathtodata='${EJS_CDN}';
  var s=document.createElement('script');
  s.src='${EJS_CDN}loader.js?_='+Date.now();
  s.onload=function(){parent.postMessage('ejs-loaded','*')};
  document.head.appendChild(s);
<\/script>
</body>
</html>` : ''

  return createPortal(
    <div className="emulator-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="emulator-modal">
        <div className="emulator-header">
          <span className="emulator-title">{game.name}</span>
          <button className="emulator-close" onClick={onClose}>
            <span className="icon">close</span>
          </button>
        </div>
        <div className="emulator-body" style={{padding:0}}>
          {error ? (
            <div className="emulator-error">
              <span className="icon" style={{fontSize:48,opacity:0.3}}>error</span>
              <p>{error}</p>
            </div>
          ) : (
            <>
              {loading && (
                <div className="emulator-loading">
                  <div className="loading-spinner" />
                  <p>Loading emulator...</p>
                </div>
              )}
              {iframeHtml && (
                <iframe
                  src={'data:text/html;charset=utf-8,' + encodeURIComponent(iframeHtml)}
                  style={{width:'100%',height:'100%',border:'none',display: loading ? 'none' : 'block'}}
                  title="Emulator"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
