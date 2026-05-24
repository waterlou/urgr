import { useState } from 'react'
import GameGridCard from './GameGridCard.jsx'
import GameListItem from './GameListItem.jsx'
import { getGames, coverUrl, updateGameRating } from '../api.js'

export default function GameBrowser({
  games, loading, activeView, activeMeta, totalGames, platforms,
  viewMode, sortField, sortOrder, searchQuery,
  onViewModeChange, onSortFieldChange, onSortOrderChange,
  onSearchQueryChange, onSelectGame, onAddToGameSet, gameSets, activeId,
  showBackToDetail, onBackToDetail,
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [localQuery, setLocalQuery] = useState('')

  async function handleSearch(e) {
    const q = e.target.value
    setLocalQuery(q)
    if (q.length < 2) {
      setSearchResults([])
      setSearchOpen(false)
      return
    }
    const { games: results } = await getGames({ q, limit: 50 })
    setSearchResults(results)
    setSearchOpen(true)
  }

  function handleViewChange(mode) {
    onViewModeChange(mode)
  }

  function handleSortToggle(field) {
    if (sortField === field) {
      onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      onSortFieldChange(field)
      onSortOrderChange('asc')
    }
  }

  async function handleRating(game, rating) {
    await updateGameRating(game.id, { rating })
    // Optimistic update
    game.rating = rating
    forceUpdate()
  }

  async function handleFavourite(game) {
    await updateGameRating(game.id, { favourite: !game.favourite })
    game.favourite = game.favourite ? 0 : 1
    forceUpdate()
  }

  // Force re-render hack
  const [, setTick] = useState(0)
  function forceUpdate() { setTick(t => t + 1) }

  const title = !activeMeta
    ? 'All Games'
    : activeView === 'collection'
    ? activeMeta.name
    : activeMeta.name

  const isList = viewMode === 'list'
  const isGrid = viewMode === 'grid'
  const isLarge = viewMode === 'large'

  const SORT_OPTIONS = [
    { field: 'name', label: 'Name' },
    { field: 'rating', label: 'Rating' },
    { field: 'favourite', label: 'Favourite' },
  ]

  return (
    <div className="browser">
      <div className="browser-header">
        <div className="browser-title-row">
          {showBackToDetail && (
            <button className="back-btn" onClick={onBackToDetail} title="Back to Collection"><span className="icon">arrow_back</span></button>
          )}
          <h1 className="browser-title">{title}</h1>
          <span className="browser-count">{totalGames} games</span>
          {platforms.length > 0 && (
            <div className="browser-platforms">
              {platforms.map(p => <span key={p} className="platform-badge">{p}</span>)}
            </div>
          )}
        </div>

        <div className="browser-toolbar">
          <div className="toolbar-left">
            <div className="view-mode-toggle">
              <button className={`view-btn ${isList ? 'active' : ''}`} onClick={() => handleViewChange('list')} title="List"><span className="icon">view_headline</span></button>
              <button className={`view-btn ${isGrid ? 'active' : ''}`} onClick={() => handleViewChange('grid')} title="Grid"><span className="icon">grid_view</span></button>
              <button className={`view-btn ${isLarge ? 'active' : ''}`} onClick={() => handleViewChange('large')} title="Large Icons"><span className="icon">view_module</span></button>
            </div>

            <div className="sort-controls">
              <span className="sort-label">Sort:</span>
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.field}
                  className={`sort-btn ${sortField === opt.field ? 'active' : ''}`}
                  onClick={() => handleSortToggle(opt.field)}
                >
                  {opt.label}
                  {sortField === opt.field && <span className="icon icon-xs sort-arrow">{sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-right">
            <div className="browser-search">
              <input
                type="text"
                placeholder="Filter games..."
                value={searchQuery}
                onChange={e => onSearchQueryChange(e.target.value)}
                className="search-input"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="browser-content">
        {loading ? (
          <div className="loading-screen"><div className="loading-spinner" /></div>
        ) : games.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><span className="icon icon-xl">inbox</span></div>
            <h2>No games found</h2>
            {activeView === 'collection' && <p>Import a DAT file to populate this collection, or add games manually.</p>}
            {activeView === 'game-set' && <p>Add games from a collection or search to start building your set.</p>}
          </div>
        ) : isList ? (
          <div className="game-list">
            <div className="list-header">
              <span className="list-col-name">Name</span>
              <span className="list-col-platform">Platform</span>
              <span className="list-col-year">Year</span>
              <span className="list-col-rating">Rating</span>
              <span className="list-col-fav">Fav</span>
            </div>
            {games.map(game => (
              <GameListItem
                key={game.id}
                game={game}
                onSelect={onSelectGame}
                onRating={r => handleRating(game, r)}
                onFavourite={() => handleFavourite(game)}
              />
            ))}
          </div>
        ) : (
          <div className={`game-grid ${isLarge ? 'game-grid-large' : ''}`}>
            {games.map(game => (
              <GameGridCard
                key={game.id}
                game={game}
                onSelect={onSelectGame}
                onRating={r => handleRating(game, r)}
                onFavourite={() => handleFavourite(game)}
                onAddToGameSet={onAddToGameSet}
                gameSets={gameSets}
                currentGameSetId={activeId}
                viewMode={viewMode}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
