import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';
import { Box, AppBar, Toolbar, IconButton, Typography, Button, CircularProgress, Snackbar, Alert } from '@mui/material';
import { ArrowBack, Save } from '@mui/icons-material';
import { getGame, updateGameNotes } from '../api.js';

export default function GameNotes() {
  const { id: collectionId, gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snackbar, setSnackbar] = useState(null);

  useEffect(() => {
    if (!gameId) return;
    getGame(gameId).then(data => {
      setGame(data);
      setNotes(data.notes || '');
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [gameId]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateGameNotes(gameId, notes);
      setSnackbar({ severity: 'success', message: 'Notes saved' });
    } catch (e) {
      setSnackbar({ severity: 'error', message: e.message });
    }
    setSaving(false);
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" color="inherit" sx={{ boxShadow: 1 }}>
        <Toolbar variant="dense">
          <IconButton edge="start" onClick={() => navigate(-1)}><ArrowBack /></IconButton>
          <Typography variant="subtitle1" sx={{ ml: 1 }} noWrap>
            Notes — {game?.description || game?.name || 'Loading...'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button variant="contained" size="small" startIcon={saving ? <CircularProgress size={14} /> : <Save />}
            onClick={handleSave} disabled={saving}>
            Save
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, p: 2, overflow: 'auto' }} data-color-mode={document.documentElement.getAttribute('data-mui-color-scheme') || 'dark'}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
        ) : (
          <MDEditor
            value={notes}
            onChange={setNotes}
            height="100%"
            visibleDragbar={false}
          />
        )}
      </Box>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snackbar ? <Alert severity={snackbar.severity} variant="filled">{snackbar.message}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
