import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getGames, getCollections, getGameSets, getPlatforms, getVersions,
  getCollectionGames, getGameSetGames, createCollection, deleteCollection,
  updateCollection, addCollectionVersion, removeCollectionVersion,
  createGameSet, deleteGameSet, updateGameSet, addGameSetGames, removeGameSetGame,
  getDownloadQueue,
} from './api.js'
import useRouter from './hooks/useRouter.js'
import Sidebar from './components/Sidebar.jsx'
import GameBrowser from './components/GameBrowser.jsx'
import GameDetail from './components/GameDetail.jsx'
import CollectionDetail from './components/CollectionDetail.jsx'
import CollectionForm from './components/CollectionForm.jsx'
import GameSetForm from './components/GameSetForm.jsx'
import Settings from './components/Settings.jsx'
import DownloadManager from './components/DownloadManager.jsx'
import Dashboard from './components/Dashboard.jsx'

export default function App() {
  const {
    activeView, setActiveView,
    activeId, setActiveId,
    collectionSubView, setCollectionSubView,
    selectedGame, setSelectedGame,
    pushViewHistory,
  } = useRouter()

  const [collections, setCollections] = useState([])
  const [gameSets, setGameSets] = useState([])
  const [versions, setVersions] = useState([])
  const [games, setGames] = useState([])
  const [activeMeta, setActiveMeta] = useState(null)
  const [offset, setOffset] = useState(0)
  const [totalGames, setTotalGames] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [platforms, setPlatforms] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCollectionForm, setShowCollectionForm] = useState(false)
  const [showGameSetForm, setShowGameSetForm] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [viewMode, setViewMode] = useState('grid')
  const [sortField, setSortField] = useState('name')
  const [sortOrder, setSortOrder] = useState('asc')
  const [versionFilter, setVersionFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [parentsOnly, setParentsOnly] = useState(() => localStorage.getItem('rom-manager-parents-only') === 'true')
  const [favouritesOnly, setFavouritesOnly] = useState(() => localStorage.getItem('rom-manager-favourites-only') === 'true')
  const [romsOnly, setRomsOnly] = useState(() => localStorage.getItem('rom-manager-roms-only') === 'true')
  const [listImageMode, setListImageMode] = useState(() => localStorage.getItem('rom-manager-list-image') || 'cover')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState(null)
  const [collectionVersions, setCollectionVersions] = useState([])

  function handleSetParentsOnly(v) {
    setParentsOnly(v);
    localStorage.setItem('rom-manager-parents-only', v);
  }

  function handleSetFavouritesOnly(v) {
    setFavouritesOnly(v);
    localStorage.setItem('rom-manager-favourites-only', v);
  }

  function handleSetRomsOnly(v) {
    setRomsOnly(v);
    localStorage.setItem('rom-manager-roms-only', v);
  }

  function handleSetListImageMode(v) {
    setListImageMode(v);
    localStorage.setItem('rom-manager-list-image', v);
  }
  const POPULAR_DATASETS = [
    { name: 'MAME', slug: 'mame', platform: 'Arcade' },
    { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
    { name: 'OfflineList (No-Intro)', slug: 'offlinelist', platform: 'Console', isOfflineList: true },
    { name: 'DAT-O-MATIC', slug: 'datomatic', platform: 'Console', isDatomic: true },
    { name: 'NoPayStation', slug: 'nps', platform: 'PlayStation', isNps: true },
  ]
  const [datasets, setDatasets] = useState({ popular: POPULAR_DATASETS, imported: [] })
  const [knownPlatforms, setKnownPlatforms] = useState([])
  const [theme, setTheme] = useState(() => localStorage.getItem('rom-manager-theme') || 'dark')
  const [showSettings, setShowSettings] = useState(false)
  const [queueCount, setQueueCount] = useState(0)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('rom-manager-theme', theme)
  }, [theme])

  function handleToggleTheme() {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  function handleToggleSidebar() {
    setSidebarOpen(prev => !prev)
  }

  const loadSidebar = useCallback(async () => {
    try {
      const [cols, sets, vers, plats, dq] = await Promise.all([
        getCollections(), getGameSets(), getVersions(),
        getPlatforms().catch(() => []),
        getDownloadQueue().catch(() => ({ queue: [] })),
      ])
      console.log('[loadSidebar] collections:', cols.length, cols.map(c => c.name))
      setCollections(cols)
      setGameSets(sets)
      setVersions(vers)
      setDatasets({ popular: POPULAR_DATASETS, imported: vers })
      setKnownPlatforms(plats)
      setQueueCount((dq.queue || []).filter(i => i.status === 'pending' || i.status === 'downloading').length)
    } catch (e) {
      console.error('[loadSidebar] FAILED:', e)
    }
  }, [])

  const PAGE_SIZE = 500
  const loadingMoreRef = useRef(false)

  const loadGames = useCallback(async (view, id, mode, sort, order, q, po, fo, ro, vid) => {
    setLoading(true)
    setOffset(0)
    try {
      if (view === 'browse') {
        const data = await getGames({ limit: PAGE_SIZE, sort, order, q, parents_only: po ? 'true' : undefined, favourites_only: fo ? 'true' : undefined, roms_only: ro ? 'true' : undefined })
        setGames(data.games)
        setTotalGames(data.total)
        setActiveMeta(null)
        setPlatforms([])
        setHasMore(data.games.length < data.total)
      } else if (view === 'collection') {
        const data = await getCollectionGames(id, { limit: PAGE_SIZE, sort, order, q, parents_only: po ? 'true' : undefined, favourites_only: fo ? 'true' : undefined, roms_only: ro ? 'true' : undefined, version_id: vid || undefined })
        setGames(data.games)
        setActiveMeta(data.collection)
        setPlatforms(data.platforms || [])
        setTotalGames(data.total)
        setHasMore(data.games.length < data.total)
        if (data.versions) setCollectionVersions(data.versions)
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
        data = await getGames({ limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery, parents_only: parentsOnly ? 'true' : undefined, favourites_only: favouritesOnly ? 'true' : undefined, roms_only: romsOnly ? 'true' : undefined })
      } else if (activeView === 'collection') {
        data = await getCollectionGames(activeId, { limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery, parents_only: parentsOnly ? 'true' : undefined, favourites_only: favouritesOnly ? 'true' : undefined, roms_only: romsOnly ? 'true' : undefined, version_id: selectedVersionId || undefined })
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
    loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly, favouritesOnly, romsOnly, selectedVersionId)
  }, [activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly, favouritesOnly, romsOnly, selectedVersionId, loadGames])

  function handleSelect(view, id) {
    pushViewHistory(view, id)
    setActiveView(view)
    setActiveId(id)
    setSearchQuery('')
    setSelectedVersionId(null)
    if (view === 'collection') {
      const col = collections.find(c => c.id === id);
      setCollectionSubView(col?.total_games > 0 ? 'games' : 'detail');
    } else {
      setSelectedGame(null)
    }
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
      pushViewHistory('browse', null)
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
      pushViewHistory('browse', null)
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

  function handleBrowseGames() {
    pushViewHistory('collection', activeId, 'games', null)
    setCollectionSubView('games')
  }

  function handleBackToDetail() {
    pushViewHistory('collection', activeId, 'detail', null)
    setCollectionSubView('detail')
    setSelectedGame(null)
  }

  function handleSelectGame(game) {
    if (game) pushViewHistory(activeView, activeId, collectionSubView, game)
    setSelectedGame(game)
  }

  function handleCloseGame() {
    pushViewHistory(activeView, activeId, collectionSubView, null)
    setSelectedGame(null)
  }

  function handleNavigateGame(id) {
    const game = { id }
    pushViewHistory(activeView, activeId, collectionSubView, game)
    setSelectedGame(game)
  }

  async function handleAddToGameSet(gameEntryId, setId) {
    await addGameSetGames(setId, [gameEntryId])
    await loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly)
  }

  async function handleRemoveFromGameSet(gameEntryId, setId) {
    await removeGameSetGame(setId, gameEntryId)
    await loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery, parentsOnly)
  }

  function handleUpdateGame(gameId, patch) {
    setGames(prev => prev.map(g => g.id === gameId ? { ...g, ...patch } : g))
  }

  return (
    <div className="app-layout">
      <div className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`} onClick={() => setSidebarOpen(false)} />
      <Sidebar
        collections={collections}
        gameSets={gameSets}
        activeView={activeView}
        activeId={activeId}
        sidebarOpen={sidebarOpen}
        queueCount={queueCount}
        onSelect={(view, id) => { handleSelect(view, id); setSidebarOpen(false) }}
        onNewCollection={() => { setEditTarget(null); setShowCollectionForm(true); setSidebarOpen(false) }}
        onNewGameSet={() => { setEditTarget(null); setShowGameSetForm(true); setSidebarOpen(false) }}
        onEditCollection={handleEditCollection}
        onEditGameSet={handleEditGameSet}
        onDeleteCollection={handleDeleteCollection}
        onDeleteGameSet={handleDeleteGameSet}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={() => { setShowSettings(true); setSidebarOpen(false) }}
      />

      <main className="main-pane">
        {activeView === 'home' ? (
          <Dashboard onSelectCollection={(id) => handleSelect('collection', id)} />
        ) : activeView === 'downloads' ? (
          <DownloadManager onBack={() => handleSelect('home', null)} />
        ) : activeView === 'collection' && collectionSubView === 'detail' ? (
          <CollectionDetail
            collectionId={activeId}
            collection={collections.find(c => c.id === activeId)}
            onBrowseGames={handleBrowseGames}
            onBack={handleBrowseGames}
            onRefresh={loadSidebar}
          />
        ) : (
          <div className={`view-stack${selectedGame ? ' show-detail' : ''}`}>
            <div className="view-stack-track">
              <div className="view-stack-page">
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
                  onSelectGame={handleSelectGame}
                  onAddToGameSet={handleAddToGameSet}
                  onRemoveFromGameSet={handleRemoveFromGameSet}
                  onUpdateGame={handleUpdateGame}
                  gameSets={gameSets}
                  activeId={activeId}
                  showBackToDetail={activeView === 'collection'}
                  onBackToDetail={handleBackToDetail}
                  parentsOnly={parentsOnly}
                  onParentsOnlyChange={handleSetParentsOnly}
                  favouritesOnly={favouritesOnly}
                  onFavouritesOnlyChange={handleSetFavouritesOnly}
                  romsOnly={romsOnly}
                  onRomsOnlyChange={handleSetRomsOnly}
                  listImageMode={listImageMode}
                  onListImageModeChange={handleSetListImageMode}
                  onToggleSidebar={handleToggleSidebar}
                  selectedVersionId={selectedVersionId}
                  onSelectedVersionChange={setSelectedVersionId}
                  collectionVersions={collectionVersions}
                  onOpenSettings={handleBackToDetail}
                />
              </div>
              <div className="view-stack-page">
                {selectedGame && <GameDetail
                  gameId={selectedGame.id || selectedGame}
                  onBack={handleCloseGame}
                  onNavigate={handleNavigateGame}
                />}
              </div>
            </div>
          </div>
        )}
      </main>

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
