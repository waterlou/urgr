import { useState, useEffect } from 'react'
import { getCollections, getCollectionGames } from '../api.js'
import IconDisplay from './IconDisplay.jsx'

export default function Dashboard({ onSelectCollection }) {
  const [collections, setCollections] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCollections().then(data => {
      setCollections(data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

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
    </div>
  )
}
