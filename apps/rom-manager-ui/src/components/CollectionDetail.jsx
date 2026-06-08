import { useState, useEffect } from 'react'
import IconDisplay from './IconDisplay.jsx'
import { getCollectionVersions, getCollectionGames } from '../api.js'
import VersionManager from './VersionManager.jsx'
import IaDownload from './IaDownload.jsx'
import BuildManager from './BuildManager.jsx'
import ExportPanel from './ExportPanel.jsx'

export default function CollectionDetail({ collectionId, collection, onBrowseGames, onRefresh }) {
  const [versions, setVersions] = useState([])
  const [builds, setBuilds] = useState([])
  const [loading, setLoading] = useState(true)
  const [gameCount, setGameCount] = useState(0)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const vers = await getCollectionVersions(collectionId).catch(() => [])
        if (cancelled) return
        setVersions(vers)
        const games = await getCollectionGames(collectionId, { limit: 1 })
        if (cancelled) return
        setGameCount(games.total || 0)
      } catch (e) {
        console.error('Failed to load collection detail:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [collectionId])

  // Clear notifications after 5s
  useEffect(() => {
    if (!error && !info) return
    const t = setTimeout(() => { setError(null); setInfo(null) }, 5000)
    return () => clearTimeout(t)
  }, [error, info])

  if (loading) {
    return <div className="loading-screen"><div className="loading-spinner" /></div>
  }

  const collectionVersions = versions.filter(v =>
    builds.some(b => b.version_id === v.id)
  )

  const latestImported = collectionVersions.length > 0
    ? collectionVersions.reduce((a, b) => {
        const va = a.version.split('.').map(Number)
        const vb = b.version.split('.').map(Number)
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
          if ((va[i]||0) !== (vb[i]||0)) return (va[i]||0) > (vb[i]||0) ? a : b
        }
        return a
      })
    : null

  return (
    <div className="browser">
      <div className="browser-header">
        <div className="browser-title-row">
          <span className="browser-title-icon"><IconDisplay name={collection?.logo} fallback="folder" /></span>
          <h1 className="browser-title">{collection?.name || 'Collection'}</h1>
          <span className="browser-count">{gameCount} games</span>
          {collection?.platform && <span className="platform-badge">{collection.platform}</span>}
          {latestImported && <span className="platform-badge" style={{background:'var(--accent-dim)',color:'var(--accent)'}}>Latest: {latestImported.version}</span>}
        </div>

        <div className="collection-actions">
          <button className="btn btn-primary" onClick={onBrowseGames}>Browse Games</button>
        </div>

        {error && <div className="notification error">{error}</div>}
        {info && <div className="notification info">{info}</div>}
      </div>

      <div className="browser-content">
        <VersionManager
          collectionId={collectionId}
          collection={collection}
          versions={versions}
          onVersionsChange={setVersions}
          onRefresh={onRefresh}
        />

        <IaDownload collectionId={collectionId} />

        <BuildManager
          collectionId={collectionId}
          collection={collection}
          versions={versions}
          onBuildsChange={setBuilds}
          onError={setError}
          onInfo={setInfo}
        />

        <ExportPanel collectionId={collectionId} />
      </div>
    </div>
  )
}
