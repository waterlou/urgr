import { useState, useEffect } from 'react';
import {
  Box, Typography, Button, Chip, CircularProgress, Paper, Stack,
} from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCollections } from '../contexts/CollectionContext.jsx';
import { getCollectionGames, getCollectionVersions } from '../api.js';
import IconDisplay from './IconDisplay.jsx';
import VersionManager from './VersionManager.jsx';
import IaDownload from './IaDownload.jsx';
import BuildManager from './BuildManager.jsx';
import ExportPanel from './ExportPanel.jsx';

export default function CollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { collections } = useCollections();
  const collection = collections.find(c => c.id === id);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    if (id) getCollectionVersions(id).then(setVersions).catch(() => {});
  }, [id]);

  if (!collection) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

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
        <Button variant="contained" onClick={() => navigate(`/collections/${id}/browse`)}>
          Browse Games
        </Button>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
        <VersionManager collectionId={id} collection={collection} versions={versions} />
        <BuildManager collectionId={id} collection={collection} versions={versions} />
        <ExportPanel collectionId={id} />
        <IaDownload collectionId={id} />
      </Box>
    </Box>
  );
}
