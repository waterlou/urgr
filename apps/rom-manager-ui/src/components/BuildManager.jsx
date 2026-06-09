import { useState, useEffect, useRef } from 'react'
import { getCollectionBuilds, updateCollectionBuild, subscribeJobSSE, cancelJob, collectionBuild } from '../api.js'

function statusBadge(status) {
  const cls = status === 'complete' ? 'badge-ok' : status === 'building' ? 'badge-warn' : status === 'failed' ? 'badge-err' : 'badge-muted'
  return <span className={`rom-status rom-status-${cls.replace('badge-', '')}`}>{status.replace('_', ' ')}</span>
}

export default function BuildManager({ collectionId, collection, versions, onBuildsChange, onError, onInfo }) {
  const [builds, setBuilds] = useState([])
  const [buildProgress, setBuildProgress] = useState({})
  const [buildVersion, setBuildVersion] = useState(() => versions.length === 1 ? String(versions[0].id) : '')
  const [buildImportDir, setBuildImportDir] = useState(() => localStorage.getItem('rom-manager-import-dir') || '')
  const [buildRunning, setBuildRunning] = useState(false)
  const [buildScanRunning, setBuildScanRunning] = useState(false)
  const [buildScanResult, setBuildScanResult] = useState(null)
  const [buildProgressMsg, setBuildProgressMsg] = useState('')
  const [buildResult, setBuildResult] = useState(null)
  const eventSourcesRef = useRef({})

  function setBuildsWithSync(updater) {
    setBuilds(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      onBuildsChange(next)
      return next
    })
  }

  useEffect(() => {
    getCollectionBuilds(collectionId).catch(() => []).then(data => {
      setBuildsWithSync(data)
      const running = data.filter(b => b.status === 'building')
      for (const b of running) {
        subscribeToRunningBuild(b.id)
      }
    })

    return () => {
      Object.values(eventSourcesRef.current).forEach(es => es.close())
      eventSourcesRef.current = {}
    }
  }, [collectionId])

  // Auto-select version when only one exists
  useEffect(() => {
    if (versions.length === 1) setBuildVersion(String(versions[0].id))
  }, [versions])

  function subscribeToRunningBuild(buildId) {
    if (eventSourcesRef.current[buildId]) return
    const es = subscribeJobSSE(buildId, {
      onProgress: (msg) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: msg.pct, message: msg.msg } }))
        if (msg.phase === 'copying') {
          setBuildsWithSync(prev => prev.map(b => b.id === buildId ? { ...b, games_built: msg.matched, games_missing: msg.missing } : b))
        }
      },
      onResult: (result) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: 100, message: 'Build complete' } }))
        setBuildsWithSync(prev => prev.map(b => b.id === buildId ? { ...b, status: 'complete', games_built: result.matched, games_missing: result.missing } : b))
        onInfo(`Build complete: ${result.matched} matched, ${result.missing} missing`)
        delete eventSourcesRef.current[buildId]
      },
      onError: (err) => {
        setBuildProgress(prev => ({ ...prev, [buildId]: { pct: 0, message: `Failed: ${err}` } }))
        setBuildsWithSync(prev => prev.map(b => b.id === buildId ? { ...b, status: 'failed' } : b))
        onError(`Build failed: ${err}`)
        delete eventSourcesRef.current[buildId]
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
    try {
      const { jobId } = await collectionBuild(collectionId, parseInt(buildVersion), buildImportDir)
      subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgressMsg(msg.msg || `Progress: ${msg.pct}%`),
        onResult: (data) => {
          setBuildResult(data)
          setBuildRunning(false)
          onInfo(`Build complete: ${data.added} added, ${data.exists} existed, ${data.reused} reused, ${data.missing} missing`)
        },
        onError: (err) => {
          setBuildRunning(false)
          onError(err)
        },
      })
    } catch (e) {
      setBuildRunning(false)
      onError(e.message)
    }
  }

  async function handleScanStart() {
    if (!buildVersion || !buildImportDir) return
    setBuildScanRunning(true)
    setBuildProgressMsg('Starting scan...')
    setBuildScanResult(null)
    try {
      const { jobId } = await collectionBuild(collectionId, parseInt(buildVersion), buildImportDir, true)
      subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgressMsg(msg.msg || `Progress: ${msg.pct}%`),
        onResult: (data) => {
          setBuildScanResult(data)
          setBuildScanRunning(false)
          const sv = collection?.dataset_preset === 'MAME' || collection?.dataset_preset === 'Final Burn Neo'
          onInfo(`Scan complete: ${data.exists} exist${sv ? `, ${data.reused} reused` : ''}, ${data.missing} missing`)
        },
        onError: (err) => {
          setBuildScanRunning(false)
          onError(err)
        },
      })
    } catch (e) {
      setBuildScanRunning(false)
      onError(e.message)
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
      setBuildsWithSync(prev => prev.map(b => b.id === buildId ? { ...b, status: 'failed' } : b))
    } catch (e) {
      onError(e.message)
    }
  }

  async function handleComplete(buildId) {
    try {
      const result = await updateCollectionBuild(collectionId, buildId, { status: 'complete' })
      setBuildsWithSync(prev => prev.map(b => b.id === buildId ? result : b))
      onInfo('Build marked as complete!')
    } catch (e) {
      onError(e.message)
    }
  }

  return (
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
          {versions.length > 1 ? (
            <select className="build-select" value={buildVersion} onChange={e => setBuildVersion(e.target.value)}>
              <option value="">Select version...</option>
              {versions.map(v => (
                <option key={v.id} value={v.id}>{v.source} — {v.version} ({v.total_games} games)</option>
              ))}
            </select>
          ) : versions.length === 1 && buildVersion ? (
            <span className="badge" style={{padding:'8px 12px',fontSize:13,whiteSpace:'nowrap',background:'var(--bg-elevated)',border:'1px solid var(--border)',borderRadius:'var(--radius)'}}>
              {versions[0].source} — {versions[0].version} ({versions[0].total_games} games)
            </span>
          ) : null}
          <button className="btn btn-primary" onClick={handleBuildStart} disabled={!buildVersion || !buildImportDir || buildRunning || buildScanRunning}>
            <span className="icon">build</span> Build
          </button>
          <button className="btn btn-secondary" onClick={handleScanStart} disabled={!buildVersion || !buildImportDir || buildRunning || buildScanRunning}>
            <span className="icon">search</span> Scan
          </button>
        </div>
        {buildRunning && (
          <div className="info-box" style={{marginTop:12}}>
            <div className="loading-inline"><div className="loading-spinner-sm" /> {buildProgressMsg}</div>
          </div>
        )}
        {buildScanRunning && (
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
        {buildScanResult && (
          <div className="info-box" style={{marginTop:12}}>
            <strong>Scan result</strong><br />
            ✓ {buildScanResult.exists} exist
            {(() => {
              const sv = collection?.dataset_preset === 'MAME' || collection?.dataset_preset === 'Final Burn Neo'
              return sv ? ` · ♻ ${buildScanResult.reused} reused` : ''
            })()}
            · ✗ {buildScanResult.missing} missing
            {buildScanResult.missing > 0 && buildScanResult.missing_games?.length > 0 && (
              <details style={{marginTop:8,fontSize:13}}>
                <summary>Missing games ({buildScanResult.missing})</summary>
                <div style={{maxHeight:200,overflow:'auto',marginTop:4}}>
                  {buildScanResult.missing_games.map(g => <div key={g}>{g}</div>)}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
