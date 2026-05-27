import { useState } from 'react'
import { iaListFiles, iaDownloadEntry } from '../api.js'

const IA_ZIP_URL = 'https://archive.org/download/fbneo/FBNeo/roms.zip'

export default function IaDownload({ collectionId }) {
  const [iaSearchQuery, setIaSearchQuery] = useState('')
  const [iaSearching, setIaSearching] = useState(false)
  const [iaSearchResults, setIaSearchResults] = useState(null)
  const [iaDownloadingRom, setIaDownloadingRom] = useState(null)
  const [iaDownloadError, setIaDownloadError] = useState(null)
  const [iaDownloadSuccess, setIaDownloadSuccess] = useState(null)

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

  return (
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
  )
}
