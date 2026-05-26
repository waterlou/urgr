import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getGames, getCollections, getGameSets, getPlatforms, getVersions,
  getCollectionGames, getGameSetGames, createCollection, deleteCollection,
  updateCollection, addCollectionVersion, removeCollectionVersion,
  createGameSet, deleteGameSet, updateGameSet, addGameSetGames, removeGameSetGame,
} from './api.js'
import Sidebar from './components/Sidebar.jsx'
import GameBrowser from './components/GameBrowser.jsx'
import GameDetail from './components/GameDetail.jsx'
import CollectionDetail from './components/CollectionDetail.jsx'
import CollectionForm from './components/CollectionForm.jsx'
import GameSetForm from './components/GameSetForm.jsx'
import Settings from './components/Settings.jsx'

export default function App() {
  const [collections, setCollections] = useState([])
  const [gameSets, setGameSets] = useState([])
  const [versions, setVersions] = useState([])
  const [activeView, setActiveView] = useState('browse')
  const [activeId, setActiveId] = useState(null)
  const [collectionSubView, setCollectionSubView] = useState('detail') // 'detail' or 'games'
  const [games, setGames] = useState([])
  const [activeMeta, setActiveMeta] = useState(null)
  const [offset, setOffset] = useState(0)
  const [totalGames, setTotalGames] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [platforms, setPlatforms] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedGame, setSelectedGame] = useState(null)
  const [showCollectionForm, setShowCollectionForm] = useState(false)
  const [showGameSetForm, setShowGameSetForm] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [viewMode, setViewMode] = useState('grid')
  const [sortField, setSortField] = useState('name')
  const [sortOrder, setSortOrder] = useState('asc')
  const [versionFilter, setVersionFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [parentsOnly, setParentsOnly] = useState(() => localStorage.getItem('rom-manager-parents-only') === 'true')

  function handleSetParentsOnly(v) {
    setParentsOnly(v);
    localStorage.setItem('rom-manager-parents-only', v);
  }
  const POPULAR_DATASETS = [
    { name: 'MAME', slug: 'mame', platform: 'Arcade' },
    { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
  ]
  const [datasets, setDatasets] = useState({ popular: POPULAR_DATASETS, imported: [] })
  const [knownPlatforms, setKnownPlatforms] = useState([])
  const [theme, setTheme] = useState(() => localStorage.getItem('rom-manager-theme') || 'dark')
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('rom-manager-theme', theme)
  }, [theme])

  function handleToggleTheme() {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const loadSidebar = useCallback(async () => {
    try {
      const [cols, sets, vers, plats] = await Promise.all([
        getCollections(), getGameSets(), getVersions(),
        getPlatforms().catch(() => []),
      ])
      console.log('[loadSidebar] collections:', cols.length, cols.map(c => c.name))
      setCollections(cols)
      setGameSets(sets)
      setVersions(vers)
      setDatasets({ popular: POPULAR_DATASETS, imported: vers })
      setKnownPlatforms(plats)
    } catch (e) {
      console.error('[loadSidebar] FAILED:', e)
    }
  }, [])

  const PAGE_SIZE = 500
  const loadingMoreRef = useRef(false)

  const loadGames = useCallback(async (view, id, mode, sort, order, q, po) => {
    setLoading(true)
    setOffset(0)
    try {
      if (view === 'browse') {
        const data = await getGames({ limit: PAGE_SIZE, sort, order, q, parents_only: po ? 'true' : undefined })
        setGames(data.games)
        setTotalGames(data.total)
        setActiveMeta(null)
        setPlatforms([])
        setHasMore(data.games.length < data.total)
      } else if (view === 'collection') {
        const data = await getCollectionGames(id, { limit: PAGE_SIZE, sort, order, q, parents_only: po ? 'true' : undefined })
        setGames(data.games)
        setActiveMeta(data.collection)
        setPlatforms(data.platforms || [])
        setTotalGames(data.total)
        setHasMore(data.games.length < data.total)
      } else if (view === 'game-set') {
        const data = await getGameSetGames(id, { limit: PAGE_SIZE, sort, order, q })
        setGames(data.games)
        setActiveMeta(data.game_set)
        const plats = data.game_set?.platforms ? data.game_set.platforms.split(',').filter(Boolean) : []
        setPlatforms(plats)
        setTotalGames(data.total)
        setHasMore(data.games.length < data.total)
      }
    } catch (e) {
      console.error('Failed to load games:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  async function loadMore() {
    if (loadingMoreRef.current || !hasMore) return
    loadingMoreRef.current = true
    setLoading(true)
    try {
      let data
      if (activeView === 'browse') {
        data = await getGames({ limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery, parents_only: parentsOnly ? 'true' : undefined })
      } else if (activeView === 'collection') {
        data = await getCollectionGames(activeId, { limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery, parents_only: parentsOnly ? 'true' : undefined })
      } else if (activeView === 'game-set') {
        data = await getGameSetGames(activeId, { limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery })
      }
      if (data) {
        setOffset(prev => prev + PAGE_SIZE)
        setGames(prev => [...prev, ...data.games])
        setHasMore(data.games.length === PAGE_SIZE)
      }
    } catch (e) {
      console.error('Failed to load more games:', e)
    } finally {
      setLoading(false)
      loadingMoreRef.current = false
    }
  }

  useEffect(() => { loadSidebar() }, [loadSidebar])

  useEffect(() => {
    loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly)
  }, [activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly, loadGames])

  function handleSelect(view, id) {
    setActiveView(view)
    setActiveId(id)
    setSearchQuery('')
    if (view === 'collection') setCollectionSubView('detail')
  }

  async function handleCreateCollection(data) {
    await createCollection(data)
    await loadSidebar()
    setShowCollectionForm(false)
  }

  async function handleDeleteCollection(id) {
    const col = collections.find(c => c.id === id)
    const name = col?.name || 'this collection'
    if (!window.confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) return
    await deleteCollection(id)
    if (activeView === 'collection' && activeId === id) {
      setActiveView('browse')
      setActiveId(null)
    }
    await loadSidebar()
  }

  async function handleCreateGameSet(data) {
    await createGameSet(data)
    await loadSidebar()
    setShowGameSetForm(false)
  }

  async function handleDeleteGameSet(id) {
    await deleteGameSet(id)
    if (activeView === 'game-set' && activeId === id) {
      setActiveView('browse')
      setActiveId(null)
    }
    await loadSidebar()
  }

  async function handleEditCollection(id) {
    const col = collections.find(c => c.id === id)
    if (!col) return
    setEditTarget({ type: 'collection', data: col })
    setShowCollectionForm(true)
  }

  async function handleEditGameSet(id) {
    const gs = gameSets.find(g => g.id === id)
    if (!gs) return
    setEditTarget({ type: 'game-set', data: gs })
    setShowGameSetForm(true)
  }

  async function handleSaveCollection(data) {
    console.log('[handleSaveCollection] data:', JSON.stringify(data))
    try {
      let result;
      if (editTarget) {
        result = await updateCollection(editTarget.data.id, data)
      } else {
        result = await createCollection(data)
      }
      console.log('[handleSaveCollection] create result:', result)
      setEditTarget(null)
      setShowCollectionForm(false)
      await loadSidebar()
      console.log('[handleSaveCollection] sidebar refreshed')
    } catch (e) {
      console.error('[handleSaveCollection] FAILED:', e.message)
      throw e
    }
  }

  async function handleSaveGameSet(data) {
    if (editTarget) {
      await updateGameSet(editTarget.data.id, data)
    } else {
      await createGameSet(data)
    }
    setEditTarget(null)
    setShowGameSetForm(false)
    await loadSidebar()
  }

  async function handleAddToGameSet(gameEntryId, setId) {
    await addGameSetGames(setId, [gameEntryId])
    await loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly)
  }

  async function handleRemoveFromGameSet(gameEntryId, setId) {
    await removeGameSetGame(setId, gameEntryId)
    await loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly)
  }

  return (
    <div className="app-layout">
      <Sidebar
        collections={collections}
        gameSets={gameSets}
        activeView={activeView}
        activeId={activeId}
        onSelect={handleSelect}
        onNewCollection={() => { setEditTarget(null); setShowCollectionForm(true) }}
        onNewGameSet={() => { setEditTarget(null); setShowGameSetForm(true) }}
        onEditCollection={handleEditCollection}
        onEditGameSet={handleEditGameSet}
        onDeleteCollection={handleDeleteCollection}
        onDeleteGameSet={handleDeleteGameSet}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="main-pane">
        {activeView === 'collection' && collectionSubView === 'detail' ? (
          <CollectionDetail
            collectionId={activeId}
            collection={collections.find(c => c.id === activeId)}
            onBrowseGames={() => setCollectionSubView('games')}
            onRefresh={loadSidebar}
          />
        ) : (
          <GameBrowser
            games={games}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            activeView={activeView}
            activeMeta={activeMeta}
            totalGames={totalGames}
            platforms={platforms}
            viewMode={viewMode}
            sortField={sortField}
            sortOrder={sortOrder}
            searchQuery={searchQuery}
            onViewModeChange={setViewMode}
            onSortFieldChange={setSortField}
            onSortOrderChange={setSortOrder}
            onSearchQueryChange={setSearchQuery}
            onSelectGame={setSelectedGame}
            onAddToGameSet={handleAddToGameSet}
            onRemoveFromGameSet={handleRemoveFromGameSet}
            gameSets={gameSets}
            activeId={activeId}
            showBackToDetail={activeView === 'collection'}
            onBackToDetail={() => setCollectionSubView('detail')}
            parentsOnly={parentsOnly}
            onParentsOnlyChange={handleSetParentsOnly}
          />
        )}
      </main>

      {selectedGame && <GameDetail gameId={selectedGame.id || selectedGame} onClose={() => setSelectedGame(null)} onNavigate={(id) => setSelectedGame({id})} />}

      {showCollectionForm && (
        <CollectionForm
          datasets={datasets}
          platforms={knownPlatforms}
          versions={versions}
          editTarget={editTarget?.data}
          onSave={handleSaveCollection}
          onClose={() => { setShowCollectionForm(false); setEditTarget(null) }}
        />
      )}

      {showGameSetForm && (
        <GameSetForm
          platforms={knownPlatforms}
          editTarget={editTarget?.data}
          onSave={handleSaveGameSet}
          onClose={() => { setShowGameSetForm(false); setEditTarget(null) }}
        />
      )}

      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
