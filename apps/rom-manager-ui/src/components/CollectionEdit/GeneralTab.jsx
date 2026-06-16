import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, TextField, Button, Chip, Alert, FormControl, FormLabel, Select, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { useCollections } from '../../contexts/CollectionContext.jsx';
import { LOGO_ICONS } from '../../lib/collectionConstants.js';
import IconDisplay from '../IconDisplay.jsx';

export default function GeneralTab({ collection }) {
  const navigate = useNavigate();
  const { saveCollection, deleteCollection } = useCollections();
  const [name, setName] = useState(collection?.name || '');
  const [slug, setSlug] = useState(collection?.slug || '');
  const [folder, setFolder] = useState(collection?.folder || collection?.slug || '');
  const [platform, setPlatform] = useState(collection?.platform || '');
  const [logo, setLogo] = useState(collection?.logo || '');
  const [scrapeMode, setScrapeMode] = useState(collection?.scrape_mode || 'parent');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');

  function handleNameChange(v) {
    setName(v);
    if (slug === collection?.slug || !slug) {
      const autoSlug = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collection';
      setSlug(autoSlug);
      setFolder(autoSlug);
    }
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      await saveCollection({ name: name.trim(), slug, platform, logo: logo || 'folder', folder: folder || slug, scrape_mode: scrapeMode }, collection.id);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  function openDeleteDialog() {
    setConfirmSlug('');
    setShowDelete(true);
  }

  function handleDelete() {
    if (confirmSlug !== collection.slug) return;
    deleteCollection(collection.id);
    setShowDelete(false);
    navigate('/');
  }

  useEffect(() => {
    if (collection) {
      setName(collection.name || '');
      setSlug(collection.slug || '');
      setFolder(collection.folder || collection.slug || '');
      setPlatform(collection.platform || '');
      setLogo(collection.logo || '');
      setScrapeMode(collection.scrape_mode || 'parent');
    }
  }, [collection]);

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>General</Typography>

      <TextField label="Name" fullWidth value={name} onChange={e => handleNameChange(e.target.value)} sx={{ mb: 2 }} required />
      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField label="Slug" fullWidth value={slug} onChange={e => setSlug(e.target.value)} size="small" />
        <TextField label="Folder" fullWidth value={folder} onChange={e => setFolder(e.target.value)} size="small" />
      </Box>

      <TextField label="Platform" fullWidth value={platform} onChange={e => setPlatform(e.target.value)} sx={{ mb: 2 }} placeholder="e.g. Arcade, Console, NES" />

      <Typography variant="subtitle2" sx={{ mb: 1 }}>Icon</Typography>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 2 }}>
        {LOGO_ICONS.map(ic => (
          <Chip key={ic} icon={<IconDisplay name={ic} size={20} />} label=""
            onClick={() => setLogo(ic)}
            color={logo === ic ? 'primary' : 'default'}
            variant={logo === ic ? 'filled' : 'outlined'}
            sx={{ minWidth: 40, justifyContent: 'center' }}
          />
        ))}
      </Box>

      <FormControl fullWidth size="small" sx={{ mb: 2 }}>
        <FormLabel>Scrape Scope</FormLabel>
        <Select value={scrapeMode} onChange={e => setScrapeMode(e.target.value)}>
          <MenuItem value="parent">Parent-based — all clones share media from parent game</MenuItem>
          <MenuItem value="individual">Individual — scrape each variant by its own name</MenuItem>
        </Select>
      </FormControl>

      {saved && <Alert severity="success" sx={{ mb: 2 }}>Saved!</Alert>}

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'space-between', alignItems: 'center' }}>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button color="error" onClick={openDeleteDialog}>Delete Collection</Button>
      </Box>

      <Dialog open={showDelete} onClose={() => setShowDelete(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete "{collection.name}"?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This cannot be undone. Type <strong>{collection.slug}</strong> to confirm.
          </Typography>
          <TextField
            autoFocus fullWidth size="small"
            placeholder={collection.slug}
            value={confirmSlug}
            onChange={e => setConfirmSlug(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && confirmSlug === collection.slug) handleDelete(); }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDelete(false)}>Cancel</Button>
          <Button color="error" disabled={confirmSlug !== collection.slug} onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
