import { useState, useEffect } from 'react'
import { getDownloadQueue, subscribeDownloadSSE, retryDownload, clearDownload, clearCompletedDownloads } from '../api.js'

export default function DownloadManager({ onBack }) {
  const [queue, setQueue] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDownloadQueue().then(data => {
      setQueue(data.queue || [])
      setLoading(false)
    }).catch(() => setLoading(false))
    const sse = subscribeDownloadSSE({
      onQueue: q => setQueue(q || []),
    })
    return () => sse.close()
  }, [])

  const pending = queue.filter(i => i.status === 'pending').length
  const downloading = queue.filter(i => i.status === 'downloading').length
  const failed = queue.filter(i => i.status === 'failed').length
  const completed = queue.filter(i => i.status === 'completed').length

  function formatSize(bytes) {
    if (!bytes) return '-'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function statusBadge(item) {
    if (item.status === 'pending') return <span className="badge" style={{background:'#666'}}>Pending</span>
    if (item.status === 'downloading') return <span className="badge" style={{background:'#2196F3'}}>Downloading {item.progress}%</span>
    if (item.status === 'completed') return <span className="badge" style={{background:'var(--accent)', color:'#fff'}}>Completed</span>
    if (item.status === 'failed') return <span className="badge" style={{background:'#f44336'}} title={item.error}>Failed</span>
    return <span className="badge">{item.status}</span>
  }

  return (
    <div className="detail-page">
      <div className="detail-nav">
        <button className="back-btn" onClick={onBack}>
          <span className="icon">arrow_back</span>
        </button>
        <span className="detail-nav-title">Downloads</span>
      </div>
      <div className="detail-page-body">
        <div style={{display:'flex', gap:16, marginBottom:16, flexWrap:'wrap'}}>
          <div className="stat-card"><strong>Pending</strong><br/>{pending}</div>
          <div className="stat-card"><strong>Downloading</strong><br/>{downloading}</div>
          <div className="stat-card"><strong>Completed</strong><br/>{completed}</div>
          <div className="stat-card"><strong>Failed</strong><br/>{failed}</div>
        </div>

        {completed + failed > 0 && (
          <button className="btn btn-sm" onClick={clearCompletedDownloads} style={{marginBottom:12}}>
            <span className="icon">clear_all</span> Clear Completed/Failed
          </button>
        )}

        {loading ? (
          <p><em>Loading...</em></p>
        ) : queue.length === 0 ? (
          <p className="modal-description">No downloads in queue. Open an NPS game and click Download to add files.</p>
        ) : (
          <div className="rom-table-wrapper">
            <table className="rom-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map(item => (
                  <tr key={item.id}>
                    <td className="rom-filename" style={{maxWidth:300, overflow:'hidden', textOverflow:'ellipsis'}}>{item.filename}</td>
                    <td><span className="badge">{item.subtype}</span></td>
                    <td>{formatSize(item.file_size)}</td>
                    <td>
                      {statusBadge(item)}
                      {item.status === 'downloading' && (
                        <div style={{width:100, height:6, background:'#333', borderRadius:3, marginTop:4, overflow:'hidden'}}>
                          <div style={{width:`${item.progress}%`, height:'100%', background:'#2196F3', transition:'width 0.3s'}} />
                        </div>
                      )}
                      {item.status === 'failed' && item.error && (
                        <div style={{fontSize:11, color:'#f44336', marginTop:2, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis'}}>{item.error}</div>
                      )}
                    </td>
                    <td>
                      {item.status === 'failed' && (
                        <button className="btn btn-xs" onClick={() => retryDownload(item.id)} style={{marginRight:4}}>
                          <span className="icon icon-xs">refresh</span>
                        </button>
                      )}
                      {(item.status === 'completed' || item.status === 'failed') && (
                        <button className="btn btn-xs" onClick={() => clearDownload(item.id)}>
                          <span className="icon icon-xs">close</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
