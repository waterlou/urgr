import { useState, useEffect, useRef } from 'react';
import {
  Dialog, AppBar, Toolbar, IconButton, Typography, Box, CircularProgress,
} from '@mui/material';
import { Close as CloseIcon, ArrowBack } from '@mui/icons-material';
import { createPortal } from 'react-dom';
import { getEmulatorCore } from '../platformEmulator.js';
import { playUrl, recordPlay } from '../api.js';

const EJS_CDN = 'https://cdn.emulatorjs.org/nightly/data/';

function loadScript() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EJS_CDN + 'loader.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load EmulatorJS'));
    document.head.appendChild(s);
  });
}

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

        await loadScript();

        if (!destroyed) setLoading(false);
      } catch (err) {
        if (!destroyed) { setError(err.message); setLoading(false); }
      }
    }

    init();

    return () => {
      destroyed = true;
      try {
        const emu = window.EJS_emulator;
        if (emu) {
          const al = emu.Module?.AL?.currentCtx;
          if (al?.audioCtx) al.audioCtx.close().catch(() => {});
          if (emu.Module?.pauseMainLoop) emu.Module.pauseMainLoop();
        }
      } catch {}
      const el = document.getElementById('emulator-game');
      if (el) el.innerHTML = '';
      // Remove EmulatorJS globals so next mount reinitializes
      delete window.EJS_emulator;
      delete window.EJS_player;
      ['EJS_core','EJS_gameName','EJS_gameUrl','EJS_color','EJS_startOnLoaded','EJS_pathtodata'].forEach(k => delete window[k]);
      // Remove all script tags from this CDN to force reload on next mount
      document.querySelectorAll(`script[src*="${EJS_CDN}"]`).forEach(s => s.remove());
    };
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
