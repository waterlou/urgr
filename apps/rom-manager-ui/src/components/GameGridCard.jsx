import { useState, useEffect, useRef } from 'react'
import { coverUrl } from '../api.js'
import IconDisplay from './IconDisplay.jsx'

export default function GameGridCard({ game, onSelect, onRating, onFavourite, onAddToGameSet, onRemoveFromGameSet, gameSets, gameSetId, listImageMode }) {
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  function handleClickStars(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const star = Math.ceil((x / rect.width) * 5);
    onRating(Math.min(star, 5));
  }

  const isGameSetView = gameSetId != null

  const useScreenshot = listImageMode === 'screenshot' && game.screenshots?.length > 0
  const imgUrl = listImageMode === 'none' ? null : useScreenshot ? (() => { let u = game.screenshots[0]; if (u.startsWith('//')) u = 'https:' + u; return u; })() : coverUrl(game.id)

  return (
    <div className="grid-card" onClick={() => onSelect(game)}>
      <div className={`grid-card-image${listImageMode === 'screenshot' ? ' grid-card-image-screenshot' : ''}`}>
        {imgUrl ? <img src={imgUrl} alt={game.name} loading="lazy" /> : <div className="grid-card-no-image"><span className="icon">image_not_supported</span></div>}
        <div className="grid-card-overlay">
          <div className="grid-card-actions" onClick={e => e.stopPropagation()}>
            <button
              className={`fav-btn ${game.favourite ? 'active' : ''}`}
              onClick={onFavourite}
              title={game.favourite ? 'Unfavourite' : 'Favourite'}
            >
              <span className={`icon ${game.favourite ? 'icon-fill' : ''}`}>star</span>
            </button>
            {gameSets.length > 0 && (
              <div className="add-to-set-wrapper" ref={menuRef}>
                <button className="add-set-btn" onClick={() => setShowMenu(v => !v)} title={isGameSetView ? 'Remove from Set' : 'Add to Game Set'}><span className="icon">playlist_add</span></button>
                {showMenu && (
                  <div className="add-to-set-menu">
                    {isGameSetView ? (
                      <button className="remove-from-set-btn" onClick={() => { onRemoveFromGameSet(game.id, gameSetId); setShowMenu(false) }}>
                        <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:4}}>remove_circle</span> Remove
                      </button>
                    ) : (
                      gameSets.map(gs => (
                        <button key={gs.id} onClick={() => { onAddToGameSet(game.id, gs.id); setShowMenu(false) }}>
                          <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:4}}><IconDisplay name={gs.icon} fallback="inventory_2" /></span> {gs.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="grid-card-info">
        <div className="grid-card-name">{game.name}</div>
        {game.description && <div className="grid-card-sub">{game.description}</div>}
        <div className="grid-card-sub">
          {game.regions ? game.regions.map(r => <span key={r} className="version-tag">{r}</span>) : game.region && <span className="version-tag">{game.region}</span>}
          {(game.versions && game.versions.length > 0
            ? game.versions
            : game.source ? [game.source] : []
          ).map(v => <span key={v} className="version-tag">{v}</span>)}
        </div>
        <div className="grid-card-rating" onClick={e => e.stopPropagation()}>
          <div className="stars" onClick={handleClickStars}>
            {[1, 2, 3, 4, 5].map(i => (
              <span key={i} className={`icon star ${i <= (game.rating || 0) ? 'icon-fill' : ''}`}>star</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}