import { useState, useEffect } from 'react'

export default function useRouter() {
  const initialParams = new URLSearchParams(window.location.search)
  const initialGame = initialParams.has('game') && initialParams.get('game') ? { id: Number(initialParams.get('game')) } : null

  const [activeView, setActiveView] = useState(initialParams.get('view') || 'browse')
  const [activeId, setActiveId] = useState(initialParams.has('id') ? Number(initialParams.get('id')) : null)
  const [collectionSubView, setCollectionSubView] = useState(initialParams.get('sub') || 'detail')
  const [selectedGame, setSelectedGame] = useState(initialGame)

  function pushViewHistory(view, id, sub, game) {
    const params = new URLSearchParams()
    params.set('view', view)
    if (id) params.set('id', String(id))
    if (view === 'collection' && sub && sub !== 'detail') params.set('sub', sub)
    if (game?.id) params.set('game', String(game.id))
    window.history.pushState(
      { view, id: id || null, sub: sub || 'detail', game: game?.id || null },
      '',
      params.toString() ? `?${params.toString()}` : '/'
    )
  }

  // Popstate listener for browser back/forward
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const view = p.get('view') || 'browse'
    const id = p.has('id') ? Number(p.get('id')) : null
    const sub = p.get('sub') || 'detail'
    const game = p.has('game') && p.get('game') ? Number(p.get('game')) : null
    window.history.replaceState({ view, id, sub, game }, '', window.location.search)

    const onPop = (e) => {
      const s = e.state
      setActiveView(s?.view || 'browse')
      setActiveId(s?.id || null)
      setCollectionSubView(s?.sub || 'detail')
      setSelectedGame(s?.game ? { id: s.game } : null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  return {
    activeView, setActiveView,
    activeId, setActiveId,
    collectionSubView, setCollectionSubView,
    selectedGame, setSelectedGame,
    pushViewHistory,
  }
}
