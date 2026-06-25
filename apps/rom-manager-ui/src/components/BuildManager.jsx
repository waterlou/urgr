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
  const [buildResult, setBuildResult] = useState(null);
  const [buildMode, setBuildMode] = useState(null); // 'build' or 'scan'

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
    setBuildMode('build');
    setBuildProgress({});
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
    setBuildRunning(true);
    setBuildResult(null);
    setBuildMode('scan');
    setBuildProgress({});
    try {
      const result = await collectionBuild(collectionId, buildVersion, buildImportDir, true);
      const jobId = result.jobId || result.job_id || result.id;
      const es = subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgress(p => ({ ...p, [jobId]: msg.pct || 0 })),
        onResult: (data) => { setBuildProgress({}); setBuildResult(data); setBuildRunning(false); },
        onError: (err) => { setBuildProgress({}); setBuildResult({ error: err }); setBuildRunning(false); },
      });
      eventSourcesRef.current[jobId] = es;
    } catch (e) {
      setBuildResult({ error: e.message });
      setBuildRunning(false);
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
          {buildRunning && buildMode === 'build' ? <CircularProgress size={14} /> : 'Build'}
        </Button>
        <Button variant="outlined" onClick={handleScan} disabled={!buildVersion || buildRunning}>
          {buildRunning && buildMode === 'scan' ? <CircularProgress size={14} /> : 'Scan'}
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
                {buildMode === 'scan'
                  ? `Found: ${buildResult.found} · Missing: ${buildResult.missing} · Total: ${buildResult.total}`
                  : `Added: ${buildResult.added} · Existed: ${buildResult.exists} · Reused: ${buildResult.reused} · Missing: ${buildResult.missing}`
                }
                {buildMode === 'scan'
                  ? ` · Samples: Found: ${buildResult.samples_found ?? 0} · Missing: ${buildResult.samples_missing ?? 0}`
                  : (buildResult.samples_added || buildResult.samples_existed || buildResult.samples_reused || buildResult.samples_missing)
                    ? (() => {
                        const parts = [];
                        if (buildResult.samples_added) parts.push(`${buildResult.samples_added} added`);
                        if (buildResult.samples_existed) parts.push(`${buildResult.samples_existed} existed`);
                        if (buildResult.samples_reused) parts.push(`${buildResult.samples_reused} reused`);
                        if (buildResult.samples_missing) parts.push(`${buildResult.samples_missing} missing`);
                        return ` · Samples: ${parts.join(' · ')}`;
                      })()
                    : ''}
              </Typography>
              {(buildResult.missing_reasons?.length > 0) && (
                <MissingGamesTable
                  missingReasons={buildResult.missing_reasons}
                  collectionId={collectionId}
                  onRowClick={openRomDetail}
                />
              )}
              {(() => {
                const missingSamples = buildResult.missing_samples?.length
                  ? buildResult.missing_samples
                  : buildResult.missing_reasons?.reduce((acc, r) => {
                      if (!r.sampleof) return acc;
                      const hasMissing = r.sample_details?.some(d => d.status !== 'match');
                      if (hasMissing && !acc.includes(r.sampleof)) acc.push(r.sampleof);
                      return acc;
                    }, []) || [];
                if (missingSamples.length === 0) return null;
                return <MissingSamplesTable missingSamples={missingSamples} />;
              })()}
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
  const byPlat = {};
  for (const r of missingReasons) {
    const p = r.platform || 'unknown';
    if (!byPlat[p]) byPlat[p] = [];
    byPlat[p].push(r);
  }
  const sortedPlats = Object.entries(byPlat).sort((a, b) => b[1].length - a[1].length);
  let globalIdx = 0;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
        Missing games ({missingReasons.length})
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 400 }}>
        <Table size="small" stickyHeader>
          <TableHead>
              <TableRow>
                <TableCell sx={{ width: 40 }}>#</TableCell>
                <TableCell>Game</TableCell>
                <TableCell sx={{ width: 80 }}>Platform</TableCell>
                <TableCell sx={{ width: 90 }}>Status</TableCell>
                <TableCell sx={{ width: 170 }}>Details</TableCell>
              </TableRow>
          </TableHead>
          <TableBody>
            {sortedPlats.map(([plat, games]) => [
              <TableRow key={'h-' + plat}>
                <TableCell colSpan={5} sx={{ bgcolor: 'action.selected', py: 0.5 }}>
                  <Typography variant="caption" fontWeight={700}>
                    {plat} ({games.length})
                  </Typography>
                </TableCell>
              </TableRow>,
              ...games.map((r) => {
                globalIdx++;
                const fnf = typeof r.reason === 'string' && r.reason === 'FileNotFound';
                const crc = r.reason?.CrcMismatch;
                return (
                  <TableRow key={r.name + plat} hover sx={{ cursor: 'pointer' }}
                    onClick={() => onRowClick(r)}>
                    <TableCell><Typography variant="caption" color="text.secondary">{globalIdx}</Typography></TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize={13}>{r.name}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={plat} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                    </TableCell>
                    <TableCell>
                      <Chip label={fnf ? 'Missing' : 'CRC Error'} size="small"
                        color={fnf ? 'error' : 'warning'} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {fnf ? 'File not found' :
                         crc ? `${crc.matched}/${crc.expected} ROMs verified` : ''}
                      </Typography>
                    </TableCell>
                  </TableRow>
                );
              }),
            ])}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function MissingSamplesTable({ missingSamples }) {
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: 'block' }}>
        Missing sample sets ({missingSamples.length})
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 200 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 40 }}>#</TableCell>
              <TableCell>Sample Set</TableCell>
              <TableCell sx={{ width: 100 }}>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {missingSamples.map((name, i) => (
              <TableRow key={name}>
                <TableCell><Typography variant="caption" color="text.secondary">{i + 1}</Typography></TableCell>
                <TableCell>
                  <Typography variant="body2" fontFamily="monospace" fontSize={13}>{name}</Typography>
                </TableCell>
                <TableCell>
                  <Chip label="Missing" size="small" color="error" />
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
  const sampleDetails = game.sample_details || [];
  const fnf = typeof game.reason === 'string' && game.reason === 'FileNotFound';
  const crc = game.reason?.CrcMismatch;

  function RomFilesSection(title, rows) {
    if (rows.length === 0) return null;
    return (
      <Box sx={{ mt: rows === details ? 0 : 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{title}</Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>File</TableCell>
                <TableCell>Expected CRC</TableCell>
                <TableCell>Actual CRC</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.filter(d => d.filename).map(d => (
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
      </Box>
    );
  }

  return (
    <Dialog open={!!game} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontFamily: 'monospace', fontSize: 16 }}>
        {game.name}
        {game.sampleof && (
          <Chip label={`samples: ${game.sampleof}`} size="small" color="info" variant="outlined" sx={{ ml: 1 }} />
        )}
        <Chip
          label={fnf ? 'Missing' : `CRC Error (${crc?.matched || 0}/${crc?.expected || 0})`}
          size="small" color={fnf ? 'error' : 'warning'}
          sx={{ ml: 1.5 }}
        />
      </DialogTitle>
      <DialogContent dividers>
        {details.length === 0 && sampleDetails.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No details available for this game.
          </Typography>
        ) : (
          <>
            {RomFilesSection('ROM Files', details)}
            {RomFilesSection('Sample Files', sampleDetails)}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
