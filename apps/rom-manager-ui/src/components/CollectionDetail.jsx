import { useState, useEffect, useRef } from 'react'
import IconDisplay from './IconDisplay.jsx'
import {
  getAvailableVersions, getCollectionBuilds, startCollectionBuild, updateCollectionBuild,
  exportCollection, getVersions, addCollectionVersion, getCollectionGames,
  importOnlineVersion, scanCollection, verifyCollection, subscribeJobSSE,
  runCollectionBuild, cancelJob,
} from '../api.js'

function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    subscribeJobSSE(jobId, {
      onResult: (data) => resolve(data),
      onError: (err) => reject(new Error(err)),
      onProgress: () => {},
    })
  })
}

export default function CollectionDetail({ collectionId, collection, onBrowseGames, onRefresh }) {
  const [availableDats, setAvailableDats] = useState(null)
  const [builds, setBuilds] = useState([])
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [buildInProgress, setBuildInProgress] = useState(null)
  const [exportFormat, setExportFormat] = useState('split')
  const [exportData, setExportData] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [importingVer, setImportingVer] = useState(null)
  const [gameCount, setGameCount] = useState(0)
  const [scanDir, setScanDir] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [verifyDir, setVerifyDir] = useState('')
  const [verifyFallback, setVerifyFallback] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)
  const [buildProgress, setBuildProgress] = useState({})
  const eventSourcesRef = useRef({})

  useEffect(() => {
    async function load() {
      try {
        const [dats, buildsData, vers] = await Promise.all([
          getAvailableVersions().catch(() => null),
          getCollectionBuilds(collectionId).catch(() => []),
          getVersions().catch(() => []),
        ])
        setAvailableDats(dats)
        setBuilds(buildsData)
        setVersions(vers)
        const games = await getCollectionGames(collectionId, { limit: 1 })
        setGameCount(games.total || 0)

        // Auto-reconnect to any builds that are still running
        const running = buildsData.filter(b => b.status === 'building')
        for (const b of running) {
          subscribeToRunningBuild(b.id)
        }
      } catch (e) {
        console.error('Failed to load collection detail:', e)
      } finally {
        setLoading(false)
      }
    }
    load()

    return () => {
      // Cleanup all SSE connections on unmount
      Object.values(eventSourcesRef.current).forEach(es => es.close())
      eventSourcesRef.current = {}
    }
  }, [collectionId])

  function subscribeToRunningBuild(buildId) {
    if (eventSourcesRef.current[buildId]) return
    const es = subscribeJobSSE(buildId, {
      onProgress: (msg) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: msg.pct, message: msg.msg } }))
        if (msg.phase === 'copying') {
          setBuilds(prev => prev.map(b => b.id === buildId ? { ...b, games_built: msg.matched, games_missing: msg.missing } : b))
        }
      },
      onResult: (result) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: 100, message: 'Build complete' } }))
        setBuilds(prev => prev.map(b => b.id === buildId ? { ...b, status: 'complete', games_built: result.matched, games_missing: result.missing } : b))
        setInfo(`Build complete: ${result.matched} matched, ${result.missing} missing`)
        delete eventSourcesRef.current[buildId]
        setBuildInProgress(null)
      },
      onError: (err) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: 0, message: `Failed: ${err}` } }))
        setBuilds(prev => prev.map(b => b.id === buildId ? { ...b, status: 'failed' } : b))
        setError(`Build failed: ${err}`)
        delete eventSourcesRef.current[buildId]
        setBuildInProgress(null)
      },
      onDone: () => {
        delete eventSourcesRef.current[buildId]
      },
    })
    eventSourcesRef.current[buildId] = es
  }

  async function handleBuild(versionId, format) {
    const version = versions.find(v => v.id === versionId)
    if (!version) return
    setBuildInProgress(versionId)
    setError(null)
    setInfo(null)
    try {
      const build = await startCollectionBuild(collectionId, versionId, format)
      setBuilds(prev => {
        const idx = prev.findIndex(b => b.version_id === versionId)
        if (idx >= 0) { const updated = [...prev]; updated[idx] = build; return updated }
        return [...prev, build]
      })
      const { jobId } = await runCollectionBuild(collectionId, build.id, {
        source: version.source,
        import_dir: `${version.dir || '/roms/' + version.source}/${version.source}`,
        base_dir: '/roms',
        update: false,
      })
      subscribeToRunningBuild(jobId)
    } catch (e) {
      setError(e.message)
      setBuildInProgress(null)
    }
  }

  async function handleCancelBuild(buildId) {
    try {
      await cancelJob(buildId)
      if (eventSourcesRef.current[buildId]) {
        eventSourcesRef.current[buildId].close()
        delete eventSourcesRef.current[buildId]
      }
      setBuildProgress(prev => ({ ...prev, [buildId]: { pct: 0, message: 'Cancelled' } }))
      setTimeout(() => {
        setBuildProgress(prev => {
          const next = { ...prev }
          delete next[buildId]; return next
        })
      }, 3000)
      setBuilds(prev => prev.map(b => b.id === buildId ? { ...b, status: 'failed' } : b))
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleComplete(buildId) {
    setError(null)
    setInfo(null)
    try {
      const result = await updateCollectionBuild(collectionId, buildId, { status: 'complete' })
      setBuilds(prev => prev.map(b => b.id === buildId ? result : b))
      setInfo('Build marked as complete!')
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleExport() {
    setExporting(true)
    setError(null)
    try {
      const data = await exportCollection(collectionId, { format: exportFormat })
      setExportData(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  async function handleImportOnline(version) {
    setImportingVer(version)
    setError(null)
    setInfo(null)
    try {
      const result = await importOnlineVersion(collectionId, version)
      setInfo(`Version ${version} imported!`)
      const [dats, vers] = await Promise.all([
        getAvailableVersions().catch(() => null),
        getVersions().catch(() => []),
      ])
      setAvailableDats(dats)
      setVersions(vers)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setImportingVer(null)
    }
  }

  async function handleLinkVersion(versionId) {
    try {
      await addCollectionVersion(collectionId, versionId)
      setInfo('Version linked to collection')
      onRefresh()
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleScan(versionId) {
    setScanning(true)
    setError(null)
    setInfo(null)
    setScanResult(null)
    try {
      const { jobId } = await scanCollection(collectionId, versionId, scanDir)
      const result = await waitForJob(jobId)
      setScanResult(result)
      setInfo(`Scan complete: ${result.matched_games} matched, ${result.missing_games} missing`)
    } catch (e) {
      setError(e.message)
    } finally {
      setScanning(false)
    }
  }

  async function handleVerify(versionId) {
    setVerifying(true)
    setError(null)
    setInfo(null)
    setVerifyResult(null)
    try {
      const opts = {}
      if (verifyFallback) opts.fallback_id = parseInt(verifyFallback)
      const { jobId } = await verifyCollection(collectionId, versionId, verifyDir, opts.fallback_id)
      const result = await waitForJob(jobId)
      setVerifyResult(result)
      setInfo(`Verify complete: ${result.present} present, ${result.missing} missing`)
    } catch (e) {
      setError(e.message)
    } finally {
      setVerifying(false)
    }
  }

  function getBuildForVersion(versionId) {
    return builds.find(b => b.version_id === versionId)
  }

  function statusBadge(status) {
    const cls = status === 'complete' ? 'badge-ok' : status === 'building' ? 'badge-warn' : status === 'failed' ? 'badge-err' : 'badge-muted'
    return <span className={`rom-status rom-status-${cls.replace('badge-', '')}`}>{status.replace('_', ' ')}</span>
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
        {/* Version Check — MAME preset collections */}
        {availableDats && collection?.folder === 'mame' && (
          <section className="detail-section">
            <h2 className="detail-section-title">
              MAME DAT Versions
              {availableDats.hasNewer && <span className="badge badge-warn" style={{marginLeft:8,fontSize:11}}>New version available! {availableDats.latest}</span>}
            </h2>
            <p className="detail-section-desc">
              Latest available: <strong>{availableDats.latest}</strong>
              {availableDats.imported.length > 0 && ` · ${availableDats.imported.length} version(s) imported`}
              {availableDats.missing.length > 0 && ` · ${availableDats.missing.length} version(s) not yet imported`}
            </p>

            {availableDats.missing.length > 0 && (
              <div className="info-box warn">
                <strong>Versions available to import:</strong>
                <div className="tag-list">
                  {availableDats.missing.slice(0, 10).map(d => (
                    <button
                      key={d.numeric}
                      className="tag tag-import"
                      onClick={() => handleImportOnline(d.numeric)}
                      disabled={importingVer === d.numeric}
                    >
                      <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:2}}>{importingVer === d.numeric ? 'hourglass' : 'add'}</span> {d.numeric} <span className="tag-date">{d.date}</span>
                    </button>
                  ))}
                  {availableDats.missing.length > 10 && <span className="tag">+{availableDats.missing.length - 10} more</span>}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Preset dataset info for non-MAME presets */}
        {collection?.has_dataset === 1 && collection?.folder !== 'mame' && (
          <section className="detail-section">
            <h2 className="detail-section-title">
              Dataset: {collection.folder}
            </h2>
            <p className="detail-section-desc">
              This collection uses a <strong>{collection.folder}</strong> dataset.
              Versions are managed during the build process. Upload a DAT file to get started.
            </p>
          </section>
        )}

        {/* Scan & Verify */}
        {versions.length > 0 && (
          <section className="detail-section">
            <h2 className="detail-section-title">Scan & Verify ROMs</h2>
            <p className="detail-section-desc">
              Scan a directory of ROM files against a DAT version, or verify a ROM set.
            </p>

            <div className="build-form">
              <h3>Scan</h3>
              <div className="build-form-row">
                <select className="build-select" defaultValue="" onChange={e => {
                  const v = e.target.value
                  if (v && scanDir) handleScan(parseInt(v))
                }}>
                  <option value="">Select version...</option>
                  {versions.map(v => (
                    <option key={v.id} value={v.id}>{v.source} — {v.version}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="build-select"
                  placeholder="/roms/mame"
                  value={scanDir}
                  onChange={e => setScanDir(e.target.value)}
                  style={{flex:1}}
                />
                {scanning && <div className="loading-inline"><div className="loading-spinner-sm" /> Scanning...</div>}
              </div>
              {scanResult && (
                <div className="info-box">
                  Total: {scanResult.total_files} files · Matched: {scanResult.matched_games} · Missing: {scanResult.missing_games}
                </div>
              )}
            </div>

            <div className="build-form" style={{marginTop:12}}>
              <h3>Verify</h3>
              <div className="build-form-row">
                <select className="build-select" defaultValue="" onChange={e => {
                  const v = e.target.value
                  if (v && verifyDir) handleVerify(parseInt(v))
                }}>
                  <option value="">Select version...</option>
                  {versions.map(v => (
                    <option key={v.id} value={v.id}>{v.source} — {v.version}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="build-select"
                  placeholder="/roms/mame"
                  value={verifyDir}
                  onChange={e => setVerifyDir(e.target.value)}
                  style={{flex:1}}
                />
                <input
                  type="text"
                  className="build-select"
                  placeholder="Fallback version ID (optional)"
                  value={verifyFallback}
                  onChange={e => setVerifyFallback(e.target.value)}
                  style={{width:180}}
                />
                {verifying && <div className="loading-inline"><div className="loading-spinner-sm" /> Verifying...</div>}
              </div>
              {verifyResult && (
                <div className="info-box">
                  Total: {verifyResult.total_games} · Present: {verifyResult.present} · Missing: {verifyResult.missing}
                  {verifyResult.mismatched > 0 && <span>· Mismatched: {verifyResult.mismatched}</span>}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Build Management */}
        <section className="detail-section">
          <h2 className="detail-section-title">Build Management</h2>
          <p className="detail-section-desc">
            Build ROM sets from imported versions. Only forward builds allowed (newer versions only).
          </p>

          {builds.length === 0 ? (
            <div className="info-box">
              No builds started yet. Link a version and start building below.
            </div>
          ) : (
            <div className="build-table-wrapper">
              <table className="build-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Format</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>Started</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {builds.map(build => (
                    <tr key={build.id}>
                      <td><strong>{build.version}</strong></td>
                      <td><span className="tag">{build.format}</span></td>
                      <td>{statusBadge(build.status)}</td>
                      <td>
                        {build.status === 'building' && buildProgress[build.id] ? (
                          <div className="progress-bar-wrapper" style={{minWidth:120}}>
                            <div className="progress-bar" style={{width:`${buildProgress[build.id].pct}%`}} />
                            <span className="progress-label">{buildProgress[build.id].pct}%</span>
                          </div>
                        ) : (
                          build.games_total > 0 ? `${build.games_built || 0} / ${build.games_total}` : '-'
                        )}
                      </td>
                      <td className="text-muted">{build.started_at ? build.started_at.slice(0, 10) : '-'}</td>
                      <td>
                        {build.status === 'building' && (
                          <div className="action-btn-group">
                            <button className="btn btn-sm btn-danger" onClick={() => handleCancelBuild(build.id)}>
                              Cancel
                            </button>
                          </div>
                        )}
                        {build.status === 'complete' && <span className="text-muted"><span className="icon icon-sm" style={{verticalAlign:'middle'}}>check</span> Built</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="build-form">
            <h3>Start New Build</h3>
            <div className="build-form-row">
              <select className="build-select" value="" onChange={e => {
                const val = e.target.value
                if (val) handleBuild(val, 'split')
                e.target.value = ''
              }}>
                <option value="">Select a version to build...</option>
                {versions.map(v => {
                  const existing = getBuildForVersion(v.id)
                  const disabled = existing && existing.status === 'complete'
                  return (
                    <option key={v.id} value={v.id} disabled={disabled}>
                      {v.source} — {v.version} ({v.total_games} games) {disabled ? <span className="icon icon-xs" style={{verticalAlign:'middle'}}>check</span> : existing ? `(${existing.status})` : ''}
                    </option>
                  )
                })}
              </select>
              <select className="build-select" value={exportFormat} onChange={e => setExportFormat(e.target.value)} style={{width:120}}>
                <option value="split">Split</option>
                <option value="merged">Merged</option>
                <option value="non-merged">Non-merged</option>
              </select>
            </div>
            {buildInProgress && <div className="loading-inline"><div className="loading-spinner-sm" /> Building...</div>}
          </div>
        </section>

        {/* Export */}
        <section className="detail-section">
          <h2 className="detail-section-title">Export</h2>
          <p className="detail-section-desc">
            Export the collection's ROM set. Select format and version, then download the manifest.
          </p>

          <div className="export-form">
            <div className="build-form-row">
              <select className="build-select" value={exportFormat} onChange={e => setExportFormat(e.target.value)}>
                <option value="split">Split (each game in own ZIP)</option>
                <option value="merged">Merged (clones merged into parent)</option>
                <option value="non-merged">Non-merged (all ROMs in game ZIP)</option>
              </select>
              <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Generating...' : 'Generate Export Manifest'}
              </button>
            </div>
          </div>

          {exportData && (
            <div className="export-result">
              <h3>Export: {exportData.collection} — {exportData.version} ({exportData.format})</h3>
              <p>{exportData.total_games} games, {exportData.total_roms} total ROM files</p>
              <pre className="export-json">{JSON.stringify(exportData, null, 2).slice(0, 2000)}{exportData.games.length > 5 ? '\n...' : ''}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
