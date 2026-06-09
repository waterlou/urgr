import { useState, useEffect } from 'react';
import { useOperations } from '../hooks/useOperations.js';
import { cancelOperation, getOperations, getCollections } from '../api.js';

function getAge(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.replace(' ', 'T'));
  const now = new Date();
  const seconds = Math.floor((now - d) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const TYPE_ICONS = {
  build: 'build',
  scan: 'search',
  scrape: 'auto_awesome',
  import: 'download',
  export: 'upload',
  verify: 'check_circle',
};

const TYPE_LABELS = {
  build: 'Build',
  scan: 'Scan',
  scrape: 'Scrape',
  import: 'Import',
  export: 'Export',
  verify: 'Verify',
};

function statusBadge(status) {
  const cls = status === 'running' ? 'badge-warn' : status === 'done' ? 'badge-ok' : status === 'failed' ? 'badge-err' : 'badge-muted';
  return <span className={`rom-status rom-status-${cls.replace('badge-', '')}`}>{status}</span>;
}

export default function OperationsPage() {
  const operations = useOperations();
  const [collections, setCollections] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    getCollections().then(setCollections).catch(() => {});
  }, []);

  const colMap = Object.fromEntries(collections.map(c => [c.id, c.name]));
  const filtered = filter ? operations.filter(o => o.collection_id === parseInt(filter)) : operations;
  const running = operations.filter(o => o.status === 'running' || o.status === 'pending');
  const completed = operations.filter(o => o.status === 'done');
  const failed = operations.filter(o => o.status === 'failed' || o.status === 'cancelled');

  return (
    <div className="browser">
      <div className="browser-header">
        <div className="browser-title-row">
          <h1 className="browser-title">Operations</h1>
          <span className="browser-count">{running.length} running</span>
        </div>
      </div>

      <div className="browser-content">
        <div style={{display:'flex', gap:8, marginBottom:16, flexWrap:'wrap'}}>
          <select className="build-select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All collections</option>
            {collections.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {operations.length === 0 ? (
          <div className="info-box">No operations</div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {filtered.map(op => (
              <div key={op.id} className="info-box" style={{display:'flex', alignItems:'center', gap:12, padding:'12px 16px'}}>
                <span className="icon" style={{fontSize:20, opacity:0.6}}>{TYPE_ICONS[op.type] || 'settings'}</span>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:4}}>
                    <strong>{TYPE_LABELS[op.type] || op.type}</strong>
                    {op.collection_id && <span className="text-muted" style={{fontSize:12}}>{colMap[op.collection_id] || `Collection #${op.collection_id}`}</span>}
                    {statusBadge(op.status)}
                    <span className="text-muted" style={{fontSize:11}}>{getAge(op.created_at)}</span>
                  </div>
                  {(op.status === 'running' || op.status === 'pending') && (
                    <div className="progress-bar-wrapper" style={{minWidth:120, height:16}}>
                      <div className="progress-bar" style={{width:`${op.progress_pct}%`}} />
                      <span className="progress-label">{op.progress_msg || `${op.progress_pct}%`}</span>
                    </div>
                  )}
                  {op.error && <div style={{color:'#f44336', fontSize:12, marginTop:2}}>{op.error}</div>}
                  {op.status === 'done' && op.result && (
                    <div style={{fontSize:12, color:'var(--text-muted)', marginTop:2}}>
                      {op.type === 'build' && `${op.result.matched || 0} matched, ${op.result.missing || 0} missing`}
                      {op.type === 'scrape' && `${op.result.scraped || 0} scraped, ${op.result.skipped || 0} skipped, ${op.result.failed || 0} failed`}
                      {op.type === 'import' && `${op.result.total_games || 0} games imported`}
                      {op.type === 'scan' && `${op.result.exists || 0} exist, ${op.result.missing || 0} missing`}
                    </div>
                  )}
                </div>
                {(op.status === 'running' || op.status === 'pending') && (
                  <button className="btn btn-sm btn-danger" onClick={() => cancelOperation(op.id)} title="Cancel">
                    <span className="icon icon-sm">close</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
