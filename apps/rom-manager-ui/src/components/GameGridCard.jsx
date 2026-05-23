import { useState } from 'react'
import { coverUrl } from '../api.js'

export default function GameGridCard({ game, onSelect, onRating, onFavourite, onAddToGameSet, gameSets, currentGameSetId }) {
  const [showMenu, setShowMenu] = useState(false)

  function handleClickStars(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const star = Math.ceil((x / rect.width) * 5);
    onRating(Math.min(star, 5));
  }

  return (
    <div className="grid-card" onClick={() => onSelect(game)}>
      <div className="grid-card-image">
        <img src={coverUrl(game.id)} alt={game.name} loading="lazy" />
        <div className="grid-card-overlay">
          <div className="grid-card-actions" onClick={e => e.stopPropagation()}>
            <button
              className={`fav-btn ${game.favourite ? 'active' : ''}`}
              onClick={onFavourite}
              title={game.favourite ? 'Unfavourite' : 'Favourite'}
            >
              {game.favourite ? '★' : '☆'}
            </button>
            {onAddToGameSet && gameSets.length > 0 && (
              <div className="add-to-set-wrapper" onMouseEnter={() => setShowMenu(true)} onMouseLeave={() => setShowMenu(false)}>
                <button className="add-set-btn" title="Add to Game Set">+</button>
                {showMenu && (
                  <div className="add-to-set-menu">
                    {gameSets.filter(gs => gs.id !== currentGameSetId).map(gs => (
                      <button key={gs.id} onClick={() => onAddToGameSet(game.id, gs.id)}>
                        {gs.icon || '📦'} {gs.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="grid-card-info">
        <div className="grid-card-name">{game.name}</div>
        <div className="grid-card-sub">
          {game.year && <span>{game.year}</span>}
          {game.source && <span className="grid-card-source">{game.source}</span>}
        </div>
        <div className="grid-card-rating" onClick={e => e.stopPropagation()}>
          <div className="stars" onClick={handleClickStars}>
            {[1, 2, 3, 4, 5].map(i => (
              <span key={i} className={`star ${i <= (game.rating || 0) ? 'filled' : ''}`}>★</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
