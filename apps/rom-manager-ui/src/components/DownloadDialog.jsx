import { Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, LinearProgress, Typography, IconButton } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { cancelJob } from '../api.js';

export default function DownloadDialog({ open, gameName, progress, jobId, onClose }) {
  const messages = progress?.messages || [];
  const pct = progress?.pct || 0;
  const done = progress?.done || false;
  const error = progress?.error || null;

  async function handleCancel() {
    if (jobId) {
      try { await cancelJob(jobId); } catch {}
    }
    onClose?.();
  }

  return (
    <Dialog open={open} maxWidth="sm" fullWidth onClose={done ? onClose : undefined}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        Downloading {gameName || 'game'}
        <Box sx={{ flex: 1 }} />
        {done && <IconButton size="small" onClick={onClose}><CloseIcon /></IconButton>}
      </DialogTitle>
      <DialogContent>
        <LinearProgress variant={pct > 0 ? 'determinate' : 'indeterminate'} value={pct} sx={{ mb: 2, height: 6, borderRadius: 3 }} />
        <Box sx={{
          bgcolor: 'action.hover', borderRadius: 1, p: 1.5, minHeight: 120,
          maxHeight: 250, overflow: 'auto', fontFamily: 'monospace', fontSize: 13,
        }}>
          {messages.length === 0 ? (
            <Typography variant="caption" color="text.secondary">Starting...</Typography>
          ) : messages.map((msg, i) => (
              <Typography key={i} component="div" variant="caption"
                color={msg.startsWith('✗') || msg.startsWith('Error') ? 'error'
                  : msg.startsWith('✓') ? 'success.main'
                  : msg.startsWith('⚠') ? 'warning.main'
                  : 'text.primary'}
                sx={{ whiteSpace: 'pre-wrap', mb: 0.25 }}
              >
              {msg}
            </Typography>
          ))}
        </Box>
        {error && (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>{error}</Typography>
        )}
      </DialogContent>
      <DialogActions>
        {!done ? (
          <Button color="error" onClick={handleCancel}>Cancel</Button>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
