import { useState, useEffect } from 'react';
import {
  Box, Typography, Button, Chip, CircularProgress,
} from '@mui/material';
import {
  getAvailableVersions, importOnlineVersion, getCollectionVersions,
  removeCollectionVersion, importNps,
} from '../../api.js';

export default function VersionsTab({ collectionId, collection }) {
  const [availableDats, setAvailableDats] = useState([]);
  const [latestVer, setLatestVer] = useState('');
  const [importingVer, setImportingVer] = useState(null);
  const [versions, setVersions] = useState([]);
  const [showAll, setShowAll] = useState(false);

  const MAME_MILESTONES = new Set(['0.37b5', '0.78', '0.106', '0.139', '0.160']);

  useEffect(() => {
    if (collectionId) getCollectionVersions(collectionId).then(setVersions).catch(() => {});
  }, [collectionId]);

  useEffect(() => {
    const slug = collection?.dataset_preset;
    if (slug) getAvailableVersions(slug).then(data => {
      setAvailableDats(data.available || []);
      setLatestVer(data.latest || '');
    }).catch(() => {});
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

  async function handleRemoveVersion(vId, vLabel) {
    if (!window.confirm(`Remove version "${vLabel}" from this collection?`)) return;
    await removeCollectionVersion(collectionId, vId);
    setVersions(p => p.filter(v => v.id !== vId));
  }

  const datasetSlug = collection?.dataset_preset;
  const isMame = datasetSlug?.toLowerCase() === 'mame';
  const isFbneo = datasetSlug?.toLowerCase() === 'fbneo';
  const isNps = datasetSlug?.toLowerCase() === 'nps';

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>Versions</Typography>

      {versions.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 2 }}>
          {versions.map(v => (
            <Chip key={v.id} label={`${v.version} (${v.available_games || 0}/${v.total_games || 0})`} size="small"
              onDelete={() => handleRemoveVersion(v.id, v.version)}
              color="primary" variant="outlined"
            />
          ))}
        </Box>
      )}

      {(isMame || isFbneo) && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>{isMame ? 'MAME' : 'FBNeo'} versions:</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
            {(function() {
              let items = Array.isArray(availableDats) ? availableDats : [];
              if (isMame && !showAll && items.length > 0) {
                const keyVers = new Set(MAME_MILESTONES);
                if (latestVer) keyVers.add(latestVer);
                items = items.filter(d => keyVers.has(d.version));
              }
              return items.slice(0, showAll ? undefined : 10).map(d => {
                const ver = d.id || d.numeric || d.version || d;
                const isKey = showAll && (MAME_MILESTONES.has(d.version) || d.version === latestVer);
                return (
                  <Chip key={ver} label={d.numeric && d.numeric !== d.version ? `${d.numeric} (${d.version})` : (d.version || d)} size="small"
                    sx={isKey ? { fontWeight: 700 } : undefined}
                    onClick={() => handleImport(ver, isMame ? 'mame' : 'fbneo')}
                    disabled={importingVer === ver}
                    icon={importingVer === ver ? <CircularProgress size={12} /> : undefined}
                  />
                );
              });
            })()}
            {Array.isArray(availableDats) && availableDats.length > 10 && (
              <Button size="small" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show less' : `Show all (${availableDats.length})`}
              </Button>
            )}
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
