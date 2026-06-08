import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getGame, coverUrl, scrapeGameMetadata, enqueueDownload } from '../api.js'

export default function GameDetail({ gameId, onBack, onNavigate }) {
  const [game, setGame] = useState(null)
  const [scraping, setScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState(null)
  const [scrapedTitle, setScrapedTitle] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [coverFailed, setCoverFailed] = useState(false)
  const [downloadMsg, setDownloadMsg] = useState(null)

  useEffect(() => {
    getGame(gameId).then(g => {
      setGame(g)
      if (!g.manufacturer && !g.year && !g.region && !g.description) {
        setScraping(true)
        setScrapeError(null)
        scrapeGameMetadata(gameId)
          .then(res => {
            if (res.scraped) {
              setScrapedTitle(res.title)
              setGame(res.game)
            } else {
              setScrapeError(res.error || 'No metadata found')
            }
          })
          .catch(err => setScrapeError(err.message))
          .finally(() => setScraping(false))
      }
    }).catch(console.error)
  }, [gameId])

  // Refresh game data when tab becomes visible (download state may have changed)
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        getGame(gameId).then(g => { if (g) setGame(g) }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [gameId])

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') { if (lightbox) setLightbox(null); else onBack?.() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onBack, lightbox])

  async function handleScrape() {
    setScraping(true)
    setScrapeError(null)
    setScrapedTitle(null)
    try {
      const res = await scrapeGameMetadata(gameId)
      if (res.scraped) {
        setScrapedTitle(res.title)
        setGame(res.game)
      } else {
        setScrapeError(res.error || 'No metadata found')
      }
    } catch (err) {
      setScrapeError(err.message)
    } finally {
      setScraping(false)
    }
  }

  async function handleDownload() {
    setDownloadMsg('Adding to queue...')
    try {
      const res = await enqueueDownload(gameId)
      setDownloadMsg(`Added ${res.enqueued} file(s) to download queue`)
    } catch (err) {
      setDownloadMsg(`Error: ${err.message}`)
    }
    setTimeout(() => setDownloadMsg(null), 4000)
  }

  if (!game) return (
    <div className="detail-page">
      <div className="detail-nav">
        <button className="back-btn" onClick={onBack}>
          <span className="icon">arrow_back</span>
        </button>
        <span className="detail-nav-title">Loading...</span>
      </div>
      <div className="detail-page-body">
        <div className="loading-screen"><div className="loading-spinner" /></div>
      </div>
    </div>
  )

  const coverArr = Array.isArray(game.covers) ? game.covers : []
  const screenshotArr = Array.isArray(game.screenshots) ? game.screenshots : []
  const hasCover = coverArr.length > 0 && !coverFailed
  const screenshots = screenshotArr.filter(Boolean)

  return (
    <div className="detail-page">
      {lightbox && createPortal(
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="lightbox-img" />
        </div>,
        document.body
      )}

      <div className="detail-nav">
        <button className="back-btn" onClick={onBack}>
          <span className="icon">arrow_back</span>
        </button>
        <span className="detail-nav-title">{game.name}</span>
      </div>

      <div className="detail-page-body">
        <div className="detail-header">
          {hasCover && (
            <div className="detail-cover">
              <img
                src={game.covers[0]}
                alt=""
                className="detail-cover-img"
                onError={() => setCoverFailed(true)}
                onClick={() => setLightbox(game.covers[0])}
              />
            </div>
          )}
          <div className="detail-info">
            <h1 className="detail-title">{game.name}</h1>
            {game.description && <p className="detail-subtitle">{game.description}</p>}
            <div className="modal-meta">
              <span className="badge">{game.source} {game.version}</span>
              {game.region && <span className="badge">{game.region}</span>}
              {game.year && <span className="badge">{game.year}</span>}
              {game.platform && <span className="badge">{game.platform}</span>}
              {game.manufacturer && <span className="badge">{game.manufacturer}</span>}
              {game.parent && (
                <span className="badge badge-parent" style={{cursor:'pointer'}} onClick={() => onNavigate?.(game.parent.id)}>
                  Parent: {game.parent.name} ({game.parent.region})
                </span>
              )}
              {game.synopsis && <span className="badge badge-scraped">Scraped</span>}
            </div>

            {scrapedTitle && <p className="scrape-success">Matched: {scrapedTitle}</p>}

            {!scraping && (
              <button className="btn btn-sm rescrape-btn" onClick={handleScrape}>
                <span className="icon">refresh</span> {game.manufacturer ? 'Rescrape' : 'Scrape'}
              </button>
            )}
            {downloadMsg && <p className="scrape-success">{downloadMsg}</p>}
          </div>
        </div>

        {scraping ? (
          <p className="modal-description"><em>Scraping metadata...</em></p>
        ) : game.synopsis ? (
          <p className="modal-description">{game.synopsis}</p>
        ) : (
          <p className="modal-description">
            {'No description available.'}
            {scrapeError && <span className="scrape-error"> ({scrapeError})</span>}
          </p>
        )}

        {screenshots.length > 0 && (
          <section>
            <h2>Screenshots</h2>
            <div className="screenshot-grid">
              {screenshots.map((url, i) => (
                <div key={i} className="screenshot-item" onClick={() => setLightbox(url)}>
                  <img src={url} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          </section>
        )}

        {game.clones && game.clones.length > 0 && (
          <section>
            <h2>Variants ({game.clones.length})</h2>
            <div className="variants-list">
              {game.clones.map(c => (
                <div key={c.name} className="variant-item" onClick={() => onNavigate?.(c.id)} style={{cursor:'pointer'}}>
                  <span className="variant-name">{c.description || c.name}</span>
                  {c.region && <span className="badge">{c.region}</span>}
                  <span className="variant-romname">{c.name}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {game.roms && game.roms.length > 0 && (
          <section>
            <h2>ROM Files ({game.roms.length})</h2>
            <div className="rom-table-wrapper">
              <table className="rom-table">
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>SHA1</th>
                  </tr>
                </thead>
                <tbody>
                  {game.roms.map(rom => (
                    <tr key={rom.id}>
                      <td className="rom-filename">{rom.filename}</td>
                      <td><span className="badge">{rom.subtype || 'game'}</span></td>
                      <td>{rom.size != null ? formatSize(rom.size) : '-'}</td>
                      <td><span className={`rom-status rom-status-${rom.status}`}>{rom.status}</span></td>
                      <td className="rom-hash">{rom.sha1 ? rom.sha1.slice(0, 16) + '...' : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {game.source === 'NPS' && (
          <section>
            {game.available
              ? <span className="badge" style={{background:'var(--accent)', color:'#fff', marginBottom:8}}>Downloaded</span>
              : <button className="btn btn-sm" onClick={handleDownload}>
                  <span className="icon">download</span> Download
                </button>
            }
            {(() => {
              const dlcs = game.roms?.filter(r => r.subtype === 'dlc').length || 0;
              const updates = game.roms?.filter(r => r.subtype === 'update').length || 0;
              const extra = [];
              if (dlcs) extra.push(`${dlcs} DLC${dlcs > 1 ? 's' : ''}`);
              if (updates) extra.push(`${updates} update${updates > 1 ? 's' : ''}`);
              return extra.length > 0
                ? <p style={{fontSize:12, opacity:0.6, marginTop:4}}>Includes {extra.join(', ')}</p>
                : null;
            })()}
            {downloadMsg && <p className="scrape-success" style={{marginTop:4}}>{downloadMsg}</p>}
          </section>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
