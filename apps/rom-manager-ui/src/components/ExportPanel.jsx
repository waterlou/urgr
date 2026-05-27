import { useState } from 'react'
import { exportCollection } from '../api.js'

export default function ExportPanel({ collectionId }) {
  const [exportFormat, setExportFormat] = useState('split')
  const [exportData, setExportData] = useState(null)
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      const data = await exportCollection(collectionId, { format: exportFormat })
      setExportData(data)
    } catch (e) {
      console.error('Export failed:', e.message)
    } finally {
      setExporting(false)
    }
  }

  return (
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
  )
}
