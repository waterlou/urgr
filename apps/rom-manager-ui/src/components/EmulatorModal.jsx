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
  const [blobUrl, setBlobUrl] = useState(null);
  const recordedRef = useRef(false);

  const core = getEmulatorCore(game.platform, game.source);

  useEffect(() => {
    if (!core) {
      setError(`Platform "${game.platform}" is not supported by EmulatorJS`);
      setLoading(false);
      return;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;overflow:hidden;width:100vw;height:100vh}
  #ejs{width:100%;height:100%}
</style>
</head>
<body>
<div id="ejs"></div>
<script>
  window.EJS_player='#ejs';
  window.EJS_core='${core}';
  window.EJS_gameName='${(game.name || '').replace(/'/g, "\\'")}';
  window.EJS_gameUrl='${playUrl(game.id)}';
  window.EJS_color='#1a1a2e';
  window.EJS_fullscreenOnExit=false;
  window.EJS_startOnLoaded=true;
  window.EJS_volume=1.0;
  window.EJS_lang='en';
  window.EJS_pathtodata='${EJS_CDN}';
  var s=document.createElement('script');
  s.src='${EJS_CDN}loader.js?_='+Date.now();
  s.onload=function(){parent.postMessage('ejs-loaded','*')};
  document.head.appendChild(s);
<\/script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);

    function handler(e) {
      if (e.data === 'ejs-loaded') setLoading(false);
    }
    window.addEventListener('message', handler);

    recordPlay(game.id).catch(() => {});

    return () => {
      window.removeEventListener('message', handler);
      URL.revokeObjectURL(url);
    };
  }, [game?.id]);

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
        {error && <Typography color="error" sx={{ p: 2 }}>{error}</Typography>}
        {blobUrl && (
          <iframe
            src={blobUrl}
            style={{ width: '100%', height: '100%', border: 'none', display: loading || error ? 'none' : 'block' }}
            title="Emulator"
          />
        )}
      </Box>
    </Dialog>,
    document.body
  );
}
