import { coverUrl } from '../api.js'

export default function GameListItem({ game, onSelect, onRating, onFavourite }) {
  function handleClickStars(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const star = Math.ceil((x / rect.width) * 5);
    onRating(Math.min(star, 5));
  }

  return (
    <div className="list-item" onClick={() => onSelect(game)}>
      <span className="list-col-name">
        <img src={coverUrl(game.id)} alt="" className="list-thumb" loading="lazy" onError={e => { e.target.style.display = 'none' }} />
        <span className="list-name-text">{game.description || game.name}</span>
        {game.description && <span className="list-desc">{game.name}</span>}
      </span>
      <span className="list-col-platform">
        {game.versions && game.versions.length > 0
          ? game.versions.map(v => <span key={v} className="version-tag">{v}</span>)
          : <span className="version-tag">{game.source || '-'}</span>}
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
    </div>
  )
}
