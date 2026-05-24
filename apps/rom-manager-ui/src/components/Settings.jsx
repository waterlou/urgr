import { useState, useEffect } from 'react'
import { getSettings, saveSettings } from '../api.js'

const PROVIDER_TABS = [
  {
    id: 'screenscraper',
    label: 'ScreenScraper',
    fields: [
      { key: 'SS_DEVID', label: 'Dev ID', type: 'text', required: true },
      { key: 'SS_DEVPASSWORD', label: 'Dev Password', type: 'password', required: true },
      { key: 'SS_USERNAME', label: 'Username', type: 'text' },
      { key: 'SS_PASSWORD', label: 'Password', type: 'password' },
    ],
  },
  {
    id: 'igdb',
    label: 'IGDB (Twitch)',
    fields: [
      { key: 'IGDB_CLIENT_ID', label: 'Client ID', type: 'text', required: true },
      { key: 'IGDB_CLIENT_SECRET', label: 'Client Secret', type: 'password', required: true },
    ],
  },
  {
    id: 'thegamesdb',
    label: 'TheGamesDB',
    fields: [
      { key: 'TGDB_API_KEY', label: 'API Key', type: 'password', required: true },
    ],
  },
]

const SOURCE_OPTIONS = [
  { value: '', label: 'All providers (no default)' },
  { value: 'screenscraper', label: 'ScreenScraper' },
  { value: 'igdb', label: 'IGDB' },
  { value: 'thegamesdb', label: 'TheGamesDB' },
]

export default function Settings({ onClose }) {
  const [values, setValues] = useState({ SCRAPER_SOURCE: 'screenscraper' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [activeTab, setActiveTab] = useState('screenscraper')

  useEffect(() => {
    getSettings().then(data => {
      setValues(prev => ({ ...prev, ...data }))
    }).catch(e => {
      console.error('Settings load error:', e)
      setMessage({ type: 'error', text: 'Failed to load settings. Make sure the server is running with the latest code. (' + e.message + ')' })
    })
  }, [])

  function setValue(key, val) {
    setValues(prev => ({ ...prev, [key]: val }))
  }

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    try {
      await saveSettings(values)
      setMessage({ type: 'success', text: 'Settings saved. Restart scraper-cli for changes to take effect.' })
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to save: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  const activeProvider = PROVIDER_TABS.find(t => t.id === activeTab)

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close-btn" onClick={onClose}><span className="icon">close</span></button>
        </div>

        <div className="settings-tabs">
          {PROVIDER_TABS.map(tab => (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {activeProvider && (
            <div className="settings-provider-fields">
              {activeProvider.fields.map(field => (
                <label key={field.key} className="settings-field">
                  <span className="settings-field-label">
                    {field.label}
                    {field.required && <span className="settings-required">*</span>}
                  </span>
                  <input
                    type={field.type}
                    value={values[field.key] || ''}
                    onChange={e => setValue(field.key, e.target.value)}
                    placeholder={field.required ? `Enter ${field.label}` : `Optional: ${field.label}`}
                    className="settings-input"
                  />
                </label>
              ))}
            </div>
          )}

          <div className="settings-section">
            <h3>Default Scraper Source</h3>
            <p className="settings-hint">
              Sets the <code>SCRAPER_SOURCE</code> environment variable used by scraper-cli
              when <code>--source</code> is not provided.
            </p>
            <select
              className="settings-select"
              value={values['SCRAPER_SOURCE'] || ''}
              onChange={e => setValue('SCRAPER_SOURCE', e.target.value)}
            >
              {SOURCE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {message && (
            <div className={`settings-message ${message.type}`}>
              {message.text}
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button className="settings-btn settings-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="settings-btn settings-btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
