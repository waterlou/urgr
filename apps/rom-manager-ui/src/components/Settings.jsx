import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  Tabs, Tab, Box, Typography, CircularProgress, Alert, Select, MenuItem,
  FormControl, InputLabel,
} from '@mui/material';
import {
  getSettings, saveSettings, testIgdbConnection, testTgdbConnection,
} from '../api.js';
import { useUI } from '../contexts/UIContext.jsx';

export default function Settings() {
  const { closeSettings } = useUI();
  const [activeTab, setActiveTab] = useState(0);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [testResults, setTestResults] = useState({});

  useEffect(() => {
    getSettings().then(setValues).catch(() => {});
  }, []);

  function set(field, v) {
    setValues(p => ({ ...p, [field]: v }));
  }

  async function handleSave() {
    setSaving(true); setMessage(null);
    try {
      await saveSettings(values);
      setMessage({ severity: 'success', text: 'Settings saved' });
    } catch (e) {
      setMessage({ severity: 'error', text: e.message });
    } finally { setSaving(false); }
  }

  async function testIGDB() {
    try {
      await testIgdbConnection(values.IGDB_CLIENT_ID, values.IGDB_CLIENT_SECRET);
      setTestResults(p => ({ ...p, igdb: 'ok' }));
    } catch (e) {
      setTestResults(p => ({ ...p, igdb: e.message }));
    }
  }

  async function testTGDB() {
    try {
      await testTgdbConnection(values.TGDB_API_KEY);
      setTestResults(p => ({ ...p, tgdb: 'ok' }));
    } catch (e) {
      setTestResults(p => ({ ...p, tgdb: e.message }));
    }
  }

  return (
    <Dialog open maxWidth="sm" fullWidth onClose={closeSettings}>
      <DialogTitle>Settings</DialogTitle>
      <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)} sx={{ px: 2 }}>
        <Tab label="ScreenScraper" />
        <Tab label="IGDB" />
        <Tab label="TheGamesDB" />
        <Tab label="Internet Archive" />
      </Tabs>
      <DialogContent>
        {message && <Alert severity={message.severity} sx={{ mb: 2 }}>{message.text}</Alert>}

        {activeTab === 0 && (
          <Box>
            <TextField label="Dev ID" fullWidth value={values.SS_DEVID || ''} onChange={e => set('SS_DEVID', e.target.value)} sx={{ mb: 2 }} />
            <TextField label="Dev Password" fullWidth type="password" value={values.SS_DEVPASSWORD || ''} onChange={e => set('SS_DEVPASSWORD', e.target.value)} sx={{ mb: 2 }} />
            <TextField label="Username (optional)" fullWidth value={values.SS_USERNAME || ''} onChange={e => set('SS_USERNAME', e.target.value)} sx={{ mb: 2 }} />
            <TextField label="Password (optional)" fullWidth type="password" value={values.SS_PASSWORD || ''} onChange={e => set('SS_PASSWORD', e.target.value)} sx={{ mb: 2 }} />
          </Box>
        )}

        {activeTab === 1 && (
          <Box>
            <TextField label="Client ID" fullWidth value={values.IGDB_CLIENT_ID || ''} onChange={e => set('IGDB_CLIENT_ID', e.target.value)} sx={{ mb: 2 }} />
            <TextField label="Client Secret" fullWidth type="password" value={values.IGDB_CLIENT_SECRET || ''} onChange={e => set('IGDB_CLIENT_SECRET', e.target.value)} sx={{ mb: 2 }} />
            <Button variant="outlined" onClick={testIGDB}>Test Connection</Button>
            {testResults.igdb && (
              <Typography variant="caption" color={testResults.igdb === 'ok' ? 'success.main' : 'error'} sx={{ ml: 1 }}>
                {testResults.igdb === 'ok' ? 'Connected' : testResults.igdb}
              </Typography>
            )}
          </Box>
        )}

        {activeTab === 2 && (
          <Box>
            <TextField label="API Key" fullWidth value={values.TGDB_API_KEY || ''} onChange={e => set('TGDB_API_KEY', e.target.value)} sx={{ mb: 2 }} />
            <Button variant="outlined" onClick={testTGDB}>Test Connection</Button>
            {testResults.tgdb && (
              <Typography variant="caption" color={testResults.tgdb === 'ok' ? 'success.main' : 'error'} sx={{ ml: 1 }}>
                {testResults.tgdb === 'ok' ? 'Connected' : testResults.tgdb}
              </Typography>
            )}
          </Box>
        )}

        {activeTab === 3 && (
          <Box>
            <TextField label="Email" fullWidth value={values.IA_EMAIL || ''} onChange={e => set('IA_EMAIL', e.target.value)} sx={{ mb: 2 }} />
            <TextField label="Password" fullWidth type="password" value={values.IA_PASSWORD || ''} onChange={e => set('IA_PASSWORD', e.target.value)} sx={{ mb: 2 }} />
          </Box>
        )}

        <FormControl fullWidth sx={{ mt: 2 }}>
          <InputLabel>Default Scraper</InputLabel>
          <Select value={values.SCRAPER_SOURCE || ''} onChange={e => set('SCRAPER_SOURCE', e.target.value)} label="Default Scraper">
            <MenuItem value="">All</MenuItem>
            <MenuItem value="thegamesdb">TheGamesDB</MenuItem>
            <MenuItem value="screenscraper">ScreenScraper</MenuItem>
            <MenuItem value="igdb">IGDB</MenuItem>
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeSettings}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
