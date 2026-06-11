import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button,
  Chip, Box, Typography, Autocomplete,
} from '@mui/material';
import { useUI } from '../contexts/UIContext.jsx';
import { useCollections } from '../contexts/CollectionContext.jsx';
import { usePlatforms } from '../contexts/PlatformContext.jsx';
import IconDisplay from './IconDisplay.jsx';

const LOGO_ICONS = ['fc', 'sfc', 'n64', 'gb', 'gba', 'psx', 'genesis', 'dc', 'ng', 'tg16', 'arcade', 'mame'];

export default function GameSetForm() {
  const { editTarget, closeGameSetForm } = useUI();
  const { saveGameSet } = useCollections();
  const platforms = usePlatforms();

  const isEdit = editTarget?.id;
  const [name, setName] = useState(editTarget?.name || '');
  const [description, setDescription] = useState(editTarget?.description || '');
  const [selectedPlatforms, setSelectedPlatforms] = useState(
    editTarget?.platforms ? editTarget.platforms.split(',') : []
  );
  const [icon, setIcon] = useState(editTarget?.icon || '');

  async function handleSave() {
    await saveGameSet({
      name, description, icon: icon || 'inventory_2',
      platforms: selectedPlatforms.join(','),
    }, isEdit ? editTarget.id : null);
    closeGameSetForm();
  }

  return (
    <Dialog open maxWidth="sm" fullWidth onClose={closeGameSetForm}>
      <DialogTitle>{isEdit ? 'Edit Game Set' : 'New Game Set'}</DialogTitle>
      <DialogContent>
        <TextField label="Name" fullWidth value={name} onChange={e => setName(e.target.value)} sx={{ mb: 2 }} required />
        <TextField label="Description" fullWidth multiline rows={2} value={description}
          onChange={e => setDescription(e.target.value)} sx={{ mb: 2 }} />

        <Typography variant="subtitle2" sx={{ mb: 1 }}>Platforms</Typography>
        <Autocomplete multiple options={platforms.map(p => p.name || p)}
          value={selectedPlatforms} onChange={(e, v) => setSelectedPlatforms(v)}
          renderInput={(params) => <TextField {...params} size="small" placeholder="Select platforms" />}
          renderTags={(value, getTagProps) => value.map((option, index) => (
            <Chip key={option} label={option} size="small" {...getTagProps({ index })} />
          ))}
          sx={{ mb: 2 }}
        />

        <Typography variant="subtitle2" sx={{ mb: 1 }}>Icon</Typography>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {LOGO_ICONS.map(ic => (
            <Chip key={ic} icon={<IconDisplay name={ic} size={20} />} label=""
              onClick={() => setIcon(ic)}
              color={icon === ic ? 'primary' : 'default'}
              variant={icon === ic ? 'filled' : 'outlined'}
              sx={{ minWidth: 40, justifyContent: 'center' }}
            />
          ))}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeGameSetForm}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
