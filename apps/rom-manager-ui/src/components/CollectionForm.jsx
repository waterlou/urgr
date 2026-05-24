import { useState, useRef } from 'react'
import { importDat } from '../api.js'

export default function CollectionForm({ datasets, platforms, versions, editTarget, onSave, onClose }) {
  const isEdit = !!editTarget

  // Fallback presets if API data is empty
  const popularPresets = (datasets?.popular?.length ? datasets.popular : [
    { name: 'MAME', slug: 'mame', platform: 'Arcade' },
    { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
  ])
  const [name, setName] = useState(editTarget?.name || '')
  const [slug, setSlug] = useState(editTarget?.slug || '')
  const [platform, setPlatform] = useState(editTarget?.platform || '')
  const [logo, setLogo] = useState(editTarget?.logo || '')
  const [suggestions, setSuggestions] = useState(false)
  const [datasetMode, setDatasetMode] = useState(
    editTarget ? (editTarget.has_dataset ? 'preset' : 'manual') : 'manual'
  )
  const [selectedPreset, setSelectedPreset] = useState(null)
  const [datFile, setDatFile] = useState(null)
  const [datFileName, setDatFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [formError, setFormError] = useState('')
  const fileRef = useRef()

  function handleNameChange(e) {
    const val = e.target.value
    setName(val)
    if (!isEdit) setSlug(val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    if (val.length > 0) {
      const matched = popularPresets.filter(d =>
        d.name.toLowerCase().includes(val.toLowerCase())
      )
      setSuggestions(matched.length > 0 ? matched : false)
    } else {
      setSuggestions(false)
    }
  }

  function selectDataset(ds) {
    setSelectedPreset(ds)
    setDatasetMode('preset')
    setName(ds.name)
    setSlug(ds.slug)
    setPlatform(ds.platform)
    setSuggestions(false)
  }

  function handlePresetChange(e) {
    const ds = popularPresets.find(d => d.name === e.target.value)
    setSelectedPreset(ds || null)
    if (ds) {
      setName(ds.name)
      setSlug(ds.slug)
      setPlatform(ds.platform)
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files[0]
    if (!file) return
    setDatFile(file)
    setDatFileName(file.name)
    // Suggest name from filename
    if (!name) {
      const base = file.name.replace(/\.dat$/i, '').replace(/[_-]/g, ' ')
      setName(base)
      setSlug(base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')
    if (!name) { setFormError('Collection name is required'); return }
    if (datasetMode === 'preset' && !selectedPreset) { setFormError('Select a preset dataset or choose Manual mode'); return }

    let hasDataset = 0
    let datasetPreset = null
    let uploadedVersionId = null

    if (datasetMode === 'preset' && selectedPreset) {
      hasDataset = 1
      datasetPreset = selectedPreset.name
    } else if (datasetMode === 'upload' && datFile) {
      setUploading(true)
      try {
        const text = await datFile.text()
        const data = await importDat(text)
        uploadedVersionId = data.version_id
        hasDataset = 1
      } catch (e) {
        alert('Failed to upload DAT file: ' + e.message)
        setUploading(false)
        return
      }
    }

    try {
      await onSave({
        name,
        slug,
        platform,
        logo: logo || '📁',
        folder: slug,
        has_dataset: hasDataset,
        dataset_preset: datasetPreset,
        uploaded_version_id: uploadedVersionId,
      })
    } catch (e) {
      setFormError(e.message || 'Failed to save collection')
      setUploading(false)
    }
  }

  const LOGO_OPTIONS = ['🎮', '🕹️', '💿', '🔥', '📀', '🖥️', '🎯', '⭐', '👾', '🏆']

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content form-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="form-title">{isEdit ? 'Edit Collection' : 'New Collection'}</h2>
        <form onSubmit={handleSubmit} className="collection-form">
          <div className="form-group">
            <label>Collection Name</label>
            <input type="text" value={name} onChange={handleNameChange} placeholder="e.g. MAME 0.287" required />
            {suggestions && (
              <div className="form-suggestions">
                {suggestions.map(ds => (
                  <button type="button" key={ds.name} className="suggestion-item" onClick={() => selectDataset(ds)}>
                    <strong>{ds.name}</strong>
                    <span className="suggestion-desc">{ds.platform}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Slug (folder name)</label>
            <input type="text" value={slug} onChange={e => setSlug(e.target.value)} placeholder="mame-0287" required />
          </div>

          {!isEdit && (
            <div className="form-divider">
              <span>Dataset</span>
            </div>
          )}

          {!isEdit && (
            <div className="dataset-modes">
              <label className={`dataset-mode ${datasetMode === 'manual' ? 'active' : ''}`}>
                <input type="radio" name="datasetMode" value="manual" checked={datasetMode === 'manual'}
                  onChange={() => setDatasetMode('manual')} />
                <span className="mode-icon">📂</span>
                <span className="mode-label">Manual</span>
                <span className="mode-desc">No hash checking, just browse ROMs</span>
              </label>
              <label className={`dataset-mode ${datasetMode === 'preset' ? 'active' : ''}`}>
                <input type="radio" name="datasetMode" value="preset" checked={datasetMode === 'preset'}
                  onChange={() => setDatasetMode('preset')} />
                <span className="mode-icon">📦</span>
                <span className="mode-label">Preset Dataset</span>
                <span className="mode-desc">MAME, FinalBurn, No-Intro, etc.</span>
              </label>
              <label className={`dataset-mode ${datasetMode === 'upload' ? 'active' : ''}`}>
                <input type="radio" name="datasetMode" value="upload" checked={datasetMode === 'upload'}
                  onChange={() => setDatasetMode('upload')} />
                <span className="mode-icon">📄</span>
                <span className="mode-label">Upload DAT</span>
                <span className="mode-desc">Import your own .dat file</span>
              </label>
            </div>
          )}

          {datasetMode === 'preset' && !isEdit && (
            <div className="form-group">
              <label>Select Preset Dataset</label>
              <select value={selectedPreset?.name || ''} onChange={handlePresetChange}>
                <option value="">— Choose a preset —</option>
                {popularPresets.map(ds => (
                  <option key={ds.name} value={ds.name}>{ds.name} ({ds.platform})</option>
                ))}
              </select>
            </div>
          )}

          {datasetMode === 'upload' && !isEdit && (
            <div className="form-group">
              <label>Upload DAT File</label>
              <div className="file-upload-area">
                <input type="file" ref={fileRef} accept=".dat,.txt,.xml" onChange={handleFileSelect} hidden />
                <button type="button" className="btn btn-secondary" onClick={() => fileRef.current.click()}>
                  {datFile ? 'Change File' : 'Choose File'}
                </button>
                {datFileName && <span className="file-name">{datFileName}</span>}
              </div>
            </div>
          )}

          {datasetMode === 'manual' && !isEdit && (
            <div className="form-group">
              <label>Platform</label>
              <select value={platform} onChange={e => setPlatform(e.target.value)}>
                <option value="">None</option>
                {platforms.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}

          <div className="form-group">
            <label>Logo / Icon</label>
            <div className="logo-picker">
              {LOGO_OPTIONS.map(ic => (
                <button type="button" key={ic}
                  className={`logo-option ${logo === ic ? 'active' : ''}`}
                  onClick={() => setLogo(ic)}>{ic}</button>
              ))}
            </div>
          </div>

          {formError && <div className="notification error">{formError}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={uploading}>
              {uploading ? 'Uploading...' : isEdit ? 'Save' : 'Create Collection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
