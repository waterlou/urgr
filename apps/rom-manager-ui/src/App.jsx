import { useState, useEffect, useCallback } from 'react'
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
  const [totalGames, setTotalGames] = useState(0)
  const [platforms, setPlatforms] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedGame, setSelectedGame] = useState(null)
  const [showCollectionForm, setShowCollectionForm] = useState(false)
  const [showGameSetForm, setShowGameSetForm] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [viewMode, setViewMode] = useState('grid')
  const [sortField, setSortField] = useState('name')
  const [sortOrder, setSortOrder] = useState('asc')
  const [searchQuery, setSearchQuery] = useState('')
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

  const loadGames = useCallback(async (view, id, mode, sort, order, q) => {
    setLoading(true)
    try {
      if (view === 'browse') {
        const data = await getGames({ limit: 500, sort, order, q })
        setGames(data.games)
        setTotalGames(data.total)
        setActiveMeta(null)
        setPlatforms([])
      } else if (view === 'collection') {
        const data = await getCollectionGames(id, { limit: 500, sort, order, mode })
        setGames(data.games)
        setActiveMeta(data.collection)
        setPlatforms(data.platforms || [])
        setTotalGames(data.total)
      } else if (view === 'game-set') {
        const data = await getGameSetGames(id, { limit: 500, sort, order })
        setGames(data.games)
        setActiveMeta(data.game_set)
        const plats = data.game_set?.platforms ? data.game_set.platforms.split(',').filter(Boolean) : []
        setPlatforms(plats)
        setTotalGames(data.total)
      }
    } catch (e) {
      console.error('Failed to load games:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSidebar() }, [loadSidebar])

  useEffect(() => {
    loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery)
  }, [activeView, activeId, viewMode, sortField, sortOrder, searchQuery, loadGames])

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
    await loadGames(activeView, activeId, viewMode, sortField, sortOrder, searchQuery)
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
            gameSets={gameSets}
            activeId={activeId}
            showBackToDetail={activeView === 'collection'}
            onBackToDetail={() => setCollectionSubView('detail')}
          />
        )}
      </main>

      {selectedGame && <GameDetail gameId={selectedGame.id || selectedGame} onClose={() => setSelectedGame(null)} />}

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
