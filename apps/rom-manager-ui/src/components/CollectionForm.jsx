import { useState, useRef } from 'react'
import { importDat } from '../api.js'
import IconDisplay from './IconDisplay.jsx'

export default function CollectionForm({ datasets, platforms, versions, editTarget, onSave, onClose }) {
  const isEdit = !!editTarget

  // Fallback presets if API data is empty
  const popularPresets = (datasets?.popular?.length ? datasets.popular : [
    { name: 'MAME', slug: 'mame', platform: 'Arcade' },
    { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
    { name: 'OfflineList (No-Intro)', slug: 'offlinelist', platform: 'Console', isOfflineList: true },
    { name: 'DAT-O-MATIC', slug: 'datomatic', platform: 'Console', isDatomic: true },
    { name: 'NoPayStation', slug: 'nps', platform: 'PlayStation', isNps: true },
  ])
  const [name, setName] = useState(editTarget?.name || '')
  const [slug, setSlug] = useState(editTarget?.slug || '')
  const [folder, setFolder] = useState(editTarget?.folder || editTarget?.slug || '')
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
  const [selectedConsole, setSelectedConsole] = useState('')
  const fileRef = useRef()

  const OFFLINELIST_CONSOLES = [
    'Nintendo Gameboy',
    'Nintendo Gameboy Color',
    'Nintendo Gameboy Advance',
    'Nintendo NES - Famicom',
    'Nintendo Super NES - Super Famicom',
    'Nintendo 64',
    'Nintendo Dual Screen',
    'Nintendo Virtualboy',
    'Sega Genesis Megadrive 32X',
    'Sega Master System',
    'Sega GameGear',
    'Sega SG1000-SC3000',
    'Atari Lynx',
    'Atari 5200',
    'Atari Jaguar',
    'Bandai WonderSwan',
    'Bandai WonderSwan Color',
    'Coleco ColecoVision',
    'NEC PC Engine TurboGrafx 16',
    'SNK NeoGeo Pocket',
    'SNK NeoGeo Pocket Color',
    'GCE Vectrex',
    'Commodore 64',
    'Pokemon Mini',
  ]

  const NPS_PLATFORMS = [
    { id: 'PSV', name: 'PlayStation Vita' },
    { id: 'PS3', name: 'PlayStation 3' },
    { id: 'PSP', name: 'PlayStation Portable' },
    { id: 'PSX', name: 'PlayStation' },
    { id: 'PSM', name: 'PlayStation Mobile' },
  ]

  const DATOMATIC_SYSTEMS = [
    { id: '45', name: 'Nintendo - Nintendo Entertainment System' },
    { id: '49', name: 'Nintendo - Super Nintendo Entertainment System' },
    { id: '46', name: 'Nintendo - Game Boy' },
    { id: '47', name: 'Nintendo - Game Boy Color' },
    { id: '23', name: 'Nintendo - Game Boy Advance' },
    { id: '24', name: 'Nintendo - Nintendo 64' },
    { id: '28', name: 'Nintendo - Nintendo DS' },
    { id: '54', name: 'Nintendo - Nintendo DSi' },
    { id: '64', name: 'Nintendo - Nintendo 3DS' },
    { id: '31', name: 'Nintendo - Family Computer Disk System' },
    { id: '15', name: 'Nintendo - Virtual Boy' },
    { id: '83', name: 'Nintendo - Nintendo 64DD' },
    { id: '14', name: 'Nintendo - Pokemon Mini' },
    { id: '32', name: 'Sega - Mega Drive - Genesis' },
    { id: '26', name: 'Sega - Master System - Mark III' },
    { id: '25', name: 'Sega - Game Gear' },
    { id: '17', name: 'Sega - 32X' },
    { id: '19', name: 'Sega - SG-1000 - SC-3000' },
    { id: '88', name: 'Atari - Atari 2600' },
    { id: '1', name: 'Atari - Atari 5200' },
    { id: '74', name: 'Atari - Atari 7800' },
    { id: '2', name: 'Atari - Atari Jaguar' },
    { id: '30', name: 'Atari - Atari Lynx' },
    { id: '12', name: 'NEC - PC Engine - TurboGrafx-16' },
    { id: '13', name: 'NEC - PC Engine SuperGrafx' },
    { id: '35', name: 'SNK - NeoGeo Pocket' },
    { id: '36', name: 'SNK - NeoGeo Pocket Color' },
    { id: '50', name: 'Bandai - WonderSwan' },
    { id: '51', name: 'Bandai - WonderSwan Color' },
    { id: '7', name: 'GCE - Vectrex' },
    { id: '3', name: 'Coleco - ColecoVision' },
    { id: '42', name: 'Commodore - Commodore 64' },
    { id: '10', name: 'Microsoft - MSX' },
    { id: '11', name: 'Microsoft - MSX2' },
    { id: '105', name: 'Mattel - Intellivision' },
    { id: '6', name: 'Fairchild - Channel F' },
    { id: '22', name: 'Watara - Supervision' },
    { id: '20', name: 'Tiger - Game.com' },
    { id: '9', name: 'Magnavox - Odyssey 2' },
    { id: '33', name: 'Commodore - Plus-4' },
    { id: '34', name: 'Commodore - VIC-20' },
    { id: '40', name: 'Commodore - Amiga' },
    { id: '43', name: 'Commodore - Commodore 64 (PP)' },
  ]

  function handleNameChange(e) {
    const val = e.target.value
    setName(val)
    if (!isEdit) {
      const generated = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      setSlug(generated)
      setFolder(generated)
    }
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
    setFolder(ds.slug)
    setPlatform(ds.platform)
    setLogo(PLATFORM_ICONS[ds.name] || platformToLogo(ds.platform))
    setSuggestions(false)
  }

  function handlePresetChange(e) {
    const ds = popularPresets.find(d => d.name === e.target.value)
    setSelectedPreset(ds || null)
    setSelectedConsole('')
    if (ds) {
      setName(ds.name)
      setSlug(ds.slug)
      setFolder(ds.slug)
      setPlatform(ds.platform)
    }
  }

  function handlePresetChange(e) {
    const ds = popularPresets.find(d => d.name === e.target.value)
    setSelectedPreset(ds || null)
    setSelectedConsole('')
    if (ds) {
      setName(ds.name)
      setSlug(ds.slug)
      setFolder(ds.slug)
      setPlatform(ds.platform)
      setLogo(PLATFORM_ICONS[ds.name] || platformToLogo(ds.platform))
    }
  }

  function handleOfflineListConsoleChange(e) {
    const consoleName = e.target.value
    setSelectedConsole(consoleName)
    if (consoleName) {
      setName(`OfflineList ${consoleName}`)
      setSlug(`offlinelist-${consoleName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
      setFolder(`offlinelist-${consoleName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
      setLogo(platformToLogo(consoleName))
    }
  }

  function handleDatomicSystemChange(e) {
    const systemName = e.target.value
    setSelectedConsole(systemName)
    if (systemName) {
      setName(`DAT-O-MATIC ${systemName}`)
      setSlug(`datomatic-${systemName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
      setFolder(`datomatic-${systemName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
      setLogo(platformToLogo(systemName))
    }
  }

  function handleNpsPlatformChange(e) {
    const platformId = e.target.value
    setSelectedConsole(platformId)
    if (platformId) {
      const platform = NPS_PLATFORMS.find(p => p.id === platformId)
      setName(`NPS ${platform.name}`)
      setSlug(`nps-${platformId.toLowerCase()}`)
      setFolder(`nps-${platformId.toLowerCase()}`)
      setLogo('stadia_controller')
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
      const generated = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      setSlug(generated)
      setFolder(generated)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    if (!name) { setFormError('Collection name is required'); return }

    if (!isEdit) {
      if (datasetMode === 'preset' && !selectedPreset) { setFormError('Select a preset dataset or choose Manual mode'); return }
    }

    const payload = { name, slug, platform, logo: logo || 'folder', folder: folder || slug }

    if (!isEdit) {
      let hasDataset = 0
      let datasetPreset = null
      let uploadedVersionId = null
      if (datasetMode === 'preset' && selectedPreset) {
        payload.has_dataset = 1
        if (selectedPreset.isOfflineList) {
          payload.dataset_preset = 'OFFLINELIST'
        } else if (selectedPreset.isDatomic) {
          payload.dataset_preset = 'DATOMATIC'
        } else if (selectedPreset.isNps) {
          payload.dataset_preset = 'NPS'
          payload.nps_platform = selectedConsole
        } else {
          payload.dataset_preset = selectedPreset.name
        }
      } else if (datasetMode === 'upload' && datFile) {
        setUploading(true)
        try {
          const text = await datFile.text()
          const data = await importDat(text)
          payload.uploaded_version_id = data.version_id
          payload.has_dataset = 1
        } catch (e) {
          alert('Failed to upload DAT file: ' + e.message)
          setUploading(false)
          return
        }
      }
    }

    try {
      await onSave(payload)
    } catch (e) {
      setFormError(e.message || 'Failed to save collection')
      setUploading(false)
    }
  }

  function platformToLogo(platform) {
    const map = {
      'Arcade': 'arcade',
      'Console': 'fc',
      'PlayStation': 'ps',
      'PlayStation Vita': 'psp',
      'PlayStation 3': 'ps',
      'PlayStation Portable': 'psp',
      'PlayStation Mobile': 'ps',
      'Nintendo': 'fc',
      'Sega': 'md',
      'Dreamcast': 'dc',
      'Atari': 'atari',
      'NEC': 'pce',
      'SNK': 'neogeo',
      'Bandai': 'ws',
      'Coleco': 'col',
      'Commodore': 'c64',
      'Microsoft': 'msx',
      'Mattel': 'vectrex',
      'Fairchild': 'fairchild',
      'Watara': 'supervision',
      'Tiger': 'gamecom',
      'Magnavox': 'ody',
      'GCE': 'vectrex',
    }
    for (const [key, icon] of Object.entries(map)) {
      if (platform.toLowerCase().includes(key.toLowerCase())) return icon
    }
    return 'arcade'
  }

  const PLATFORM_ICONS = {
    'MAME': 'mame',
    'Final Burn Neo': 'mame',
    'OfflineList (No-Intro)': 'fc',
    'DAT-O-MATIC': 'fc',
    'NoPayStation': 'ps',
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content form-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><span className="icon">close</span></button>
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
            <label>Slug</label>
            <input type="text" value={slug} onChange={e => setSlug(e.target.value)} placeholder="mame-0287" required />
          </div>

          <div className="form-group">
            <label>Data folder <span className="hint">(defaults to slug)</span></label>
            <input type="text" value={folder} onChange={e => setFolder(e.target.value)} placeholder={slug} />
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
                <span className="icon mode-icon">folder_open</span>
                <span className="mode-label">Manual</span>
                <span className="mode-desc">No hash checking, just browse ROMs</span>
              </label>
              <label className={`dataset-mode ${datasetMode === 'preset' ? 'active' : ''}`}>
                <input type="radio" name="datasetMode" value="preset" checked={datasetMode === 'preset'}
                  onChange={() => setDatasetMode('preset')} />
                <span className="icon mode-icon">inventory_2</span>
                <span className="mode-label">Preset Dataset</span>
                <span className="mode-desc">MAME, FinalBurn, No-Intro, etc.</span>
              </label>
              <label className={`dataset-mode ${datasetMode === 'upload' ? 'active' : ''}`}>
                <input type="radio" name="datasetMode" value="upload" checked={datasetMode === 'upload'}
                  onChange={() => setDatasetMode('upload')} />
                <span className="icon mode-icon">description</span>
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

          {datasetMode === 'preset' && selectedPreset?.isOfflineList && !isEdit && (
            <div className="form-group">
              <label>Select Console</label>
              <select value={selectedConsole} onChange={handleOfflineListConsoleChange}>
                <option value="">— Choose a console —</option>
                {OFFLINELIST_CONSOLES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {datasetMode === 'preset' && selectedPreset?.isDatomic && !isEdit && (
            <div className="form-group">
              <label>Select System</label>
              <select value={selectedConsole} onChange={handleDatomicSystemChange}>
                <option value="">— Choose a system —</option>
                {DATOMATIC_SYSTEMS.map(s => (
                  <option key={s.id} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {datasetMode === 'preset' && selectedPreset?.isNps && !isEdit && (
            <div className="form-group">
              <label>Select Platform</label>
              <select value={selectedConsole} onChange={handleNpsPlatformChange}>
                <option value="">— Choose a platform —</option>
                {NPS_PLATFORMS.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
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
              <select value={platform} onChange={e => { setPlatform(e.target.value); setLogo(platformToLogo(e.target.value)) }}>
                <option value="">None</option>
                {platforms.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}

          <div className="form-group">
            <label>Logo / Icon</label>
            <div className="logo-picker">
              {['arcade', 'mame', 'fc', 'sfc', 'n64', 'gb', 'gbc', 'gba', 'nds', 'vb', 'md', 'ms', 'gg', '32X', 'segacd', 'dc', 'ps', 'psp', 'neogeo', 'ngp', 'ngpc', 'pce', 'ws', 'wsc', 'atari', 'lynx', 'vectrex', 'col', 'msx', 'c64', 'amiga', 'zxs', 'x68000', 'dos'].map(ic => (
                <button type="button" key={ic}
                  className={`logo-option ${logo === ic ? 'active' : ''}`}
                  onClick={() => setLogo(ic)}><IconDisplay name={ic} size={20} /></button>
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
