import { useState, useEffect } from 'react';
import {
  Box, Typography, Button, Chip, CircularProgress,
} from '@mui/material';
import {
  getAvailableVersions, importOnlineVersion, getCollectionVersions,
  removeCollectionVersion, importNps,
} from '../api.js';

export default function VersionManager({ collectionId, collection }) {
  const [availableDats, setAvailableDats] = useState([]);
  const [importingVer, setImportingVer] = useState(null);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    if (collectionId) getCollectionVersions(collectionId).then(setVersions).catch(() => {});
  }, [collectionId]);

  useEffect(() => {
    const slug = collection?.dataset_preset;
    if (slug) getAvailableVersions(slug).then(setAvailableDats).catch(() => {});
  }, [collection?.dataset_preset]);

  async function handleImport(version, source) {
    setImportingVer(version);
    try {
      await importOnlineVersion(collectionId, version, source, false);
      const vers = await getCollectionVersions(collectionId);
      setVersions(vers);
    } catch (e) {
      console.error(e);
    } finally { setImportingVer(null); }
  }

  async function handleImportNps() {
    setImportingVer('nps');
    try {
      await importNps(collectionId, collection?.platform);
      const vers = await getCollectionVersions(collectionId);
      setVersions(vers);
    } catch (e) {
      console.error(e);
    } finally { setImportingVer(null); }
  }

  async function handleRemoveVersion(vId) {
    await removeCollectionVersion(collectionId, vId);
    setVersions(p => p.filter(v => v.id !== vId));
  }

  const datasetSlug = collection?.dataset_preset;
  const isMame = datasetSlug === 'mame';
  const isFbneo = datasetSlug === 'fbneo';
  const isNps = datasetSlug === 'nps';

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Versions</Typography>

      {versions.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 2 }}>
          {versions.map(v => (
            <Chip key={v.id} label={`${v.version} (${v.game_count || 0} games)`} size="small"
              onDelete={() => handleRemoveVersion(v.id)}
              color="primary" variant="outlined"
            />
          ))}
        </Box>
      )}

      {(isMame || isFbneo) && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>{isMame ? 'MAME' : 'FBNeo'} versions:</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {availableDats.slice(0, 10).map(d => (
              <Chip key={d.id || d} label={d.version || d} size="small"
                onClick={() => handleImport(d.id || d, isMame ? 'mame' : 'fbneo')}
                disabled={importingVer === (d.id || d)}
                icon={importingVer === (d.id || d) ? <CircularProgress size={12} /> : undefined}
              />
            ))}
          </Box>
        </Box>
      )}

      {isNps && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>NoPayStation:</Typography>
          <Button variant="outlined" size="small" onClick={handleImportNps} disabled={importingVer !== null}>
            {importingVer ? <CircularProgress size={14} /> : 'Import NPS'}
          </Button>
        </Box>
      )}

      {!isMame && !isFbneo && !isNps && datasetSlug && (
        <Box sx={{ mb: 1 }}>
          <Button variant="outlined" size="small" onClick={() => handleImport(datasetSlug, datasetSlug)}
            disabled={importingVer !== null}>
            {importingVer ? <CircularProgress size={14} /> : `Import ${datasetSlug}`}
          </Button>
        </Box>
      )}
    </Box>
  );
}
