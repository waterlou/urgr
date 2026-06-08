import { useState, useEffect, useRef } from 'react'
import IconDisplay from './IconDisplay.jsx'
import { getCollectionVersions, getCollectionGames, scrapeAllCollectionGames, importOnlineVersion, importNps } from '../api.js'
import { subscribeJobSSE, cancelJob } from '../api.js'
import VersionManager from './VersionManager.jsx'
import IaDownload from './IaDownload.jsx'
import BuildManager from './BuildManager.jsx'
import ExportPanel from './ExportPanel.jsx'

export default function CollectionDetail({ collectionId, collection, onBrowseGames, onBack, onRefresh }) {
  const [versions, setVersions] = useState([])
  const [builds, setBuilds] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [gameCount, setGameCount] = useState(0)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [scrapeAllRunning, setScrapeAllRunning] = useState(false)
  const [scrapeAllProgress, setScrapeAllProgress] = useState('')
  const [scrapeAllResult, setScrapeAllResult] = useState(null)
  const [scrapeAllJobId, setScrapeAllJobId] = useState(null)
  const importRan = useRef(false)

  useEffect(() => {
    importRan.current = false
    let cancelled = false
    async function load() {
      try {
        const vers = await getCollectionVersions(collectionId).catch(() => [])
        if (cancelled) return
        setVersions(vers)

        // Auto-import on first mount if collection has preset but no versions yet
        if (!importRan.current && vers.length === 0 && collection?.has_dataset && collection?.dataset_preset && collection?.folder) {
          importRan.current = true
          setImporting(true)
          try {
            const preset = collection.dataset_preset
            if (preset === 'NPS') {
              const platform = collection.folder.replace(/^nps-/i, '').toUpperCase()
              if (platform) await importNps(collectionId, platform)
            } else {
              const systemName = collection.name.replace(/^(OfflineList|DAT-O-MATIC)\s*/i, '')
              if (systemName) await importOnlineVersion(collectionId, systemName, preset)
            }
          } catch (e) {
            console.error('Auto-import failed:', e.message)
          }
          setImporting(false)
          // Reload versions after import
          const updated = await getCollectionVersions(collectionId).catch(() => [])
          if (!cancelled) setVersions(updated)
        }

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

  async function handleScrapeAll() {
    setScrapeAllRunning(true)
    setScrapeAllProgress('Starting...')
    setScrapeAllResult(null)
    try {
      const { jobId, total } = await scrapeAllCollectionGames(collectionId)
      if (!jobId) {
        setScrapeAllResult({ total: 0, scraped: 0 })
        setScrapeAllRunning(false)
        return
      }
      setScrapeAllJobId(jobId)
      subscribeJobSSE(jobId, {
        onProgress: (msg) => setScrapeAllProgress(msg.msg || `Progress: ${msg.pct}%`),
        onResult: (data) => {
          setScrapeAllResult(data)
          setScrapeAllRunning(false)
          setInfo(`Scrape complete: ✓ ${data.scraped} · ⏭ ${data.skipped} · ✗ ${data.failed}`)
        },
        onError: (err) => {
          setScrapeAllRunning(false)
          setError(err)
        },
      })
    } catch (e) {
      setScrapeAllRunning(false)
      setError(e.message)
    }
  }

  async function handleCancelScrapeAll() {
    if (scrapeAllJobId) {
      try {
        await cancelJob(scrapeAllJobId)
      } catch {}
    }
    setScrapeAllRunning(false)
    setScrapeAllProgress('')
    setScrapeAllResult(null)
    setScrapeAllJobId(null)
  }

  if (importing) {
    return <div className="loading-screen">
      <div className="loading-spinner" />
      <p style={{marginTop:12,opacity:0.7}}>Importing dataset... this may take a moment</p>
    </div>
  }

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
          {gameCount > 0 && <button className="back-btn" onClick={onBack} title="Back"><span className="icon">arrow_back</span></button>}
          <span className="browser-title-icon"><IconDisplay name={collection?.logo} fallback="folder" /></span>
          <h1 className="browser-title">{collection?.name || 'Collection'}</h1>
          <span className="browser-count">{gameCount} games</span>
          {collection?.platform && <span className="platform-badge">{collection.platform}</span>}
          {latestImported && <span className="platform-badge" style={{background:'var(--accent-dim)',color:'var(--accent)'}}>Latest: {latestImported.version}</span>}
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

        <section className="detail-section">
          <h2 className="detail-section-title">Metadata Scraping</h2>
          <p className="detail-section-desc">
            Scrape game metadata (year, manufacturer, synopsis, covers, screenshots) from online providers.
            Only unscraped games will be processed.
          </p>

          <div className="info-box" style={{marginTop:12}}>
            {!scrapeAllRunning && !scrapeAllResult && (
              <button className="btn btn-sm" onClick={handleScrapeAll}>
                <span className="icon">auto_awesome</span> Scrape All Unscraped
              </button>
            )}
            {scrapeAllRunning && (
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <div className="loading-inline">
                  <div className="loading-spinner-sm" /> {scrapeAllProgress}
                </div>
                <button className="btn btn-sm btn-danger" onClick={handleCancelScrapeAll} title="Cancel">
                  <span className="icon icon-sm">close</span>
                </button>
              </div>
            )}
            {scrapeAllResult && (
              <div>
                {scrapeAllResult.total === 0
                  ? <span className="text-muted">All games already have metadata</span>
                  : <span>✓ {scrapeAllResult.scraped} scraped · ⏭ {scrapeAllResult.skipped} skipped · ✗ {scrapeAllResult.failed} failed</span>
                }
                <button className="btn btn-sm btn-secondary" style={{marginLeft:12}} onClick={() => setScrapeAllResult(null)}>OK</button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
