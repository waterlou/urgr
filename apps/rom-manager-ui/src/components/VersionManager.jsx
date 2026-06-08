import { useState, useEffect } from 'react'
import { getAvailableVersions, getCollectionVersions, addCollectionVersion, importOnlineVersion, importNps } from '../api.js'

const MAME_MILESTONES = new Set(['0.37b5', '0.78', '0.106', '0.139', '0.160'])

function getAge(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T'))
  const now = new Date()
  const days = Math.floor((now - d) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function getDatSource(folder) {
  if (folder === 'fbneo') return 'FBNeo'
  if (folder === 'fba' || folder === 'fbalpha') return 'FBAlpha44'
  if (folder?.startsWith('offlinelist') || folder === 'offline-list') return 'OFFLINELIST'
  if (folder?.startsWith('datomatic') || folder === 'dat-o-matic') return 'DATOMATIC'
  if (folder?.startsWith('nps')) return 'NPS'
  return 'MAME'
}

export default function VersionManager({ collectionId, collection, versions = [], onVersionsChange, onRefresh }) {
  const [availableDats, setAvailableDats] = useState(null)
  const [importingVer, setImportingVer] = useState(null)
  const [showAllMame, setShowAllMame] = useState(false)

  useEffect(() => {
    const source = getDatSource(collection?.folder)
    const datsPromise = getAvailableVersions(source).catch(() => null)
    const datsTimeout = new Promise(resolve => setTimeout(() => resolve(null), 12000))
    Promise.race([datsPromise, datsTimeout]).then(setAvailableDats)
  }, [collectionId, collection?.folder])

  async function handleImportOnline(version, source, refresh) {
    setImportingVer(version)
    try {
      const datSource = getDatSource(collection?.folder)
      await importOnlineVersion(collectionId, version, source || datSource, refresh)
      const [dats, vers] = await Promise.all([
        getAvailableVersions(datSource).catch(() => null),
        getCollectionVersions(collectionId).catch(() => []),
      ])
      setAvailableDats(dats)
      onVersionsChange(vers)
      onRefresh()
    } catch (e) {
      // parent can handle via a shared error mechanism if needed
      console.error('Import failed:', e.message)
    } finally {
      setImportingVer(null)
    }
  }

  async function handleLinkVersion(versionId) {
    try {
      await addCollectionVersion(collectionId, versionId)
      onRefresh()
    } catch (e) {
      console.error('Link failed:', e.message)
    }
  }

  const isMameOrFbneo = collection?.folder === 'mame' || collection?.folder === 'fbneo'
  const isOfflineList = collection?.folder?.startsWith('offlinelist') || collection?.folder === 'offline-list'
  const isDatomic = collection?.folder?.startsWith('datomatic') || collection?.folder === 'dat-o-matic'
  const isNps = collection?.folder?.startsWith('nps') || collection?.dataset_preset === 'NPS'

  async function handleNpsImport(platform) {
    setImportingVer(platform)
    try {
      await importNps(collectionId, platform)
      const vers = await getCollectionVersions(collectionId).catch(() => [])
      onVersionsChange(vers)
      onRefresh()
    } catch (e) {
      console.error('NPS import failed:', e.message)
    } finally {
      setImportingVer(null)
    }
  }

  return (
    <>
      {/* MAME / FBNeo DAT Versions */}
      {availableDats && isMameOrFbneo && (
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
                {(() => {
                  let items = availableDats.missing;
                  if (availableDats.source === 'MAME' && !showAllMame) {
                    const latest = availableDats.latest;
                    const milestones = items.filter(d => MAME_MILESTONES.has(d.version));
                    const latestItem = latest ? items.find(d => d.version === latest) : null;
                    const seen = new Set();
                    [...milestones, ...(latestItem ? [latestItem] : [])].forEach(d => { if (d) seen.add(d.numeric || d.version); });
                    items = items.filter(d => seen.has(d.numeric || d.version));
                  }
                  return items;
                })().map(d => {
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
              {availableDats.source === 'MAME' && (
                <button className="btn btn-sm btn-secondary" style={{marginTop:8}} onClick={() => setShowAllMame(v => !v)}>
                  {showAllMame ? 'Show highlights only' : `Show all (${availableDats.missing.length} versions)`}
                </button>
              )}
            </div>
          )}

          {/* Already-imported versions with refresh for nightly */}
          {versions.length > 0 && (
            <div className="info-box" style={{marginTop:12}}>
              <strong>Imported versions:</strong>
              <div className="tag-list" style={{marginTop:8}}>
                {versions.map(v => {
                  const isNightly = v.version === 'nightly';
                  const age = v.created_at ? getAge(v.created_at) : null;
                  return (
                    <span key={v.id} className="tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span className="icon icon-sm" style={{fontSize:14}}>check</span>
                      {v.source ? `${v.source} — ${v.version}` : v.version}
                      {age && <span className="tag-date">{age}</span>}
                      {isNightly && (
                        <button
                          className="btn btn-sm btn-secondary"
                          style={{padding:'1px 6px',fontSize:11,marginLeft:4}}
                          onClick={() => handleImportOnline(v.version, 'FBNeo', true)}
                          disabled={importingVer !== null}
                        >
                          {importingVer === v.version ? '...' : 'Refresh'}
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

      {/* OfflineList DAT */}
      {availableDats && isOfflineList && (
        <section className="detail-section">
          <h2 className="detail-section-title">
            OfflineList DAT
            {availableDats.hasNewer && <span className="badge badge-warn" style={{marginLeft:8,fontSize:11}}>Update available</span>}
          </h2>
          {versions.length > 0 ? (
            <div className="info-box" style={{marginTop:12}}>
              <strong>Imported DAT:</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Re-importing...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {versions.map(v => {
                  const age = v.created_at ? getAge(v.created_at) : null
                  return (
                    <span key={v.id} className="tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span className="icon icon-sm" style={{fontSize:14}}>check</span>
                      {v.version}
                      {age && <span className="tag-date">{age}</span>}
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{padding:'1px 6px',fontSize:11,marginLeft:4}}
                        onClick={() => handleImportOnline(v.version, 'OFFLINELIST', true)}
                        disabled={importingVer !== null}
                      >
                        {importingVer === v.version ? '...' : 'Re-import'}
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          ) : availableDats.missing?.length > 0 && (
            <div className="info-box warn" style={{marginTop:12}}>
              <strong>DAT not imported yet.</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Importing {importingVer}...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {availableDats.missing.map(d => (
                  <button
                    key={d.version}
                    className="tag tag-import"
                    onClick={() => handleImportOnline(d.version, 'OFFLINELIST')}
                    disabled={importingVer !== null}
                  >
                    <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:2}}>{importingVer === d.version ? 'hourglass' : 'add'}</span>
                    {d.version}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* DAT-O-MATIC DAT */}
      {availableDats && isDatomic && (
        <section className="detail-section">
          <h2 className="detail-section-title">
            DAT-O-MATIC DAT
            {availableDats.hasNewer && <span className="badge badge-warn" style={{marginLeft:8,fontSize:11}}>Update available</span>}
          </h2>
          {versions.length > 0 ? (
            <div className="info-box" style={{marginTop:12}}>
              <strong>Imported system:</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Re-importing...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {versions.map(v => {
                  const age = v.created_at ? getAge(v.created_at) : null
                  return (
                    <span key={v.id} className="tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span className="icon icon-sm" style={{fontSize:14}}>check</span>
                      {v.version}
                      {age && <span className="tag-date">{age}</span>}
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{padding:'1px 6px',fontSize:11,marginLeft:4}}
                        onClick={() => handleImportOnline(v.version, 'DATOMATIC', true)}
                        disabled={importingVer !== null}
                      >
                        {importingVer === v.version ? '...' : 'Re-import'}
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          ) : availableDats.missing?.length > 0 && (
            <div className="info-box warn" style={{marginTop:12}}>
              <strong>System not imported yet.</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Importing {importingVer}...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {availableDats.missing.map(d => (
                  <button
                    key={d.version}
                    className="tag tag-import"
                    onClick={() => handleImportOnline(d.version, 'DATOMATIC')}
                    disabled={importingVer !== null}
                  >
                    <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:2}}>{importingVer === d.version ? 'hourglass' : 'add'}</span>
                    {d.version}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* NPS (NoPayStation) */}
      {isNps && (
        <section className="detail-section">
          <h2 className="detail-section-title">
            NoPayStation
          </h2>
          {versions.length > 0 ? (
            <div className="info-box" style={{marginTop:12}}>
              <strong>Imported platform:</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Re-importing...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {versions.map(v => {
                  const age = v.created_at ? getAge(v.created_at) : null
                  return (
                    <span key={v.id} className="tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span className="icon icon-sm" style={{fontSize:14}}>check</span>
                      {v.version}
                      {age && <span className="tag-date">{age}</span>}
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{padding:'1px 6px',fontSize:11,marginLeft:4}}
                        onClick={() => handleNpsImport(v.version)}
                        disabled={importingVer !== null}
                      >
                        {importingVer === v.version ? '...' : 'Re-import'}
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          ) : availableDats?.missing?.length > 0 && (
            <div className="info-box warn" style={{marginTop:12}}>
              <strong>Platform not imported yet.</strong>
              {importingVer && <div className="loading-inline" style={{marginLeft:8}}><div className="loading-spinner-sm" /> Importing {importingVer}...</div>}
              <div className="tag-list" style={{marginTop:8}}>
                {availableDats.missing.map(p => (
                  <button
                    key={p.version}
                    className="tag tag-import"
                    onClick={() => handleNpsImport(p.version)}
                    disabled={importingVer !== null}
                  >
                    <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:2}}>{importingVer === p.version ? 'hourglass' : 'add'}</span>
                    {p.name || p.version}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Preset dataset info for non-MAME/non-FBNeo presets */}
      {collection?.has_dataset === 1 && !isMameOrFbneo && !isOfflineList && !isDatomic && !isNps && (
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
    </>
  )
}
