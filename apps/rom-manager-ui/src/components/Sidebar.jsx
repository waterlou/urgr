import IconDisplay from './IconDisplay.jsx'

export default function Sidebar({
  collections, gameSets, activeView, activeId,
  onSelect, onNewCollection, onNewGameSet,
  onEditCollection, onEditGameSet,
  onDeleteCollection, onDeleteGameSet,
  theme, onToggleTheme, onOpenSettings,
  sidebarOpen, queueCount,
}) {
  return (
    <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
      <div className="sidebar-header" onClick={() => onSelect('browse', null)}>
        <div className="neon-logo">
          <span className="icon neon-icon icon-xl">sports_esports</span>
        </div>
        <div className="neon-title">
          <span className="neon-text">ROM</span>
          <span className="neon-text neon-text-accent">Manager</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        <button
          className={`sidebar-section-btn ${activeView === 'browse' ? 'active' : ''}`}
          onClick={() => onSelect('browse', null)}
        >
          <span className="icon icon-sm section-icon">folder_open</span>
          <span>All Games</span>
        </button>

        <button
          className={`sidebar-section-btn ${activeView === 'downloads' ? 'active' : ''}`}
          onClick={() => onSelect('downloads', null)}
        >
          <span className="icon icon-sm section-icon">download</span>
          <span>Downloads</span>
          {queueCount > 0 && <span className="sidebar-item-count">{queueCount}</span>}
        </button>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Collections</span>
            <button className="sidebar-add-btn" onClick={onNewCollection} title="New Collection"><span className="icon icon-xs">add</span></button>
          </div>
          {(!collections || collections.length === 0) && <div className="sidebar-empty">No collections yet</div>}
          {collections && collections.map(col => (
            <div
              key={col.id}
              className={`sidebar-item ${activeView === 'collection' && activeId === col.id ? 'active' : ''}`}
            >
              <button className="sidebar-item-main" onClick={() => onSelect('collection', col.id)}>
                <span className="sidebar-item-icon"><IconDisplay name={col.logo} fallback="folder" /></span>
                <span className="sidebar-item-name">{col.name || 'Unnamed'}</span>
                <span className="sidebar-item-count">{col.total_games ?? 0}</span>
              </button>
              <div className="sidebar-item-actions">
                <button className="sidebar-action-btn" onClick={() => onEditCollection(col.id)} title="Edit"><span className="icon icon-xs">edit</span></button>
                <button className="sidebar-action-btn" onClick={() => onDeleteCollection(col.id)} title="Delete"><span className="icon icon-xs">close</span></button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Game Sets</span>
            <button className="sidebar-add-btn" onClick={onNewGameSet} title="New Game Set"><span className="icon icon-xs">add</span></button>
          </div>
          {gameSets.length === 0 && <div className="sidebar-empty">No game sets yet</div>}
          {gameSets.map(gs => (
            <div
              key={gs.id}
              className={`sidebar-item ${activeView === 'game-set' && activeId === gs.id ? 'active' : ''}`}
            >
              <button className="sidebar-item-main" onClick={() => onSelect('game-set', gs.id)}>
                <span className="sidebar-item-icon"><IconDisplay name={gs.icon} fallback="inventory_2" /></span>
                <span className="sidebar-item-name">{gs.name}</span>
                <span className="sidebar-item-count">{gs.total_games}</span>
              </button>
              <div className="sidebar-item-actions">
                <button className="sidebar-action-btn" onClick={() => onEditGameSet(gs.id)} title="Edit"><span className="icon icon-xs">edit</span></button>
                <button className="sidebar-action-btn" onClick={() => onDeleteGameSet(gs.id)} title="Delete"><span className="icon icon-xs">close</span></button>
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-settings-btn" onClick={onOpenSettings} title="Settings">
          <span className="icon icon-sm">settings</span>
        </button>
        <button className="theme-toggle" onClick={onToggleTheme} title="Toggle theme">
          <span className="icon icon-sm">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
        </button>
      </div>
    </aside>
  )
}
