import { useState } from 'react';
import {
  Box, Typography, TextField, Button, List, ListItem, ListItemText,
  ListItemSecondaryAction, CircularProgress, Alert,
} from '@mui/material';
import { Download } from '@mui/icons-material';
import { iaListFiles, iaDownloadEntry } from '../api.js';

export default function IaDownload({ collectionId }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [downloading, setDownloading] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true); setError(null);
    try {
      const data = await iaListFiles(query.trim());
      setResults(data.results || data.files || []);
    } catch (e) {
      setError(e.message);
    } finally { setSearching(false); }
  }

  async function handleDownload(entry) {
    setDownloading(entry.name || entry); setError(null); setSuccess(null);
    try {
      const r = await iaDownloadEntry(query.trim(), entry.name || entry, collectionId);
      setSuccess(`Downloaded: ${r?.file || entry.name || entry}`);
    } catch (e) {
      setError(e.message);
    } finally { setDownloading(null); }
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Internet Archive</Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField size="small" fullWidth placeholder="Search IA items..." value={query}
          onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
        <Button variant="contained" onClick={handleSearch} disabled={searching}>
          {searching ? <CircularProgress size={14} /> : 'Search'}
        </Button>
      </Box>
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 1 }}>{success}</Alert>}
      {results.length > 0 && (
        <List dense>
          {results.map((r, i) => (
            <ListItem key={i} divider>
              <ListItemText primary={r.name || r} secondary={r.size ? `${(r.size / 1024 / 1024).toFixed(1)}MB` : ''} />
              <Button size="small" startIcon={<Download />} onClick={() => handleDownload(r)}
                disabled={downloading === (r.name || r)}>
                {downloading === (r.name || r) ? <CircularProgress size={14} /> : 'Download'}
              </Button>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
