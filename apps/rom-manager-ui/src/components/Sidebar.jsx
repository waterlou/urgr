export default function Sidebar({
  collections, gameSets, activeView, activeId,
  onSelect, onNewCollection, onNewGameSet,
  onEditCollection, onEditGameSet,
  onDeleteCollection, onDeleteGameSet,
  theme, onToggleTheme,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header" onClick={() => onSelect('browse', null)}>
        <span className="sidebar-logo">🎮</span>
        <span className="sidebar-title">ROM Manager</span>
      </div>

      <nav className="sidebar-nav">
        <button
          className={`sidebar-section-btn ${activeView === 'browse' ? 'active' : ''}`}
          onClick={() => onSelect('browse', null)}
        >
          <span className="section-icon">📂</span>
          <span>All Games</span>
        </button>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Collections</span>
            <button className="sidebar-add-btn" onClick={onNewCollection} title="New Collection">+</button>
          </div>
          {(!collections || collections.length === 0) && <div className="sidebar-empty">No collections yet</div>}
          {collections && collections.map(col => (
            <div
              key={col.id}
              className={`sidebar-item ${activeView === 'collection' && activeId === col.id ? 'active' : ''}`}
            >
              <button className="sidebar-item-main" onClick={() => onSelect('collection', col.id)}>
                <span className="sidebar-item-icon">{col.logo || '📁'}</span>
                <span className="sidebar-item-name">{col.name || 'Unnamed'}</span>
                <span className="sidebar-item-count">{col.total_games ?? 0}</span>
              </button>
              <div className="sidebar-item-actions">
                <button className="sidebar-action-btn" onClick={() => onEditCollection(col.id)} title="Edit">✎</button>
                <button className="sidebar-action-btn" onClick={() => onDeleteCollection(col.id)} title="Delete">✕</button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Game Sets</span>
            <button className="sidebar-add-btn" onClick={onNewGameSet} title="New Game Set">+</button>
          </div>
          {gameSets.length === 0 && <div className="sidebar-empty">No game sets yet</div>}
          {gameSets.map(gs => (
            <div
              key={gs.id}
              className={`sidebar-item ${activeView === 'game-set' && activeId === gs.id ? 'active' : ''}`}
            >
              <button className="sidebar-item-main" onClick={() => onSelect('game-set', gs.id)}>
                <span className="sidebar-item-icon">{gs.icon || '📦'}</span>
                <span className="sidebar-item-name">{gs.name}</span>
                <span className="sidebar-item-count">{gs.total_games}</span>
              </button>
              <div className="sidebar-item-actions">
                <button className="sidebar-action-btn" onClick={() => onEditGameSet(gs.id)} title="Edit">✎</button>
                <button className="sidebar-action-btn" onClick={() => onDeleteGameSet(gs.id)} title="Delete">✕</button>
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button className="theme-toggle" onClick={onToggleTheme} title="Toggle theme">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </aside>
  )
}
