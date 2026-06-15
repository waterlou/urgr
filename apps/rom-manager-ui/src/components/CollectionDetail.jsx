import { useState } from 'react';
import { Box, Typography, Button, Tabs, Tab, CircularProgress } from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCollections } from '../contexts/CollectionContext.jsx';
import IconDisplay from './IconDisplay.jsx';
import GeneralTab from './CollectionEdit/GeneralTab.jsx';
import VersionsTab from './CollectionEdit/VersionsTab.jsx';
import ScrapeTab from './CollectionEdit/ScrapeTab.jsx';
import BuildTab from './CollectionEdit/BuildTab.jsx';
import ExportTab from './CollectionEdit/ExportTab.jsx';

export function supportsVersions(collection) {
  const slug = collection?.dataset_preset?.toLowerCase();
  return slug === 'mame' || slug === 'fbneo';
}

export default function CollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { collections } = useCollections();
  const collection = collections.find(c => String(c.id) === id);
  const [tab, setTab] = useState('general');

  if (!collection) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  const tabs = [
    { key: 'general', label: 'General' },
    ...(supportsVersions(collection) ? [{ key: 'versions', label: 'Versions' }] : []),
    { key: 'scrape', label: 'Scrape' },
    { key: 'build', label: 'Build' },
    { key: 'export', label: 'Export' },
  ];

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button startIcon={<ArrowBack />} onClick={() => navigate('/')}>Back</Button>
        <IconDisplay name={collection?.logo} fallback="folder" size={28} />
        <Box>
          <Typography variant="h6" fontWeight={600}>{collection?.name || 'Loading...'}</Typography>
          <Typography variant="caption" color="text.secondary">
            {collection?.total_games || 0} games · {collection?.platform || ''}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
      </Box>

      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Tabs
          orientation="vertical"
          value={tab}
          onChange={(e, v) => setTab(v)}
          sx={{ borderRight: 1, borderColor: 'divider', minWidth: 140, pt: 1 }}
        >
          {tabs.map(t => <Tab key={t.key} value={t.key} label={t.label} sx={{ alignItems: 'flex-start', px: 2 }} />)}
        </Tabs>

        <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
          {tab === 'general'  && <GeneralTab  collection={collection} />}
          {tab === 'versions' && <VersionsTab collectionId={id} collection={collection} />}
          {tab === 'scrape'   && <ScrapeTab   collection={collection} />}
          {tab === 'build'    && <BuildTab    collectionId={id} collection={collection} />}
          {tab === 'export'   && <ExportTab   collectionId={id} />}
        </Box>
      </Box>
    </Box>
  );
}
