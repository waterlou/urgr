import { useState } from 'react'
import IconDisplay from './IconDisplay.jsx'

export default function GameSetForm({ platforms, editTarget, onSave, onClose }) {
  const isEdit = !!editTarget
  const [name, setName] = useState(editTarget?.name || '')
  const [description, setDescription] = useState(editTarget?.description || '')
  const [selectedPlatforms, setSelectedPlatforms] = useState(
    editTarget?.platforms ? editTarget.platforms.split(',').filter(Boolean) : []
  )
  const [icon, setIcon] = useState(editTarget?.icon || '')

  function togglePlatform(p) {
    setSelectedPlatforms(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    )
  }

  function handleSubmit(e) {
    e.preventDefault()
    if (!name) return
    onSave({
      name,
      description,
      platforms: selectedPlatforms.join(','),
      icon: icon || 'inventory_2',
    })
  }

  const ICON_OPTIONS = ['inventory_2', 'ads_click', 'emoji_events', 'star', 'diamond', 'local_fire_department', 'diversity_3', 'palette', 'playing_cards', 'rainbow']

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content form-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><span className="icon">close</span></button>
        <h2 className="form-title">{isEdit ? 'Edit Game Set' : 'New Game Set'}</h2>
        <form onSubmit={handleSubmit} className="collection-form">
          <div className="form-group">
            <label>Game Set Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Best of Arcade" required />
          </div>

          <div className="form-group">
            <label>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" rows={3} />
          </div>

          <div className="form-group">
            <label>Platforms</label>
            <div className="platform-picker">
              {platforms.map(p => (
                <button
                  type="button"
                  key={p}
                  className={`platform-chip ${selectedPlatforms.includes(p) ? 'active' : ''}`}
                  onClick={() => togglePlatform(p)}
                >{p}</button>
              ))}
              {selectedPlatforms.length === 0 && <span className="form-hint">Select the platforms this game set supports</span>}
            </div>
          </div>

          <div className="form-group">
            <label>Icon</label>
            <div className="logo-picker">
              {ICON_OPTIONS.map(ic => (
                <button
                  type="button"
                  key={ic}
                  className={`logo-option ${icon === ic ? 'active' : ''}`}
                  onClick={() => setIcon(ic)}
                ><IconDisplay name={ic} className="" /></button>
              ))}
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEdit ? 'Save' : 'Create Game Set'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
