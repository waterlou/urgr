import { useState, useEffect, useRef } from 'react';
import {
  Dialog, AppBar, Toolbar, IconButton, Typography, Box, CircularProgress,
} from '@mui/material';
import { Close as CloseIcon, ArrowBack } from '@mui/icons-material';
import { createPortal } from 'react-dom';
import { getEmulatorCore } from '../platformEmulator.js';
import { playUrl, recordPlay } from '../api.js';

const EJS_CDN = 'https://cdn.emulatorjs.org/nightly/data/';

export default function EmulatorModal({ game, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const recordedRef = useRef(false);

  useEffect(() => {
    let destroyed = false;

    async function init() {
      try {
        const core = getEmulatorCore(game.platform, game.source);
        if (!core) {
          setError(`Platform "${game.platform}" is not supported by EmulatorJS`);
          setLoading(false);
          return;
        }

        // Remove any stale EmulatorJS scripts so the new one runs fresh
        document.querySelectorAll(`script[src*="${EJS_CDN}loader.js"]`).forEach(s => s.remove());
        delete window.EJS_emulator;

        window.EJS_player = '#emulator-game';
        window.EJS_core = core;
        window.EJS_gameName = game.name || game.title || 'Game';
        window.EJS_gameUrl = playUrl(game.id);
        window.EJS_color = '#1a1a2e';
        window.EJS_fullscreenOnExit = false;
        window.EJS_startOnLoaded = true;
        window.EJS_volume = 1.0;
        window.EJS_lang = 'en';
        window.EJS_pathtodata = EJS_CDN;

        const s = document.createElement('script');
        s.src = EJS_CDN + 'loader.js?_=' + Date.now();
        s.onload = () => { if (!destroyed) setLoading(false); };
        s.onerror = () => { if (!destroyed) { setError('Failed to load EmulatorJS'); setLoading(false); } };
        document.head.appendChild(s);
      } catch (err) {
        if (!destroyed) { setError(err.message); setLoading(false); }
      }
    }

    init();
  }, [game]);

  useEffect(() => {
    if (!loading && !error && !recordedRef.current) {
      recordedRef.current = true;
      recordPlay(game.id).catch(() => {});
    }
  }, [loading, error, game?.id]);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <Dialog open fullScreen onClose={onClose}>
      <AppBar position="static" color="primary" sx={{ height: 48 }}>
        <Toolbar variant="dense">
          <IconButton edge="start" color="inherit" onClick={onClose}><ArrowBack /></IconButton>
          <Typography sx={{ ml: 2, flex: 1 }} noWrap>{game?.name || game?.title || 'Game'}</Typography>
          <IconButton color="inherit" onClick={onClose}><CloseIcon /></IconButton>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#000', position: 'relative' }}>
        {loading && <CircularProgress color="primary" />}
        {error && (
          <Typography color="error">
            {error}
          </Typography>
        )}
        <Box id="emulator-game" sx={{ width: '100%', height: '100%', display: loading || error ? 'none' : 'block' }} />
      </Box>
    </Dialog>,
    document.body
  );
}
