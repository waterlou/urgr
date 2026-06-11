import { useState, useEffect, useRef } from 'react';
import {
  Dialog, AppBar, Toolbar, IconButton, Typography, Box, CircularProgress,
} from '@mui/material';
import { Close as CloseIcon, ArrowBack } from '@mui/icons-material';
import { createPortal } from 'react-dom';
import { getEmulatorCore, isEmulatorSupported } from '../platformEmulator.js';
import { recordPlay } from '../api.js';

export default function EmulatorModal({ game, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const emuRef = useRef(null);
  const scriptRef = useRef(null);
  const recordedRef = useRef(false);

  const core = getEmulatorCore(game.platform, game.source);
  const supported = isEmulatorSupported(game.platform, game.source);

  useEffect(() => {
    if (!supported || !core) { setError(true); setLoading(false); return; }
    if (typeof window.EJS_player !== 'undefined') return;

    recordedRef.current = false;
    const script = document.createElement('script');
    script.src = `https://www.emulatorjs.com/emulator.js`;
    script.async = true;
    script.onload = () => { setLoading(false); };
    script.onerror = () => { setError(true); setLoading(false); };
    document.body.appendChild(script);
    scriptRef.current = script;

    window.ejsOnLoad = () => {
      if (emuRef.current) {
        const ejs = new window.EJS_player(emuRef.current);
        ejs.gameUrl = `/api/games/${game.id}/play`;
        ejs.core = core;
        ejs.start();
      }
    };

    return () => {
      if (scriptRef.current?.parentNode) scriptRef.current.parentNode.removeChild(scriptRef.current);
      const ejsEl = emuRef.current;
      if (ejsEl) ejsEl.innerHTML = '';
    };
  }, [game?.id, core, supported]);

  useEffect(() => {
    if (!loading && !error && !recordedRef.current) {
      recordedRef.current = true;
      recordPlay(game.id).catch(() => {});
    }
  }, [loading, error, game?.id]);

  const title = game?.name || game?.title || 'Game';

  return createPortal(
    <Dialog open fullScreen onClose={onClose}>
      <AppBar position="static" color="primary" sx={{ height: 48 }}>
        <Toolbar variant="dense">
          <IconButton edge="start" color="inherit" onClick={onClose}><ArrowBack /></IconButton>
          <Typography sx={{ ml: 2, flex: 1 }} noWrap>{title}</Typography>
          <IconButton color="inherit" onClick={onClose}><CloseIcon /></IconButton>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#000', position: 'relative' }}>
        {loading && <CircularProgress color="primary" />}
        {error && (
          <Typography color="error">
            {supported ? 'Failed to load emulator' : `Emulator not supported for ${game.platform || 'this platform'}`}
          </Typography>
        )}
        <Box ref={emuRef} id="emulator-game" sx={{ width: '100%', height: '100%', display: loading || error ? 'none' : 'block' }} />
      </Box>
    </Dialog>,
    document.body
  );
}
