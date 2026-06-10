import { useState, useEffect } from 'react'
import { getSettings, saveSettings, testIgdbConnection, testTgdbConnection } from '../api.js'

const PROVIDER_TABS = [
  {
    id: 'igdb',
    label: 'IGDB (Twitch)',
    fields: [
      { key: 'IGDB_CLIENT_ID', label: 'Client ID', type: 'text', required: true },
      { key: 'IGDB_CLIENT_SECRET', label: 'Client Secret', type: 'password', required: true },
    ],
    instructions: (
      <p className="settings-hint">
        Get your credentials from the{' '}
        <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener noreferrer">Twitch Developer Portal</a>.
        Create an app, then copy the <strong>Client ID</strong> and generate a <strong>Client Secret</strong>.
      </p>
    ),
  },
  {
    id: 'thegamesdb',
    label: 'TheGamesDB',
    fields: [
      { key: 'TGDB_API_KEY', label: 'API Key', type: 'password', placeholder: 'Default key active — enter to override' },
    ],
  },
  {
    id: 'ia',
    label: 'Internet Archive',
    fields: [
      { key: 'IA_USERNAME', label: 'Email', type: 'text', required: true },
      { key: 'IA_PASSWORD', label: 'Password', type: 'password', required: true },
    ],
    instructions: (
      <p className="settings-hint">
        Required for downloading access-restricted ROM files from Internet Archive.
        Enter your <strong>archive.org</strong> email and password.
        Saved credentials are loaded on server startup.
      </p>
    ),
  },
]

const SOURCE_OPTIONS = [
  { value: '', label: 'All providers (no default)' },
  { value: 'thegamesdb', label: 'TheGamesDB' },
  { value: 'screenscraper', label: 'ScreenScraper' },
  { value: 'igdb', label: 'IGDB' },
]

export default function Settings({ onClose }) {
  const [values, setValues] = useState({ SCRAPER_SOURCE: 'thegamesdb' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [activeTab, setActiveTab] = useState('screenscraper')
  const [testResults, setTestResults] = useState({})

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

  async function handleTest() {
    setTestResults(prev => ({ ...prev, [activeTab]: { testing: true } }))
    try {
      let result
      if (activeTab === 'igdb') {
        result = await testIgdbConnection(values.IGDB_CLIENT_ID, values.IGDB_CLIENT_SECRET)
      } else if (activeTab === 'thegamesdb') {
        result = await testTgdbConnection(values.TGDB_API_KEY)
      }
      setTestResults(prev => ({ ...prev, [activeTab]: { ok: result.ok, error: result.error || null } }))
    } catch (e) {
      setTestResults(prev => ({ ...prev, [activeTab]: { ok: false, error: e.message } }))
    }
  }

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    try {
      await saveSettings(values)
      setMessage({ type: 'success', text: 'Settings saved.' })
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to save: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  const activeProvider = PROVIDER_TABS.find(t => t.id === activeTab)
  const testResult = testResults[activeTab]

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
              onClick={() => { setActiveTab(tab.id); setTestResults(prev => ({ ...prev, [tab.id]: undefined })) }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {activeProvider && (
            <div className="settings-provider-fields">
              {activeProvider.instructions}
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
                    placeholder={field.placeholder || (field.required ? `Enter ${field.label}` : `Optional: ${field.label}`)}
                    className="settings-input"
                  />
                </label>
              ))}
              {(activeTab === 'igdb' || activeTab === 'thegamesdb') && (
                <div className="settings-test-row">
                  <button className="settings-btn settings-btn-secondary" onClick={handleTest} disabled={testResult?.testing}>
                    {testResult?.testing ? 'Testing...' : 'Test Connection'}
                  </button>
                  {testResult && !testResult.testing && (
                    <span className={`settings-test-result ${testResult.ok ? 'success' : 'error'}`}>
                      {testResult.ok ? <><span className="icon">check_circle</span> Connected</> : <><span className="icon">error</span> {testResult.error}</>}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab !== 'ia' && (
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
          )}

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
