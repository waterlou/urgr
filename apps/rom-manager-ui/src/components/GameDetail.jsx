import { useState, useEffect } from 'react'
import { getGame, coverUrl } from '../api.js'

export default function GameDetail({ gameId, onClose }) {
  const [game, setGame] = useState(null)

  useEffect(() => {
    getGame(gameId).then(setGame).catch(console.error)
  }, [gameId])

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!game) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><span className="icon">close</span></button>
        <div className="modal-header" style={{
          backgroundImage: `linear-gradient(to top, #141414 0%, transparent 100%), url(${coverUrl(game.id)})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        }}>
          <div className="modal-header-content">
            <h1 className="modal-title">{game.description || game.name}</h1>
            <div className="modal-meta">
              <span className="badge">{game.source} {game.version}</span>
              {game.year && <span className="badge">{game.year}</span>}
              {game.manufacturer && <span className="badge">{game.manufacturer}</span>}
              {game.cloneof && <span className="badge badge-clone">clone of {game.cloneof}</span>}
            </div>
          </div>
        </div>
        <div className="modal-body">
          <p className="modal-description">{game.description || 'No description available.'}</p>

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
