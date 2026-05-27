import { useState, useEffect, useRef } from 'react'
import IconDisplay from './IconDisplay.jsx'
import {
  getAvailableVersions, getCollectionBuilds, startCollectionBuild, updateCollectionBuild,
  exportCollection, getCollectionVersions, addCollectionVersion, getCollectionGames,
  importOnlineVersion, scanCollection, verifyCollection, subscribeJobSSE,
  runCollectionBuild, cancelJob, downloadFromIA, iaListFiles, iaDownloadEntry,
  collectionBuild,
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
  const [scanVersion, setScanVersion] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [verifyDir, setVerifyDir] = useState('')
  const [verifyVersion, setVerifyVersion] = useState('')
  const [verifyFallback, setVerifyFallback] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)
  const [buildProgress, setBuildProgress] = useState({})
  const [buildVersion, setBuildVersion] = useState('')
  const [buildFormat, setBuildFormat] = useState('split')
  const [buildImportDir, setBuildImportDir] = useState(() => localStorage.getItem('rom-manager-import-dir') || '')
  const [buildRunning, setBuildRunning] = useState(false)
  const [buildProgressMsg, setBuildProgressMsg] = useState('')
  const [buildResult, setBuildResult] = useState(null)
  const [iaDownloading, setIaDownloading] = useState(false)
  const [iaProgress, setIaProgress] = useState(null)
  const [iaError, setIaError] = useState(null)
  const [iaSearchQuery, setIaSearchQuery] = useState('')
  const [iaSearching, setIaSearching] = useState(false)
  const [iaSearchResults, setIaSearchResults] = useState(null)
  const [iaDownloadingRom, setIaDownloadingRom] = useState(null)
  const [iaDownloadError, setIaDownloadError] = useState(null)
  const [iaDownloadSuccess, setIaDownloadSuccess] = useState(null)
  const eventSourcesRef = useRef({})

  async function handleIaDownload() {
    const item = collection?.dataset_preset === 'Final Burn Neo' ? 'fbneo' : 'fbneo'
    setIaDownloading(true)
    setIaProgress(null)
    setIaError(null)
    try {
      const { jobId } = await downloadFromIA(collectionId, item, 'FBNeo/roms.zip', '/tmp/ia_downloads')
      subscribeJobSSE(jobId, {
        onProgress: (msg) => setIaProgress(msg),
        onResult: (data) => {
          setIaDownloading(false)
          setInfo(`Downloaded to ${data.dest_dir}`)
        },
        onError: (err) => {
          setIaDownloading(false)
          setIaError(err)
        },
      })
    } catch (e) {
      setIaDownloading(false)
      setIaError(e.message)
    }
  }

  const IA_ZIP_URL = 'https://archive.org/download/fbneo/FBNeo/roms.zip'

  async function handleIaSearch() {
    if (!iaSearchQuery.trim()) return
    setIaSearching(true)
    setIaSearchResults(null)
    setIaDownloadError(null)
    try {
      const data = await iaListFiles(IA_ZIP_URL, iaSearchQuery.trim())
      setIaSearchResults(data.files || [])
    } catch (e) {
      setIaDownloadError(e.message)
    } finally {
      setIaSearching(false)
    }
  }

  async function handleIaDownloadRom(entry) {
    setIaDownloadingRom(entry)
    setIaDownloadError(null)
    setIaDownloadSuccess(null)
    try {
      const result = await iaDownloadEntry(IA_ZIP_URL, entry, collectionId)
      if (result.ok) setIaDownloadSuccess({ name: entry.replace(/^roms\//, ''), path: result.path, size: result.size })
      else setIaDownloadError('Download failed')
    } catch (e) {
      setIaDownloadError(e.message)
    } finally {
      setIaDownloadingRom(null)
    }
  }

  function getDatSource() {
    // Map collection folder to DAT source identifier
    if (collection?.folder === 'fbneo') return 'FBNeo';
    if (collection?.folder === 'fba' || collection?.folder === 'fbalpha') return 'FBAlpha44';
    return 'MAME'; // default, covers 'mame' and everything else
  }

  useEffect(() => {
    async function load() {
      try {
        const source = getDatSource();
        const datsPromise = getAvailableVersions(source).catch(() => null);
        const datsTimeout = new Promise(resolve => setTimeout(() => resolve(null), 12000));
        const dats = await Promise.race([datsPromise, datsTimeout]);
    const [buildsData, vers] = await Promise.all([
      getCollectionBuilds(collectionId).catch(() => []),
      getCollectionVersions(collectionId).catch(() => []),
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

  async function handleBuildStart() {
    if (!buildVersion || !buildImportDir) return
    setBuildRunning(true)
    setBuildProgressMsg('Starting build...')
    setBuildResult(null)
    setError(null)
    try {
      const { jobId } = await collectionBuild(collectionId, parseInt(buildVersion), buildImportDir)
      subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgressMsg(msg.msg || `Progress: ${msg.pct}%`),
        onResult: (data) => {
          setBuildResult(data)
          setBuildRunning(false)
          setInfo(`Build complete: ${data.added} added, ${data.exists} existed, ${data.reused} reused, ${data.missing} missing`)
        },
        onError: (err) => {
          setBuildRunning(false)
          setError(err)
        },
      })
    } catch (e) {
      setBuildRunning(false)
      setError(e.message)
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

  async function handleImportOnline(version, source, refresh) {
    setImportingVer(version)
    setError(null)
    setInfo(null)
    try {
      const result = await importOnlineVersion(collectionId, version, source || getDatSource(), refresh)
      setInfo(`Version ${version} imported! (${result.total_games} games)`)
      const [dats, vers] = await Promise.all([
        getAvailableVersions(getDatSource()).catch(() => null),
        getCollectionVersions(collectionId).catch(() => []),
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
        {/* Version Check — MAME / FBNeo / FBAlpha preset collections */}
        {availableDats && (collection?.folder === 'mame' || collection?.folder === 'fbneo') && (
          <section className="detail-section">
            <h2 className="detail-section-title">
              {collection?.folder === 'mame' ? 'MAME' : 'Final Burn Neo / FB Alpha'} DAT Versions
              {availableDats.hasNewer && <span className="badge badge-warn" style={{marginLeft:8,fontSize:11}}>Update available! {availableDats.latest}</span>}
            </h2>
            <p className="detail-section-desc">
              {collection?.folder === 'mame' ? 'Latest MAME: ' : 'Latest: '}
              <strong>{availableDats.latest}</strong>
              {availableDats.imported?.length > 0 && ` · ${availableDats.imported.length} version(s) imported`}
              {availableDats.missing?.length > 0 && ` · ${availableDats.missing.length} version(s) not yet imported`}
            </p>

            {availableDats.source === 'FBNeo' && (
              <div className="info-box">
                <strong>Nightly</strong> is the latest FBNeo HEAD &mdash; refreshed when FBNeo is updated.
                Tagged versions are stable releases. <strong>FB Alpha 0.2.97.x</strong> versions are hardcoded for older retro consoles.
              </div>
            )}

            {availableDats.missing?.length > 0 && (
              <div className="info-box warn">
                <strong>Versions available to import:</strong>
                {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Importing {importingVer}...</div>}
                <div className="tag-list">
                  {availableDats.missing.map(d => {
                    const verKey = d.numeric || d.version;
                    const label = d.nightly ? 'nightly (HEAD)' : d.source === 'FBAlpha43' || d.source === 'FBAlpha44' ? `${d.version} (FB Alpha)` : d.numeric && d.version !== d.numeric ? `${d.numeric} (${d.version})` : (d.numeric || d.version);
                    return (
                      <button
                        key={verKey}
                        className="tag tag-import"
                        onClick={() => handleImportOnline(verKey, d.source || availableDats.source)}
                        disabled={importingVer !== null}
                        title={d.source || availableDats.source}
                      >
                        <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:2}}>{importingVer === verKey ? 'hourglass' : 'add'}</span>
                        {label}
                        {d.date && <span className="tag-date">{d.date}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Already-imported versions with refresh for nightly */}
            {availableDats.imported?.length > 0 && (
              <div className="info-box" style={{marginTop:12}}>
                <strong>Imported versions:</strong>
                <div className="tag-list" style={{marginTop:8}}>
                  {availableDats.imported.map(iv => {
                    const isNightly = iv.version === 'nightly';
                    return (
                      <span key={iv.id} className="tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
                        <span className="icon icon-sm" style={{fontSize:14}}>check</span>
                        {iv.source ? `${iv.source} — ${iv.version}` : iv.version}
                        {isNightly && (
                          <button
                            className="btn btn-sm btn-secondary"
                            style={{padding:'1px 6px',fontSize:11,marginLeft:4}}
                            onClick={() => handleImportOnline(iv.version, 'FBNeo', true)}
                            disabled={importingVer !== null}
                          >
                            Refresh
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Preset dataset info for non-MAME/non-FBNeo presets */}
        {collection?.has_dataset === 1 && collection?.folder !== 'mame' && collection?.folder !== 'fbneo' && (
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
                <select className="build-select" value={scanVersion} onChange={e => setScanVersion(e.target.value)}>
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
                <button className="btn btn-primary" onClick={() => scanVersion && scanDir && handleScan(parseInt(scanVersion))} disabled={!scanVersion || !scanDir || scanning}>
                  <span className="icon">search</span> Scan
                </button>
                {scanning && <div className="loading-inline"><div className="loading-spinner-sm" /> Scanning...</div>}
              </div>
              {scanResult && (
                <div className="info-box" style={{marginTop:8}}>
                  Total: {scanResult.total_files} files · Matched: {scanResult.matched_games} · Missing: {scanResult.missing_games}
                </div>
              )}
            </div>

            <div className="build-form" style={{marginTop:12}}>
              <h3>Verify</h3>
              <div className="build-form-row">
                <select className="build-select" value={verifyVersion} onChange={e => setVerifyVersion(e.target.value)}>
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
                <button className="btn btn-primary" onClick={() => verifyVersion && verifyDir && handleVerify(parseInt(verifyVersion))} disabled={!verifyVersion || !verifyDir || verifying}>
                  <span className="icon">check_circle</span> Verify
                </button>
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

        {/* Internet Archive — Single ROM Download */}
        <section className="detail-section">
          <h2 className="detail-section-title">Download ROM from Internet Archive</h2>
          <p className="detail-section-desc">Download individual ROM files from archive.org by game name.</p>
          <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
            <input
              type="text"
              className="build-select"
              placeholder="Game name (e.g. 1941)"
              value={iaSearchQuery}
              onChange={e => setIaSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleIaSearch()}
              style={{flex:1, minWidth:200}}
            />
            <button className="btn btn-primary" onClick={handleIaSearch} disabled={iaSearching || !iaSearchQuery}>
              <span className="icon">search</span> Search
            </button>
          </div>
          {iaSearching && <div className="loading-inline" style={{marginTop:8}}><div className="loading-spinner-sm" /> Searching...</div>}
          {iaSearchResults && iaSearchResults.length > 0 && (
            <div className="ia-results" style={{marginTop:12}}>
              {iaSearchResults.map(f => (
                <div key={f.name} className="ia-result-item">
                  <span className="ia-result-name">{f.name.replace('roms/', '')}</span>
                  <span className="ia-result-size">{(f.size / 1024).toFixed(0)} KB</span>
                  <button className="btn btn-sm btn-primary" onClick={() => handleIaDownloadRom(f.name)} disabled={iaDownloadingRom === f.name}>
                    {iaDownloadingRom === f.name ? <span className="loading-spinner-sm" /> : <span className="icon">download</span>}
                  </button>
                </div>
              ))}
            </div>
          )}
          {iaSearchResults && iaSearchResults.length === 0 && !iaSearching && (
            <p className="error-text" style={{marginTop:8}}>No matches found.</p>
          )}
          {iaDownloadError && <p className="error-text" style={{marginTop:8}}>{iaDownloadError}</p>}
          {iaDownloadSuccess && <div className="info-box" style={{marginTop:8}}>Downloaded: <strong>{iaDownloadSuccess.name}</strong> → <code>{iaDownloadSuccess.path}</code> ({(iaDownloadSuccess.size / 1024).toFixed(0)} KB)</div>}
        </section>

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
            <p className="detail-section-desc" style={{marginBottom:12}}>
              Builds ROMs from your import folder into <code>data/roms/{collection?.folder || collection?.slug}/&lt;version&gt;/roms/</code>.
              Previously built versions are checked for matching checksums to avoid duplicates.
            </p>
            <div className="build-form-row">
              <input type="text" className="build-select" placeholder="Import directory (e.g. /path/to/roms)" value={buildImportDir} onChange={e => { setBuildImportDir(e.target.value); localStorage.setItem('rom-manager-import-dir', e.target.value); }} style={{flex:1}} />
              <select className="build-select" value={buildVersion} onChange={e => setBuildVersion(e.target.value)}>
                <option value="">Select version...</option>
                {versions.map(v => (
                  <option key={v.id} value={v.id}>{v.source} — {v.version} ({v.total_games} games)</option>
                ))}
              </select>
              <button className="btn btn-primary" onClick={handleBuildStart} disabled={!buildVersion || !buildImportDir || buildRunning}>
                <span className="icon">build</span> Build
              </button>
            </div>
            {buildRunning && (
              <div className="info-box" style={{marginTop:12}}>
                <div className="loading-inline"><div className="loading-spinner-sm" /> {buildProgressMsg}</div>
              </div>
            )}
            {buildResult && (
              <div className="info-box" style={{marginTop:12}}>
                <strong>Build complete</strong> ({buildResult.elapsed}s)<br />
                ✓ {buildResult.added} added · {buildResult.exists} existed · ♻ {buildResult.reused} reused · ✗ {buildResult.missing} missing · 🗑 {buildResult.cleaned} cleaned
                {buildResult.missing > 0 && buildResult.missing_games?.length > 0 && (
                  <details style={{marginTop:8,fontSize:13}}>
                    <summary>Missing games ({buildResult.missing})</summary>
                    <div style={{maxHeight:200,overflow:'auto',marginTop:4}}>
                      {buildResult.missing_games.map(g => <div key={g}>{g}</div>)}
                    </div>
                  </details>
                )}
              </div>
            )}
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
