import { useState, useEffect } from 'react'
import { getCollections, getRecentlyPlayed, recordPlay } from '../api.js'
import { isEmulatorSupported } from '../platformEmulator.js'
import IconDisplay from './IconDisplay.jsx'
import EmulatorModal from './EmulatorModal.jsx'

export default function Dashboard({ onSelectCollection, onSelectGame }) {
  const [collections, setCollections] = useState([])
  const [recentGames, setRecentGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [emulatorGame, setEmulatorGame] = useState(null)
  const [emuKey, setEmuKey] = useState(0)
  const [orientations, setOrientations] = useState({})

  useEffect(() => {
    Promise.all([
      getCollections().catch(() => []),
      getRecentlyPlayed().catch(() => ({ games: [] }))
    ]).then(([cols, gamesData]) => {
      setCollections(cols || [])
      setRecentGames(gamesData.games || [])
      setLoading(false)
    })
  }, [])

  function handlePlayGame(e, game) {
    e.stopPropagation()
    if (!isEmulatorSupported(game.platform, game.source)) return
    recordPlay(game.id).catch(() => {})
    setEmulatorGame(game)
    setEmuKey(k => k + 1)
  }

  function handleImgLoad(e, gameId) {
    const { naturalWidth, naturalHeight } = e.target
    if (naturalWidth && naturalHeight) {
      setOrientations(prev => ({ ...prev, [gameId]: naturalWidth > naturalHeight ? 'landscape' : 'portrait' }))
    }
  }

  if (loading) {
    return <div className="loading-screen"><div className="loading-spinner" /></div>
  }

  const totalGames = collections.reduce((s, c) => s + (c.total_games || 0), 0)
  const totalAvailable = collections.reduce((s, c) => s + (c.available_games || 0), 0)

  return (
    <div className="browser">
      <div className="browser-header">
        <div className="browser-title-row">
          <h1 className="browser-title">Dashboard</h1>
          <span className="browser-count">{totalGames} games</span>
          <span className="platform-badge" style={{background:'var(--accent-dim)',color:'var(--accent)'}}>{totalAvailable} available</span>
        </div>
      </div>

      <div className="browser-content">
        {recentGames.length > 0 && (
          <section className="recently-played">
            <h2 className="section-title">Recently Played</h2>
            <div className="recently-played-grid">
              {recentGames.map(game => {
                const img = game.screenshots?.length > 0 ? (() => { let u = game.screenshots[0]; if (u.startsWith('//')) u = 'https:' + u; return u; })() : null
                const supported = isEmulatorSupported(game.platform, game.source)
                const orient = orientations[game.id]
                return (
                  <div key={game.id} className={`recently-played-card${orient ? ' ' + orient : ''}`} onClick={() => onSelectGame(game)}>
                    <div className="recently-played-img">
                      {img ? <img src={img} alt="" loading="lazy" onLoad={e => handleImgLoad(e, game.id)} /> : <div className="recently-played-placeholder"><span className="icon">image_not_supported</span></div>}
                      {supported && (
                        <button className="recently-played-play" onClick={e => handlePlayGame(e, game)} title={`Play ${game.name}`}>
                          <span className="icon">play_arrow</span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {collections.length === 0 ? (
          <p className="modal-description">No collections yet. Create one to get started.</p>
        ) : (
          <div className="dashboard-grid">
            {collections.map(col => {
              const pct = col.total_games > 0 ? Math.round((col.available_games || 0) / col.total_games * 100) : 0
              return (
                <div key={col.id} className="dashboard-card" onClick={() => onSelectCollection(col.id)} style={{cursor:'pointer'}}>
                  <div className="dashboard-card-header">
                    <IconDisplay name={col.logo} fallback="folder" size={32} />
                    <div>
                      <div className="dashboard-card-name">{col.name}</div>
                      {col.platform && <span className="dashboard-card-platform">{col.platform}</span>}
                    </div>
                  </div>
                  <div className="dashboard-card-stats">
                    <span className="dashboard-stat">{col.available_games || 0} / {col.total_games || 0} games</span>
                  </div>
                  <div className="dashboard-bar-track">
                    <div className="dashboard-bar-fill" style={{width:`${pct}%`}} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {emulatorGame && <EmulatorModal key={emuKey} game={emulatorGame} onClose={() => setEmulatorGame(null)} />}
    </div>
  )
}
