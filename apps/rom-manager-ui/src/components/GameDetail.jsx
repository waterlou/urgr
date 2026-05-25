import { useState, useEffect } from 'react'
import { getGame, coverUrl, scrapeGameMetadata } from '../api.js'

export default function GameDetail({ gameId, onClose, onNavigate }) {
  const [game, setGame] = useState(null)
  const [scraping, setScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState(null)
  const [scrapedTitle, setScrapedTitle] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [coverFailed, setCoverFailed] = useState(false)

  useEffect(() => {
    getGame(gameId).then(g => {
      setGame(g)
      if (!g.manufacturer && !g.year) {
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

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') { if (lightbox) setLightbox(null); else onClose() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, lightbox])

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

  if (!game) return null

  const coverArr = Array.isArray(game.covers) ? game.covers : []
  const screenshotArr = Array.isArray(game.screenshots) ? game.screenshots : []
  const hasCover = coverArr.length > 0 && !coverFailed
  const screenshots = screenshotArr.filter(Boolean)

  return (
    <div className="modal-backdrop" onClick={lightbox ? () => setLightbox(null) : onClose}>
      <div className="modal-content game-detail-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={lightbox ? () => setLightbox(null) : onClose}><span className="icon">close</span></button>

        {lightbox && (
          <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="" className="lightbox-img" />
          </div>
        )}

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
            <h1 className="detail-title">{game.description || game.name}</h1>
            <div className="modal-meta">
              <span className="badge">{game.source} {game.version}</span>
              {game.year && <span className="badge">{game.year}</span>}
              {game.manufacturer && <span className="badge">{game.manufacturer}</span>}
              {game.cloneof && <span className="badge badge-clone">clone of {game.cloneof}</span>}
              {game.synopsis && <span className="badge badge-scraped">Scraped</span>}
            </div>

            {scrapedTitle && <p className="scrape-success">Matched: {scrapedTitle}</p>}

            {!scraping && (
              <button className="btn btn-sm rescrape-btn" onClick={handleScrape}>
                <span className="icon">refresh</span> {game.manufacturer ? 'Rescrape' : 'Scrape'}
              </button>
            )}
          </div>
        </div>

        <div className="modal-body">
          {scraping ? (
            <p className="modal-description"><em>Scraping metadata...</em></p>
          ) : game.synopsis ? (
            <p className="modal-description">{game.synopsis}</p>
          ) : (
            <p className="modal-description">
              {game.description && game.description !== game.name ? game.description : 'No description available.'}
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
                      <th>Size</th>
                      <th>Status</th>
                      <th>SHA1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.roms.map(rom => (
                      <tr key={rom.id}>
                        <td className="rom-filename">{rom.filename}</td>
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

          {game.scanned_games && game.scanned_games.length > 0 && (
            <section>
              <h2>Scanned Files ({game.scanned_games.length})</h2>
              <div className="rom-table-wrapper">
                <table className="rom-table">
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th>Size</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.scanned_games.map(sg => (
                      <tr key={sg.id}>
                        <td className="rom-filename">{sg.filename}</td>
                        <td>{sg.size != null ? formatSize(sg.size) : '-'}</td>
                        <td><span className={`rom-status rom-status-${sg.status}`}>{sg.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}