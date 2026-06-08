import { useState, useEffect, useRef } from 'react'
import { coverUrl } from '../api.js'
import IconDisplay from './IconDisplay.jsx'

export default function GameListItem({ game, onSelect, onRating, onFavourite, onAddToGameSet, onRemoveFromGameSet, gameSets, gameSetId, listImageMode }) {
  const [showSetMenu, setShowSetMenu] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!showSetMenu) return
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowSetMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSetMenu])

  function handleClickStars(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const star = Math.ceil((x / rect.width) * 5);
    onRating(Math.min(star, 5));
  }

  const isGameSetView = gameSetId != null

  const useScreenshot = listImageMode === 'screenshot' && game.screenshots?.length > 0
  function getGameImage() {
    if (listImageMode === 'none') return null
    if (useScreenshot) {
      let url = game.screenshots[0]
      if (url.startsWith('//')) url = 'https:' + url
      return url
    }
    return coverUrl(game.id)
  }
  const imgUrl = getGameImage()

  return (
    <div className="list-item" onClick={() => onSelect(game)}>
      <span className="list-col-name">
        {imgUrl && <img src={imgUrl} alt="" className={`list-thumb${useScreenshot ? ' list-thumb-screenshot' : ''}`} loading="lazy" onError={e => { e.target.style.display = 'none' }} />}
        <span className="list-name-text">{game.name}</span>
        {game.description && <span className="list-desc">{game.description}</span>}
      </span>
      <span className="list-col-platform">
        {game.versions && game.versions.length > 0
          ? game.versions.map(v => <span key={v} className="version-tag">{v}</span>)
          : <span className="version-tag">{game.source || '-'}</span>}
        {game.year && game.year.split(/,\s*/).map(r => <span key={r} className="version-tag">{r}</span>)}
      </span>
      <span className="list-col-year">{game.year || '-'}</span>
      <span className="list-col-rating" onClick={e => e.stopPropagation()}>
        <div className="stars stars-sm" onClick={handleClickStars}>
          {[1, 2, 3, 4, 5].map(i => (
            <span key={i} className={`icon star ${i <= (game.rating || 0) ? 'icon-fill' : ''}`}>star</span>
          ))}
        </div>
      </span>
      <span className="list-col-fav" onClick={e => { e.stopPropagation(); onFavourite() }}>
        <span className={`icon fav-star ${game.favourite ? 'active icon-fill' : ''}`}>star</span>
      </span>
      {gameSets.length > 0 && (
        <span className="list-col-addset" onClick={e => e.stopPropagation()}>
          <div className="list-add-to-set-wrapper" ref={menuRef}>
            <button className="list-add-set-btn" onClick={() => setShowSetMenu(v => !v)} title={isGameSetView ? 'Remove from Set' : 'Add to Game Set'}><span className="icon icon-sm">playlist_add</span></button>
            {showSetMenu && (
              <div className="list-add-to-set-menu">
                {isGameSetView ? (
                  <button className="remove-from-set-btn" onClick={() => { onRemoveFromGameSet(game.id, gameSetId); setShowSetMenu(false) }}>
                    <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:4}}>remove_circle</span> Remove
                  </button>
                ) : (
                  gameSets.map(gs => (
                    <button key={gs.id} onClick={() => { onAddToGameSet?.(game.id, gs.id); setShowSetMenu(false) }}>
                      <span className="icon icon-sm" style={{verticalAlign:'middle',marginRight:4}}><IconDisplay name={gs.icon} fallback="inventory_2" /></span> {gs.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </span>
      )}
    </div>
  )
}