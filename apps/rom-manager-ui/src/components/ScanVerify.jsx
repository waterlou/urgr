import { useState } from 'react'
import { scanCollection, verifyCollection } from '../api.js'
import waitForJob from '../utils/waitForJob.js'

export default function ScanVerify({ collectionId, versions }) {
  const [scanDir, setScanDir] = useState('')
  const [scanVersion, setScanVersion] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [verifyDir, setVerifyDir] = useState('')
  const [verifyVersion, setVerifyVersion] = useState('')
  const [verifyFallback, setVerifyFallback] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)

  async function handleScan(versionId) {
    setScanning(true)
    setScanResult(null)
    try {
      const { jobId } = await scanCollection(collectionId, versionId, scanDir)
      const result = await waitForJob(jobId)
      setScanResult(result)
    } catch (e) {
      console.error('Scan failed:', e.message)
    } finally {
      setScanning(false)
    }
  }

  async function handleVerify(versionId) {
    setVerifying(true)
    setVerifyResult(null)
    try {
      const fallbackId = verifyFallback ? parseInt(verifyFallback) : undefined
      const { jobId } = await verifyCollection(collectionId, versionId, verifyDir, fallbackId)
      const result = await waitForJob(jobId)
      setVerifyResult(result)
    } catch (e) {
      console.error('Verify failed:', e.message)
    } finally {
      setVerifying(false)
    }
  }

  if (versions.length === 0) return null

  return (
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
  )
}
