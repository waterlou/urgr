import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  getCollections, createCollection, updateCollection, deleteCollection,
  getGameSets, getCollectionGames, getGameSetGames, addGameSetGames, removeGameSetGame,
  getVersions, getGames, addCollectionVersion, removeCollectionVersion,
  getDownloadQueue, getOperations,
} from '../api.js';

const CollectionContext = createContext(null);

const PAGE_SIZE = 120;

export function CollectionProvider({ children }) {
  const [collections, setCollections] = useState([]);
  const [gameSets, setGameSets] = useState([]);
  const [versions, setVersions] = useState([]);
  const [games, setGames] = useState([]);
  const [offset, setOffset] = useState(0);
  const [totalGames, setTotalGames] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [activeMeta, setActiveMeta] = useState(null);
  const [queueCount, setQueueCount] = useState(0);
  const [operationCount, setOperationCount] = useState(0);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [collectionVersions, setCollectionVersions] = useState([]);
  const loadingMoreRef = useRef(false);

  const loadSidebar = useCallback(async () => {
    try {
      const [cols, sets, vers, dq, ops] = await Promise.all([
        getCollections(), getGameSets ? getGameSets() : [], getVersions(),
        getDownloadQueue().catch(() => ({ queue: [] })),
        getOperations().catch(() => []),
      ]);
      setCollections(cols || []);
      setGameSets(sets || []);
      setVersions(vers || []);
      setQueueCount((dq.queue || []).filter(i => i.status === 'pending' || i.status === 'downloading').length);
      setOperationCount((ops || []).filter(o => o.status === 'running' || o.status === 'pending').length);
    } catch (e) {
      console.error('[loadSidebar] FAILED:', e);
    }
  }, []);

  const loadGames = useCallback(async (view, id, sortField, sortOrder, searchQuery, parentsOnly, favouritesOnly, romsOnly, versionFilter, collectionSubView, yearFilter, manufacturerFilter, platformFilter, regionFilter) => {
    setLoading(true);
    setOffset(0);
    try {
      let data;
      const common = { limit: PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery,
        parents_only: parentsOnly ? 'true' : undefined,
        favourites_only: favouritesOnly ? 'true' : undefined,
        roms_only: romsOnly ? 'true' : undefined,
        year: yearFilter || undefined,
        manufacturer: manufacturerFilter || undefined,
        platform: platformFilter || undefined,
        region: regionFilter || undefined,
      };
      if (view === 'browse') {
        data = await getGames(common);
      } else if (view === 'collection') {
        data = await getCollectionGames(id, { ...common, version_id: versionFilter || undefined });
        setCollectionVersions(data?.versions || []);
      } else if (view === 'game-set') {
        data = await getGameSetGames(id, { limit: PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery });
      }
      if (data) {
        setGames(data.games || []);
        setActiveMeta(data.collection ? { ...data.collection, platforms: data.platforms, regions: data.regions } : data.game_set || null);
        setTotalGames(data.total || 0);
        setHasMore((data.games || []).length < (data.total || 0));
      }
    } catch (e) {
      console.error('Failed to load games:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async (view, id, sortField, sortOrder, searchQuery, parentsOnly, favouritesOnly, romsOnly, versionFilter, yearFilter, manufacturerFilter, platformFilter, regionFilter) => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoading(true);
    try {
      let data;
      const common = { limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery,
        parents_only: parentsOnly ? 'true' : undefined,
        favourites_only: favouritesOnly ? 'true' : undefined,
        roms_only: romsOnly ? 'true' : undefined,
        year: yearFilter || undefined,
        manufacturer: manufacturerFilter || undefined,
        platform: platformFilter || undefined,
        region: regionFilter || undefined,
      };
      if (view === 'browse') {
        data = await getGames(common);
      } else if (view === 'collection') {
        data = await getCollectionGames(id, { ...common, version_id: versionFilter || undefined });
      } else if (view === 'game-set') {
        data = await getGameSetGames(id, { limit: PAGE_SIZE, offset: offset + PAGE_SIZE, sort: sortField, order: sortOrder, q: searchQuery });
      }
      if (data) {
        setOffset(p => p + PAGE_SIZE);
        setGames(p => [...p, ...(data.games || [])]);
        setHasMore((data.games || []).length === PAGE_SIZE);
      }
    } catch (e) {
      console.error('Failed to load more games:', e);
    } finally {
      setLoading(false);
      loadingMoreRef.current = false;
    }
  }, [offset, hasMore]);

  const handleCreateCollection = useCallback(async (data) => {
    await createCollection(data);
    await loadSidebar();
    return true;
  }, [loadSidebar]);

  const handleDeleteCollection = useCallback(async (id) => {
    await deleteCollection(id);
    await loadSidebar();
  }, [loadSidebar]);

  const handleCreateGameSet = useCallback(async (data) => {
    await createGameSet(data);
    await loadSidebar();
    return true;
  }, [loadSidebar]);

  const handleDeleteGameSet = useCallback(async (id) => {
    await deleteGameSet(id);
    await loadSidebar();
  }, [loadSidebar]);

  const handleSaveCollection = useCallback(async (data, editTargetId) => {
    let col;
    if (editTargetId) {
      await updateCollection(editTargetId, data);
    } else {
      col = await createCollection(data);
    }
    await loadSidebar();
    return col;
  }, [loadSidebar]);

  const handleSaveGameSet = useCallback(async (data, editTargetId) => {
    if (editTargetId) {
      await updateGameSet(editTargetId, data);
    } else {
      await createGameSet(data);
    }
    await loadSidebar();
  }, [loadSidebar]);

  const handleAddToGameSet = useCallback(async (gameEntryId, setId) => {
    await addGameSetGames(setId, [gameEntryId]);
  }, []);

  const handleRemoveFromGameSet = useCallback(async (gameEntryId, setId) => {
    await removeGameSetGame(setId, gameEntryId);
  }, []);

  function handleUpdateGame(gameId, patch) {
    setGames(prev => prev.map(g => g.id === gameId ? { ...g, ...patch } : g));
  }

  useEffect(() => { loadSidebar(); }, [loadSidebar]);

  return (
    <CollectionContext.Provider value={{
      collections, gameSets, versions, games, offset, totalGames, hasMore,
      loading, activeMeta, queueCount, operationCount,
      selectedVersionId, collectionVersions,
      setSelectedVersionId, setGames, setOffset, setHasMore,
      loadSidebar, loadGames, loadMore,
      createCollection: handleCreateCollection,
      deleteCollection: handleDeleteCollection,
      createGameSet: handleCreateGameSet,
      deleteGameSet: handleDeleteGameSet,
      saveCollection: handleSaveCollection,
      saveGameSet: handleSaveGameSet,
      addToGameSet: handleAddToGameSet,
      removeFromGameSet: handleRemoveFromGameSet,
      updateGame: handleUpdateGame,
    }}>
      {children}
    </CollectionContext.Provider>
  );
}

export function useCollections() {
  return useContext(CollectionContext);
}
