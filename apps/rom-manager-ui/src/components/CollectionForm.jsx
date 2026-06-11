import { useState, useEffect, useRef } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button,
  Radio, RadioGroup, FormControlLabel, Chip,
  Box, Typography, CircularProgress, Alert,
} from '@mui/material';
import {
  getAvailableVersions, getPlatforms, importDat,
} from '../api.js';
import { useUI } from '../contexts/UIContext.jsx';
import { useCollections } from '../contexts/CollectionContext.jsx';
import IconDisplay from './IconDisplay.jsx';

const POPULAR_DATASETS = [
  { name: 'MAME', slug: 'mame', platform: 'Arcade' },
  { name: 'Final Burn Neo', slug: 'fbneo', platform: 'Arcade' },
  { name: 'OfflineList (No-Intro)', slug: 'offlinelist', platform: 'Console', isOfflineList: true },
  { name: 'DAT-O-MATIC', slug: 'datomatic', platform: 'Console', isDatomic: true },
  { name: 'NoPayStation', slug: 'nps', platform: 'PlayStation', isNps: true },
];

const LOGO_ICONS = ['arcade', 'mame', 'fc', 'sfc', 'n64', 'gb', 'gbc', 'gba', 'nds',
  'psx', 'ps2', 'psp', 'genesis', 'saturn', 'dc', 'gg', 'sms', 'ng', 'ngp', 'ngpc',
  'tg16', 'ws', 'wsc', 'vb', '32X', 'atari', '5200', '7800', 'jaguar', 'lynx',
  'c64', 'amiga', 'msx', 'sg1000', 'coleco', 'vectrex', '3do', 'cdi', 'zx'];

export default function CollectionForm() {
  const { editTarget, closeCollectionForm } = useUI();
  const { saveCollection, versions, loadSidebar } = useCollections();

  const isEdit = editTarget?.id;
  const targetData = editTarget;
  const [name, setName] = useState(targetData?.name || '');
  const [slug, setSlug] = useState(targetData?.slug || '');
  const [folder, setFolder] = useState(targetData?.folder || targetData?.slug || '');
  const [platform, setPlatform] = useState(targetData?.platform || '');
  const [logo, setLogo] = useState(targetData?.logo || '');
  const [datasetMode, setDatasetMode] = useState('manual');
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [datFile, setDatFile] = useState(null);
  const [datFileName, setDatFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');
  const [availableDats, setAvailableDats] = useState([]);
  const [knownPlatforms, setKnownPlatforms] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => {
    getPlatforms().then(setKnownPlatforms).catch(() => {});
  }, []);

  useEffect(() => {
    if (datasetMode === 'preset' && selectedPreset) {
      getAvailableVersions(selectedPreset.slug).then(setAvailableDats).catch(() => {});
    }
  }, [datasetMode, selectedPreset]);

  function handleNameChange(v) {
    setName(v);
    if (!isEdit) {
      const autoSlug = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collection';
      setSlug(autoSlug);
      setFolder(autoSlug);
    }
  }

  function handlePresetChange(preset) {
    setSelectedPreset(preset);
    setName(preset.name);
    setPlatform(preset.platform);
    setLogo('arcade');
    setSlug(preset.slug);
    setFolder(preset.slug);
  }

  async function handleSave() {
    if (!name.trim()) { setFormError('Name is required'); return; }
    setUploading(true);
    setFormError('');
    try {
      const payload = { name: name.trim(), slug, platform, logo: logo || 'folder', folder: folder || slug };
      if (datasetMode === 'dataset' && datFile) {
        const text = await datFile.text();
        await importDat(text);
      }
      await saveCollection(payload, isEdit ? targetData.id : null);
      closeCollectionForm();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open maxWidth="sm" fullWidth onClose={closeCollectionForm}>
      <DialogTitle>{isEdit ? 'Edit Collection' : 'New Collection'}</DialogTitle>
      <DialogContent>
        {formError && <Alert severity="error" sx={{ mb: 2 }}>{formError}</Alert>}
        <TextField label="Name" fullWidth value={name} onChange={e => handleNameChange(e.target.value)} sx={{ mb: 2 }} required />
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <TextField label="Slug" fullWidth value={slug} onChange={e => setSlug(e.target.value)} size="small" />
          <TextField label="Folder" fullWidth value={folder} onChange={e => setFolder(e.target.value)} size="small" />
        </Box>

        {!isEdit && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Dataset</Typography>
            <RadioGroup row value={datasetMode} onChange={e => setDatasetMode(e.target.value)} sx={{ mb: 2 }}>
              <FormControlLabel value="manual" control={<Radio />} label="Manual" />
              <FormControlLabel value="preset" control={<Radio />} label="Preset" />
              <FormControlLabel value="dataset" control={<Radio />} label="Upload DAT" />
            </RadioGroup>

            {datasetMode === 'preset' && (
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                  {POPULAR_DATASETS.map(p => (
                    <Chip key={p.slug} label={p.name}
                      color={selectedPreset?.slug === p.slug ? 'primary' : 'default'}
                      onClick={() => handlePresetChange(p)}
                      variant={selectedPreset?.slug === p.slug ? 'filled' : 'outlined'}
                    />
                  ))}
                </Box>
                {availableDats.length > 0 && (
                  <TextField select label="Select version" fullWidth value=""
                    onChange={e => setSelectedPreset({ ...selectedPreset, selectedVer: e.target.value })}
                    SelectProps={{ native: true }}>
                    <option value="">Select...</option>
                    {availableDats.map(d => <option key={d.id || d} value={d.id || d}>{d.version || d}</option>)}
                  </TextField>
                )}
              </Box>
            )}

            {datasetMode === 'dataset' && (
              <Box sx={{ border: '2px dashed', borderColor: 'divider', borderRadius: 1, p: 3, textAlign: 'center', mb: 2, cursor: 'pointer' }}
                onClick={() => fileRef.current?.click()}>
                <input type="file" ref={fileRef} hidden accept=".dat,.xml" onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) { setDatFile(f); setDatFileName(f.name); }
                }} />
                {datFileName ? <Typography>{datFileName}</Typography> : <Typography color="text.secondary">Click to upload DAT file</Typography>}
              </Box>
            )}
          </>
        )}

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
      </DialogContent>
      <DialogActions>
        <Button onClick={closeCollectionForm}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={uploading}>
          {uploading ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
