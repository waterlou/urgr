import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  Tabs, Tab, Box, Typography, CircularProgress, Alert, Select, MenuItem,
  FormControl, InputLabel, Divider, Link,
} from '@mui/material';
import {
  getSettings, saveSettings, testIgdbConnection, testTgdbConnection,
} from '../api.js';
import { useUI } from '../contexts/UIContext.jsx';

export default function Settings() {
  const { closeSettings } = useUI();
  const [mainTab, setMainTab] = useState(0);
  const [subTab, setSubTab] = useState(0);
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
    <Dialog open maxWidth="md" fullWidth onClose={closeSettings}>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', gap: 3, minHeight: 380 }}>
          <Tabs orientation="vertical" value={mainTab} onChange={(e, v) => setMainTab(v)}
            sx={{ borderRight: 1, borderColor: 'divider', minWidth: 130 }}>
            <Tab label="Scrapers" />
            <Tab label="Downloads" />
            <Tab label="About" />
          </Tabs>

          <Box sx={{ flex: 1 }}>
            {message && <Alert severity={message.severity} sx={{ mb: 2 }}>{message.text}</Alert>}

            {mainTab === 0 && (
              <>
                <Tabs value={subTab} onChange={(e, v) => setSubTab(v)} sx={{ mb: 2 }}>
                  <Tab label="ScreenScraper" />
                  <Tab label="IGDB" />
                  <Tab label="TheGamesDB" />
                </Tabs>

                {subTab === 0 && (
                  <Box>
                    <TextField label="Dev ID" fullWidth value={values.SS_DEVID || ''} onChange={e => set('SS_DEVID', e.target.value)} sx={{ mb: 2 }} />
                    <TextField label="Dev Password" fullWidth type="password" value={values.SS_DEVPASSWORD || ''} onChange={e => set('SS_DEVPASSWORD', e.target.value)} sx={{ mb: 2 }} />
                    <TextField label="Username (optional)" fullWidth value={values.SS_USERNAME || ''} onChange={e => set('SS_USERNAME', e.target.value)} sx={{ mb: 2 }} />
                    <TextField label="Password (optional)" fullWidth type="password" value={values.SS_PASSWORD || ''} onChange={e => set('SS_PASSWORD', e.target.value)} sx={{ mb: 2 }} />
                  </Box>
                )}

                {subTab === 1 && (
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

                {subTab === 2 && (
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

                <Divider sx={{ my: 2 }} />
                <FormControl fullWidth>
                  <InputLabel>Default Scraper</InputLabel>
                  <Select value={values.SCRAPER_SOURCE || ''} onChange={e => set('SCRAPER_SOURCE', e.target.value)} label="Default Scraper">
                    <MenuItem value="">All</MenuItem>
                    <MenuItem value="thegamesdb">TheGamesDB</MenuItem>
                    <MenuItem value="screenscraper">ScreenScraper</MenuItem>
                    <MenuItem value="igdb">IGDB</MenuItem>
                  </Select>
                </FormControl>
              </>
            )}

            {mainTab === 1 && (
              <Box>
                <TextField label="Email" fullWidth value={values.IA_EMAIL || ''} onChange={e => set('IA_EMAIL', e.target.value)} sx={{ mb: 2 }} />
                <TextField label="Password" fullWidth type="password" value={values.IA_PASSWORD || ''} onChange={e => set('IA_PASSWORD', e.target.value)} sx={{ mb: 2 }} />
              </Box>
            )}

            {mainTab === 2 && (
              <Box>
                <Typography variant="h6" sx={{ mb: 1 }}>ROM Manager</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  A retro game ROM collection manager with DAT parsing, metadata scraping, ROM building, game set playlists, and in-browser emulation via EmulatorJS.
                </Typography>
                <Divider sx={{ my: 2 }} />
                <Typography variant="body2" sx={{ mb: 0.5 }}><strong>Version:</strong> 1.0.0</Typography>
                <Typography variant="body2" sx={{ mb: 0.5 }}><strong>Tech:</strong> React 19, MUI v9, Node.js + Express 5, SQLite</Typography>
                <Typography variant="body2" sx={{ mb: 0.5 }}><strong>CLI:</strong> parse-cli, build-cli, nps-cli, scraper-cli, ia-cli (Rust)</Typography>
                <Typography variant="body2" sx={{ mb: 0.5 }}><strong>Emulator:</strong> <Link href="https://emulatorjs.org/" target="_blank" rel="noopener">EmulatorJS</Link> — FBNeo, MAME, NES, SNES, GB/GBA, and more</Typography>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Scraper Providers</Typography>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  <Link href="https://thegamesdb.net/" target="_blank" rel="noopener">TheGamesDB</Link> · <Link href="https://www.igdb.com/" target="_blank" rel="noopener">IGDB</Link> · <Link href="https://www.screenscraper.fr/" target="_blank" rel="noopener">ScreenScraper</Link>
                </Typography>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  <Link href="https://www.vgmuseum.com/" target="_blank" rel="noopener">VGMuseum</Link> · <Link href="https://github.com/teeedubb/no-intro-pictures" target="_blank" rel="noopener">NoIntroPictures</Link> · <Link href="https://store.playstation.com/" target="_blank" rel="noopener">SonyStore</Link> · <Link href="https://adb.arcadeitalia.net/" target="_blank" rel="noopener">ArcadeDB</Link>
                </Typography>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Data Sources</Typography>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  <Link href="https://www.progettosnaps.net/" target="_blank" rel="noopener">MAME</Link> (DATs via progettosnaps.net) · <Link href="https://github.com/libretro/FBNeo" target="_blank" rel="noopener">FBNeo</Link> (via GitHub)
                </Typography>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  <Link href="https://nopaystation.com/" target="_blank" rel="noopener">NoPayStation</Link> (PS Vita / PS3 / PSP) · <Link href="https://datomatic.no-intro.org/" target="_blank" rel="noopener">DAT-O-MATIC</Link> (No-Intro) · <Link href="https://nointro.free.fr/" target="_blank" rel="noopener">OfflineList</Link>
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
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
