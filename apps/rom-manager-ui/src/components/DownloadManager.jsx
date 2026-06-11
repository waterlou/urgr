import { useState, useEffect, useRef } from 'react';
import {
  Box, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, LinearProgress, IconButton,
  Grid, Card, CardContent,
} from '@mui/material';
import { Refresh, Delete, Replay } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { getDownloadQueue, subscribeDownloadSSE, retryDownload, clearDownload, clearCompletedDownloads } from '../api.js';

export default function DownloadManager() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDownloadQueue().then(d => setQueue(d.queue || [])).catch(() => {}).finally(() => setLoading(false));
    const es = subscribeDownloadSSE({
      onQueue: (q) => setQueue(q || []),
    });
    return () => es.close();
  }, []);

  const stats = {
    pending: queue.filter(i => i.status === 'pending').length,
    downloading: queue.filter(i => i.status === 'downloading').length,
    completed: queue.filter(i => i.status === 'completed').length,
    failed: queue.filter(i => i.status === 'failed').length,
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h6" fontWeight={600}>Downloads</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<Refresh />} onClick={() => getDownloadQueue().then(d => setQueue(d.queue || []))}>Refresh</Button>
        {stats.completed + stats.failed > 0 && (
          <Button size="small" onClick={() => clearCompletedDownloads().then(() => getDownloadQueue().then(d => setQueue(d.queue || [])))}>Clear Completed</Button>
        )}
      </Box>

      <Box sx={{ px: 2, pb: 2 }}>
        <Grid container spacing={2} sx={{ mb: 2 }}>
          {[
            { label: 'Pending', value: stats.pending, color: 'default' },
            { label: 'Downloading', value: stats.downloading, color: 'primary' },
            { label: 'Completed', value: stats.completed, color: 'success' },
            { label: 'Failed', value: stats.failed, color: 'error' },
          ].map(s => (
            <Grid item key={s.label}>
              <Card variant="outlined">
                <CardContent sx={{ p: 2, textAlign: 'center', '&:last-child': { pb: 2 } }}>
                  <Typography variant="h5">{s.value}</Typography>
                  <Typography variant="caption" color="text.secondary">{s.label}</Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>

        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>File</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {queue.length === 0 ? (
                <TableRow><TableCell colSpan={5} align="center">No downloads</TableCell></TableRow>
              ) : queue.map(item => (
                <TableRow key={item.id}>
                  <TableCell>{item.filename || item.name}</TableCell>
                  <TableCell>{item.type}</TableCell>
                  <TableCell>{item.size ? `${(item.size / 1024 / 1024).toFixed(1)}MB` : ''}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Chip label={item.status} size="small" color={
                        item.status === 'completed' ? 'success' : item.status === 'failed' ? 'error' : 'default'
                      } />
                      {item.progress && <LinearProgress variant="determinate" value={item.progress} sx={{ width: 60 }} />}
                    </Box>
                  </TableCell>
                  <TableCell>
                    {item.status === 'failed' && (
                      <IconButton size="small" onClick={() => retryDownload(item.id)}><Replay fontSize="small" /></IconButton>
                    )}
                    <IconButton size="small" onClick={() => clearDownload(item.id).then(() => {
                      setQueue(p => p.filter(i => i.id !== item.id));
                    })}><Delete fontSize="small" /></IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Box>
  );
}
