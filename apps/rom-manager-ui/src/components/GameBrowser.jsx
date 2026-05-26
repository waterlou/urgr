import { useState, useEffect, useRef } from 'react'
import GameGridCard from './GameGridCard.jsx'
import GameListItem from './GameListItem.jsx'
import { getGames, coverUrl, updateGameRating, batchScrapeGameMetadata, subscribeJobSSE, cancelJob } from '../api.js'

export default function GameBrowser({
  games, loading, hasMore, onLoadMore, activeView, activeMeta, totalGames, platforms,
  viewMode, sortField, sortOrder, searchQuery,
  onViewModeChange, onSortFieldChange, onSortOrderChange,
  onSearchQueryChange, onSelectGame, onAddToGameSet, gameSets, activeId,
  showBackToDetail, onBackToDetail,
  parentsOnly, onParentsOnlyChange,
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [localQuery, setLocalQuery] = useState('')
  const sentinelRef = useRef(null)
  const [batchShow, setBatchShow] = useState(false)
  const [batchOverwrite, setBatchOverwrite] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState('')
  const [batchResult, setBatchResult] = useState(null)
  const [batchJobId, setBatchJobId] = useState(null)
  const eventSourceRef = useRef(null)

  useEffect(() => {
    return () => { if (eventSourceRef.current) eventSourceRef.current.close(); }
  }, [])

  // Reset batch UI when navigating to different games
  useEffect(() => {
    setBatchShow(false)
    setBatchRunning(false)
    setBatchProgress('')
    setBatchResult(null)
    setBatchJobId(null)
    if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null }
  }, [activeView, activeId])

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!hasMore || loading) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onLoadMore?.()
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

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

  async function handleBatchScrape() {
    if (games.length === 0) return
    setBatchRunning(true)
    setBatchProgress('Starting...')
    setBatchResult(null)
    try {
      const gameIds = games.map(g => g.id)
      const { jobId } = await batchScrapeGameMetadata(gameIds, batchOverwrite)
      setBatchJobId(jobId)
      eventSourceRef.current = subscribeJobSSE(jobId, {
        onProgress: (msg) => setBatchProgress(msg.msg || `Progress: ${msg.pct}%`),
        onResult: (data) => {
          setBatchResult(data)
          setBatchRunning(false)
          setBatchJobId(null)
        },
        onError: (err) => {
          setBatchResult({ error: err })
          setBatchRunning(false)
          setBatchJobId(null)
        },
      })
    } catch (e) {
      setBatchResult({ error: e.message })
      setBatchRunning(false)
    }
  }

  async function handleCancelBatch() {
    if (!batchJobId) return
    try {
      await cancelJob(batchJobId)
      if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null }
    } catch (e) { console.error('Cancel error:', e) }
    setBatchRunning(false)
    setBatchResult({ cancelled: true })
    setBatchJobId(null)
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
            {onParentsOnlyChange && (activeView === 'collection' || activeView === 'browse') && (
              <button
                className={`btn btn-sm ${parentsOnly ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => onParentsOnlyChange(!parentsOnly)}
                title="Show parent games only"
                style={{marginRight:8}}
              >
                <span className="icon icon-sm">account_tree</span> {parentsOnly ? 'Parents' : 'All'}
              </button>
            )}
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
            {activeView === 'collection' && games.length > 0 && !batchShow && !batchRunning && !batchResult && (
              <button className="btn btn-sm btn-secondary" onClick={() => setBatchShow(true)} style={{marginRight:8}}>
                <span className="icon icon-sm">auto_awesome</span> Scrape
              </button>
            )}
            {batchShow && !batchRunning && !batchResult && (
              <div className="batch-scrape-form" style={{display:'flex',alignItems:'center',gap:8,marginRight:8}}>
                <span className="text-muted" style={{fontSize:12,whiteSpace:'nowrap'}}>{games.length} game{games.length !== 1 ? 's' : ''}</span>
                <label className="batch-overwrite-label" style={{fontSize:12,display:'flex',alignItems:'center',gap:4,cursor:'pointer',whiteSpace:'nowrap'}}>
                  <input type="checkbox" checked={batchOverwrite} onChange={e => setBatchOverwrite(e.target.checked)} />
                  Overwrite
                </label>
                <button className="btn btn-sm btn-primary" onClick={handleBatchScrape}><span className="icon icon-sm">auto_awesome</span> Start</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setBatchShow(false)}>Cancel</button>
              </div>
            )}
            {batchRunning && (
              <div className="batch-scrape-progress" style={{display:'flex',alignItems:'center',gap:6,marginRight:8}}>
                <div className="loading-spinner-sm" />
                <span className="text-muted" style={{fontSize:12,whiteSpace:'nowrap',maxWidth:300,overflow:'hidden',textOverflow:'ellipsis'}}>{batchProgress}</span>
                <button className="btn btn-sm btn-danger" onClick={handleCancelBatch} title="Cancel">✕</button>
              </div>
            )}
            {batchResult && !batchRunning && (
              <div className="batch-scrape-result" style={{display:'flex',alignItems:'center',gap:6,marginRight:8}}>
                {batchResult.error ? (
                  <span className="scrape-error" style={{fontSize:12,whiteSpace:'nowrap'}}>Failed: {batchResult.error}</span>
                ) : batchResult.cancelled ? (
                  <span className="text-muted" style={{fontSize:12,whiteSpace:'nowrap'}}>Cancelled</span>
                ) : (
                  <span className="text-muted" style={{fontSize:12,whiteSpace:'nowrap'}}>
                    ✓ {batchResult.scraped} · ⏭ {batchResult.skipped} · ✗ {batchResult.failed}
                  </span>
                )}
                <button className="btn btn-sm btn-secondary" onClick={() => { setBatchShow(false); setBatchResult(null); setBatchJobId(null); }}>OK</button>
              </div>
            )}
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
        {loading && games.length === 0 ? (
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
        {hasMore && <div ref={sentinelRef} className="scroll-sentinel" />}
        {loading && games.length > 0 && <div className="loading-more"><div className="loading-spinner" /></div>}
      </div>
    </div>
  )
}
