import { useState, useEffect } from 'react';
import {
  Box, Typography, Switch, Button, IconButton, Chip, Alert,
} from '@mui/material';
import { ArrowUpward, ArrowDownward } from '@mui/icons-material';
import { ALL_SOURCES, SOURCE_LABELS, getInitialPriority } from '../../lib/scrapePresets.js';
import { updateScrapePriority } from '../../api.js';
import { useCollections } from '../../contexts/CollectionContext.jsx';

export default function ScrapeTab({ collection }) {
  const { loadSidebar } = useCollections();
  const stored = collection?.scrape_source_priority;
  const initial = stored ? JSON.parse(stored) : getInitialPriority(collection?.dataset_preset);
  const allInitial = ALL_SOURCES;

  const [enabled, setEnabled] = useState(() => initial.filter(s => allInitial.includes(s)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = collection?.scrape_source_priority;
    const init = stored ? JSON.parse(stored) : getInitialPriority(collection?.dataset_preset);
    setEnabled(init.filter(s => allInitial.includes(s)));
  }, [collection?.id, collection?.scrape_source_priority, collection?.dataset_preset]);

  const allOrdered = [
    ...allInitial.filter(s => enabled.includes(s)),
    ...allInitial.filter(s => !enabled.includes(s)),
  ];

  function moveUp(slug) {
    const idx = enabled.indexOf(slug);
    if (idx <= 0) return;
    const next = [...enabled];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setEnabled(next);
  }

  function moveDown(slug) {
    const idx = enabled.indexOf(slug);
    if (idx === -1 || idx >= enabled.length - 1) return;
    const next = [...enabled];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setEnabled(next);
  }

  function toggleSource(slug) {
    if (enabled.includes(slug)) {
      setEnabled(enabled.filter(s => s !== slug));
    } else {
      setEnabled([...enabled, slug]);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await updateScrapePriority(collection.id, enabled);
      await loadSidebar();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const def = getInitialPriority(collection?.dataset_preset);
    setEnabled(def.filter(s => allInitial.includes(s)));
  }

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Scrape Source Order</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Order in which scrape sources are tried. Disabled sources are skipped.
      </Typography>

      <Box sx={{ mb: 2 }}>
        {allOrdered.map(slug => {
          const isEnabled = enabled.includes(slug);
          return (
            <Box
              key={slug}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, py: 0.5, px: 1,
                opacity: isEnabled ? 1 : 0.45,
                bgcolor: isEnabled ? 'action.hover' : 'transparent',
                borderRadius: 1, mb: 0.5,
              }}
            >
              <IconButton size="small" onClick={() => moveUp(slug)} disabled={!isEnabled || enabled.indexOf(slug) === 0}>
                <ArrowUpward fontSize="small" />
              </IconButton>
              <IconButton size="small" onClick={() => moveDown(slug)} disabled={!isEnabled || enabled.indexOf(slug) === enabled.length - 1}>
                <ArrowDownward fontSize="small" />
              </IconButton>
              <Typography variant="body2" sx={{ flex: 1 }}>
                {isEnabled ? '●' : '○'} {SOURCE_LABELS[slug] || slug}
              </Typography>
              <Switch checked={isEnabled} onChange={() => toggleSource(slug)} size="small" />
            </Box>
          );
        })}
      </Box>

      {saved && <Alert severity="success" sx={{ mb: 2 }}>Saved!</Alert>}

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button variant="outlined" onClick={handleReset}>Reset to Default</Button>
      </Box>
    </Box>
  );
}
