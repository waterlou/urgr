import { useState, useEffect, useRef } from 'react';
import {
  Box, Typography, Button, Select, MenuItem, FormControl, InputLabel,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Chip, LinearProgress, CircularProgress, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { getCollectionBuilds, collectionBuild, subscribeJobSSE } from '../api.js';
import DirectoryBrowserModal from './DirectoryBrowserModal.jsx';

export default function BuildManager({ collectionId, collection }) {
  const [builds, setBuilds] = useState([]);
  const [buildProgress, setBuildProgress] = useState({});
  const [buildVersion, setBuildVersion] = useState('');
  const [buildImportDir, setBuildImportDir] = useState(() => {
    const key = `rom-manager-import-dir-${collectionId}`;
    return localStorage.getItem(key) || '';
  });

  useEffect(() => {
    localStorage.setItem(`rom-manager-import-dir-${collectionId}`, buildImportDir);
  }, [buildImportDir, collectionId]);
  const [buildRunning, setBuildRunning] = useState(false);
  const [buildScanRunning, setBuildScanRunning] = useState(false);
  const [buildScanResult, setBuildScanResult] = useState(null);
  const [buildResult, setBuildResult] = useState(null);

  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const eventSourcesRef = useRef({});

  const [romDetailGame, setRomDetailGame] = useState(null);

  useEffect(() => {
    if (collectionId) getCollectionBuilds(collectionId).then(setBuilds).catch(() => {});
  }, [collectionId]);

  async function handleBuild() {
    if (!buildVersion || !collectionId) return;
    setBuildRunning(true);
    setBuildResult(null);
    try {
      const result = await collectionBuild(collectionId, buildVersion, buildImportDir, false);
      const jobId = result.jobId || result.job_id || result.id;
      setBuildProgress({ [jobId]: 0 });
      const es = subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgress(p => ({ ...p, [jobId]: msg.pct || 0 })),
        onResult: (data) => { setBuildProgress({}); setBuildResult(data); setBuildRunning(false); getCollectionBuilds(collectionId).then(setBuilds); },
        onError: (err) => { setBuildProgress({}); setBuildResult({ error: err }); setBuildRunning(false); },
      });
      eventSourcesRef.current[jobId] = es;
    } catch (e) {
      setBuildResult({ error: e.message });
      setBuildRunning(false);
    }
  }

  async function handleScan() {
    if (!buildVersion || !collectionId) return;
    setBuildScanRunning(true);
    setBuildScanResult(null);
    try {
      const result = await collectionBuild(collectionId, buildVersion, buildImportDir, true);
      const jobId = result.jobId || result.job_id || result.id;
      const es = subscribeJobSSE(jobId, {
        onProgress: (msg) => {},
        onResult: (data) => { setBuildScanResult(data); setBuildScanRunning(false); },
        onError: (err) => { setBuildScanResult({ error: err }); setBuildScanRunning(false); },
      });
      eventSourcesRef.current[jobId] = es;
    } catch (e) {
      setBuildScanResult({ error: e.message });
      setBuildScanRunning(false);
    }
  }

  const versions = collection?.versions || [];

  function openRomDetail(r) {
    setRomDetailGame(r);
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Build</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', mb: 2, flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Version</InputLabel>
          <Select value={buildVersion} onChange={e => setBuildVersion(e.target.value)} label="Version">
            <MenuItem value="">Select...</MenuItem>
          {Array.isArray(versions) && versions.map(v => <MenuItem key={v.id} value={v.id}>{v.version}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField size="small" label="Import Directory" value={buildImportDir}
          onChange={e => setBuildImportDir(e.target.value)}
          placeholder="/path/to/roms" sx={{ minWidth: 200 }}
        />
        <Button size="small" variant="outlined" onClick={() => setDirBrowserOpen(true)} sx={{ whiteSpace: 'nowrap' }}>
          Browse...
        </Button>
        <Button variant="contained" onClick={handleBuild} disabled={!buildVersion || buildRunning}>
          {buildRunning ? <CircularProgress size={14} /> : 'Build'}
        </Button>
        <Button variant="outlined" onClick={handleScan} disabled={!buildVersion || buildScanRunning}>
          {buildScanRunning ? <CircularProgress size={14} /> : 'Scan'}
        </Button>
      </Box>

      {buildProgress && Object.keys(buildProgress).length > 0 && (
        <Box sx={{ mb: 2 }}>
          {Object.entries(buildProgress).map(([jobId, pct]) => (
            <Box key={jobId} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LinearProgress variant="determinate" value={pct} sx={{ flex: 1 }} />
              <Typography variant="caption">{Math.round(pct)}%</Typography>
            </Box>
          ))}
        </Box>
      )}

      {buildResult && (
        <Box sx={{ mb: 2 }}>
          {buildResult.error ? (
            <Typography color="error">{buildResult.error}</Typography>
          ) : (
            <Box>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Added: {buildResult.added} · Existed: {buildResult.exists} · Reused: {buildResult.reused} · Missing: {buildResult.missing}
              </Typography>
              {buildResult.missing_games?.length > 0 && (
                <MissingGamesTable
                  missingReasons={buildResult.missing_reasons || []}
                  collectionId={collectionId}
                  onRowClick={openRomDetail}
                />
              )}
            </Box>
          )}
        </Box>
      )}

      {buildScanResult && (
        <Box sx={{ mb: 2 }}>
          {buildScanResult.error ? (
            <Typography color="error">{buildScanResult.error}</Typography>
          ) : (
            <Box>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Found: {buildScanResult.found} · Missing: {buildScanResult.missing} · Total: {buildScanResult.total}
              </Typography>
              {buildScanResult.missing_names?.length > 0 && (
                <MissingScanTable
                  missingNames={buildScanResult.missing_names}
                  collectionId={collectionId}
                />
              )}
            </Box>
          )}
        </Box>
      )}

      <DirectoryBrowserModal
        open={dirBrowserOpen}
        onClose={() => setDirBrowserOpen(false)}
        onSelect={(path) => {
          setBuildImportDir(path);
          setDirBrowserOpen(false);
        }}
        initialPath={buildImportDir}
      />

      <RomDetailDialog
        game={romDetailGame}
        onClose={() => setRomDetailGame(null)}
        collectionId={collectionId}
      />
    </Box>
  );
}

function MissingGamesTable({ missingReasons, collectionId, onRowClick }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
        Missing games ({missingReasons.length})
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 300 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Game</TableCell>
              <TableCell sx={{ width: 100 }}>Status</TableCell>
              <TableCell sx={{ width: 180 }}>Details</TableCell>
              <TableCell sx={{ width: 60 }}></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {missingReasons.map(r => {
              const fnf = typeof r.reason === 'string' && r.reason === 'FileNotFound';
              const crc = r.reason?.CrcMismatch;
              return (
                <TableRow key={r.name} hover sx={{ cursor: 'pointer' }}
                  onClick={() => onRowClick(r)}>
                  <TableCell>
                    <Typography variant="body2" fontFamily="monospace" fontSize={13}>{r.name}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={fnf ? 'Missing' : 'CRC Error'} size="small"
                      color={fnf ? 'error' : 'warning'} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {fnf ? 'File not found in import' :
                       crc ? `${crc.matched}/${crc.expected} ROMs verified` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Button size="small" variant="outlined"
                      onClick={(e) => { e.stopPropagation(); onRowClick(r); }}>
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function MissingScanTable({ missingNames, collectionId }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
        Missing games ({missingNames.length})
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 300 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Game</TableCell>
              <TableCell sx={{ width: 100 }}>Status</TableCell>
              <TableCell sx={{ width: 180 }}>Details</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {missingNames.map(name => (
              <TableRow key={name}>
                <TableCell>
                  <Typography variant="body2" fontFamily="monospace" fontSize={13}>{name}</Typography>
                </TableCell>
                <TableCell>
                  <Chip label="Missing" size="small" color="error" />
                </TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">File not found</Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function RomDetailDialog({ game, onClose, collectionId }) {
  if (!game) return null;

  const details = game.rom_details || [];
  const fnf = typeof game.reason === 'string' && game.reason === 'FileNotFound';
  const crc = game.reason?.CrcMismatch;

  return (
    <Dialog open={!!game} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontFamily: 'monospace', fontSize: 16 }}>
        {game.name}
        <Chip
          label={fnf ? 'Missing' : `CRC Error (${crc?.matched || 0}/${crc?.expected || 0})`}
          size="small" color={fnf ? 'error' : 'warning'}
          sx={{ ml: 1.5 }}
        />
      </DialogTitle>
      <DialogContent dividers>
        {details.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No ROM details available for this game.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ROM File</TableCell>
                  <TableCell>Expected CRC</TableCell>
                  <TableCell>Actual CRC</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {details.filter(d => d.filename).map(d => (
                  <TableRow key={d.filename}>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize={12}>{d.filename}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" fontFamily="monospace">{d.expected_crc || '—'}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" fontFamily="monospace" color={
                        d.status === 'match' ? 'success.main' : d.actual_crc ? 'warning.main' : 'text.disabled'
                      }>
                        {d.actual_crc || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={d.status}
                        size="small"
                        color={d.status === 'match' ? 'success' : 'default'}
                        variant={d.status === 'match' ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
