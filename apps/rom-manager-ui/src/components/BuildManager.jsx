import { useState, useEffect, useRef } from 'react';
import {
  Box, Typography, Button, Select, MenuItem, FormControl, InputLabel,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Chip, LinearProgress, CircularProgress, Collapse,
} from '@mui/material';
import {
  getCollectionBuilds, startCollectionBuild, runCollectionBuild, collectionBuild,
  subscribeJobSSE, cancelJob,
} from '../api.js';

export default function BuildManager({ collectionId, collection, versions = [] }) {
  const [builds, setBuilds] = useState([]);
  const [buildProgress, setBuildProgress] = useState({});
  const [buildVersion, setBuildVersion] = useState('');
  const [buildImportDir, setBuildImportDir] = useState('');
  const [buildRunning, setBuildRunning] = useState(false);
  const [buildScanRunning, setBuildScanRunning] = useState(false);
  const [buildScanResult, setBuildScanResult] = useState(null);
  const [buildResult, setBuildResult] = useState(null);
  const [showMissing, setShowMissing] = useState(false);
  const eventSourcesRef = useRef({});

  useEffect(() => {
    if (collectionId) getCollectionBuilds(collectionId).then(setBuilds).catch(() => {});
  }, [collectionId]);

  async function handleBuild() {
    if (!buildVersion || !collectionId) return;
    setBuildRunning(true);
    setBuildResult(null);
    try {
      const result = await collectionBuild(collectionId, buildVersion, buildImportDir, false);
      const jobId = result.job_id || result.id;
      setBuildProgress(p => ({ ...p, [jobId]: 0 }));
      const es = subscribeJobSSE(jobId, {
        onProgress: (msg) => setBuildProgress(p => ({ ...p, [jobId]: msg.percent || 0 })),
        onResult: (data) => { setBuildResult(data); setBuildRunning(false); getCollectionBuilds(collectionId).then(setBuilds); },
        onError: (err) => { setBuildResult({ error: err }); setBuildRunning(false); },
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
      const jobId = result.job_id || result.id;
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

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Build</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', mb: 2, flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Version</InputLabel>
          <Select value={buildVersion} onChange={e => setBuildVersion(e.target.value)} label="Version">
            <MenuItem value="">Select...</MenuItem>
            {versions.map(v => <MenuItem key={v.id} value={v.id}>{v.version}</MenuItem>)}
          </Select>
        </FormControl>
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
              <Typography variant="body2">
                Added: {buildResult.added} · Existed: {buildResult.existed} · Reused: {buildResult.reused} · Missing: {buildResult.missing}
              </Typography>
              {buildResult.missing_games?.length > 0 && (
                <>
                  <Button size="small" onClick={() => setShowMissing(!showMissing)}>
                    {showMissing ? 'Hide' : 'Show'} missing games ({buildResult.missing_games.length})
                  </Button>
                  <Collapse in={showMissing}>
                    <Box sx={{ maxHeight: 200, overflow: 'auto' }}>
                      {buildResult.missing_games.map(g => <Typography key={g} variant="caption" display="block">{g}</Typography>)}
                    </Box>
                  </Collapse>
                </>
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
            <Typography variant="body2">
              Found: {buildScanResult.found} · Missing: {buildScanResult.missing} · Total: {buildScanResult.total}
            </Typography>
          )}
        </Box>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Version</TableCell>
              <TableCell>Format</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Progress</TableCell>
              <TableCell>Date</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {builds.length === 0 ? (
              <TableRow><TableCell colSpan={6} align="center">No builds</TableCell></TableRow>
            ) : builds.map(b => (
              <TableRow key={b.id}>
                <TableCell>{b.version || b.version_id}</TableCell>
                <TableCell>{b.format}</TableCell>
                <TableCell>
                  <Chip label={b.status} size="small" color={
                    b.status === 'completed' ? 'success' : b.status === 'running' ? 'primary' : b.status === 'failed' ? 'error' : 'default'
                  } />
                </TableCell>
                <TableCell>
                  {b.progress != null && <LinearProgress variant="determinate" value={b.progress} sx={{ width: 100 }} />}
                </TableCell>
                <TableCell>{b.created_at ? new Date(b.created_at).toLocaleDateString() : ''}</TableCell>
                <TableCell>
                  {(b.status === 'running' || b.status === 'pending') && (
                    <Button size="small" color="error" onClick={() => cancelJob(b.job_id || b.id).catch(() => {})}>Cancel</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
