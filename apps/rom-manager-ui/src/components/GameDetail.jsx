import { useState, useEffect, useRef } from 'react';
import {
  Dialog, AppBar, Toolbar, IconButton, Typography, Box, Chip, Button,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, CircularProgress, ImageList, ImageListItem, Slide,
} from '@mui/material';
import { ArrowBack, PlayArrow, Download, CloudDownload, Check, Close } from '@mui/icons-material';
import { useNavigate, useParams } from 'react-router-dom';
import { getGame, coverUrl, screenshotUrl, playUrl, scrapeGameMetadata,
  downloadGameFromIA, getIaAuthStatus, enqueueDownload, getGameAvailability,
  subscribeJobSSE, subscribeDownloadSSE } from '../api.js';
import EmulatorModal from './EmulatorModal.jsx';
import DownloadDialog from './DownloadDialog.jsx';

function Transition(props) {
  return <Slide direction="left" {...props} />;
}

export default function GameDetail() {
  const { id: collectionId, gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState(null);
  const [scrapedTitle, setScrapedTitle] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [videoLightbox, setVideoLightbox] = useState(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [showEmulator, setShowEmulator] = useState(false);
  const [iaAuth, setIaAuth] = useState(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [downloadJobId, setDownloadJobId] = useState(null);
  const [romAvailability, setRomAvailability] = useState(null);
  const dataLoadedRef = useRef(null);
  const autoScrapedRef = useRef(false);

  useEffect(() => {
    if (!gameId) return;
    setLoading(true);
    getGame(gameId).then(data => {
      setGame(data);
      dataLoadedRef.current = data;
      // Auto-scrape if the game has never been scraped (no synopsis, no covers)
      if (!autoScrapedRef.current && !data.synopsis && !data.covers?.length) {
        autoScrapedRef.current = true;
        setTimeout(() => handleScrape(), 500);
      }
    }).catch(() => {}).finally(() => setLoading(false));
    getIaAuthStatus().then(setIaAuth).catch(() => {});
    getGameAvailability(gameId).then(setRomAvailability).catch(() => {});
  }, [gameId]);

  useEffect(() => {
    function handleVisChange() {
      if (!document.hidden && gameId && gameId !== dataLoadedRef.current?.id) {
        getGame(gameId).then(setGame).catch(() => {});
      }
    }
    document.addEventListener('visibilitychange', handleVisChange);
    return () => document.removeEventListener('visibilitychange', handleVisChange);
  }, [gameId]);

  async function handleScrape() {
    setScraping(true); setScrapeError(null); setScrapedTitle(null);
    try {
      const result = await scrapeGameMetadata(gameId);
      if (result?.scraped) setScrapedTitle(result.title || 'Scraped');
      getGame(gameId).then(setGame).catch(() => {});
    } catch (e) {
      setScrapeError(e.message);
    } finally { setScraping(false); }
  }

  async function handleDownloadIA() {
    setShowDownloadDialog(true);
    setDownloadProgress({ messages: ['Starting...'], pct: 0, done: false, error: null });
    try {
      const result = await downloadGameFromIA(gameId);
      const jobId = result.jobId || result.job_id || result.id;
      if (!jobId) { setDownloadProgress(p => ({ ...p, error: 'Failed to start download', done: true })); return; }
      setDownloadJobId(jobId);
      setDownloadProgress(p => ({ ...p, messages: [...p.messages, `Job started: ${jobId.slice(0, 8)}...`] }));

      const es = subscribeJobSSE(jobId, {
        onProgress: (msg) => {
          setDownloadProgress(p => ({
            ...p,
            pct: msg.percent || msg.pct || p.pct,
            messages: msg.msg ? [...p.messages, msg.msg] : p.messages,
          }));
        },
        onResult: (data) => {
          const finalMsg = data?.ok ? '✓ Download complete!' : '⚠ Download finished with issues';
          setDownloadProgress(p => ({ ...p, pct: 100, messages: [...p.messages, finalMsg], done: true }));
          getGame(gameId).then(setGame).catch(() => {});
          getGameAvailability(gameId).then(setRomAvailability).catch(() => {});
        },
        onError: (err) => {
          setDownloadProgress(p => ({ ...p, error: err, messages: [...p.messages, `✗ ${err}`], done: true }));
        },
      });
      // The SSE endpoint will send the current progress immediately on connect,
      // which includes the "Searching..." message if the job is still running.
    } catch (e) {
      setDownloadProgress(p => ({ ...p, error: e.message, messages: [...p.messages, `✗ ${e.message}`], done: true }));
    }
  }

  async function handleEnqueueDownload() {
    setShowDownloadDialog(true);
    setDownloadProgress({ messages: ['Queuing download...'], pct: 0, done: false, error: null });
    setDownloadJobId(null);
    try {
      await enqueueDownload(gameId);
      setDownloadProgress(p => ({ ...p, messages: [...p.messages, 'Download queued, waiting for downloader...'] }));

      const es = subscribeDownloadSSE({
        onQueue: (queue) => {
          const items = (queue || []).filter(i => i.game_id === parseInt(gameId));
          if (items.length === 0) return;
          const item = items[0];
          if (item.status === 'downloading') {
            setDownloadProgress(p => ({
              ...p,
              pct: item.progress || 50,
              messages: [...p.messages, `Downloading ${item.filename}...${item.progress || ''}`],
            }));
          } else if (item.status === 'completed') {
            setDownloadProgress(p => ({
              ...p, pct: 100,
              messages: [...p.messages, `✓ ${item.filename} downloaded`],
              done: true,
            }));
            es.close();
            getGame(gameId).then(setGame).catch(() => {});
            getGameAvailability(gameId).then(setRomAvailability).catch(() => {});
          } else if (item.status === 'failed') {
            setDownloadProgress(p => ({
              ...p, error: item.error || 'Download failed',
              messages: [...p.messages, `✗ ${item.filename}: ${item.error || 'failed'}`],
              done: true,
            }));
            es.close();
          }
        },
      });
    } catch (e) {
      setDownloadProgress(p => ({ ...p, error: e.message, messages: [...p.messages, `✗ ${e.message}`], done: true }));
    }
  }

  if (!gameId) return null;

  const hasAvailableRoms = romAvailability?.available
    ? Object.values(romAvailability.available).some(v => v)
    : null; // null = still loading, true = has ROMs, false = no ROMs

  const showDownload = game?.source === 'NPS'
    ? romAvailability !== null && !game?.available  // NPS: show after avail fetch if not downloaded
    : hasAvailableRoms === false;  // non-NPS: show only when explicitly no ROMs found

  return (
    <>
      <Dialog open fullScreen TransitionComponent={Transition} onClose={() => navigate(-1)}>
        <AppBar position="static" color="inherit" sx={{ boxShadow: 1 }}>
          <Toolbar variant="dense">
            <IconButton edge="start" onClick={() => navigate(-1)}><ArrowBack /></IconButton>
              <Typography variant="subtitle1" sx={{ ml: 1 }} noWrap>
                {game?.description || game?.name || game?.title || 'Loading...'}
              </Typography>
            <Box sx={{ flex: 1 }} />
            {showDownload && game?.source === 'NPS' ? (
              game?.available ? (
                <Chip label="Downloaded" color="success" size="small" sx={{ mr: 1 }} />
              ) : (
                <Button variant="contained" size="small" startIcon={<Download />} onClick={handleEnqueueDownload}
                  sx={{ mr: 1 }}>
                  Download
                </Button>
              )
            ) : null}
            {showDownload && game?.source !== 'NPS' && iaAuth?.authenticated ? (
              <Button variant="contained" size="small" startIcon={<CloudDownload />} onClick={handleDownloadIA}
                disabled={showDownloadDialog} sx={{ mr: 1 }}>
                {showDownloadDialog ? <CircularProgress size={14} /> : 'Get ROM'}
              </Button>
            ) : null}
            <Button variant="contained" size="small" startIcon={<PlayArrow />}
              onClick={() => setShowEmulator(true)}
              disabled={!game || (hasAvailableRoms === false && !showDownloadDialog)}>
              Play
            </Button>
          </Toolbar>
        </AppBar>

        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
          ) : !game ? (
            <Typography color="error">Game not found</Typography>
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
                <Box sx={{ width: { xs: '100%', sm: 200 }, flexShrink: 0 }}>
                  <Box sx={{ position: 'relative', borderRadius: 1, overflow: 'hidden', bgcolor: '#111', aspectRatio: '3/4' }}>
                    {!coverFailed && (game.covers?.[0] || game.cover_url) ? (
                      <img src={coverUrl(game.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'pointer' }}
                        onClick={() => setLightbox(coverUrl(game.id))} onError={() => setCoverFailed(true)} />
                    ) : (
                      <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
                        <Typography>No cover</Typography>
                      </Box>
                    )}
                  </Box>
                </Box>
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography variant="h5" fontWeight={600} sx={{ mb: 0.5 }}>{game.description || game.name}</Typography>
                  {game.description && <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>{game.name}</Typography>}
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                    {game.source && <Chip label={game.source} size="small" />}
                    {game.region && <Chip label={game.region} size="small" variant="outlined" />}
                    {game.year && <Chip label={game.year} size="small" onClick={() => navigate(`/collections/${collectionId || ''}/browse?year=${game.year}`)} sx={{ cursor: 'pointer' }} />}
                    {game.platform && <Chip label={game.platform} size="small" color="primary" variant="outlined" />}
                    {game.manufacturer && <Chip label={game.manufacturer} size="small" onClick={() => navigate(`/collections/${collectionId || ''}/browse?manufacturer=${encodeURIComponent(game.manufacturer)}`)} sx={{ cursor: 'pointer' }} />}
                    {game.cloneof && <Chip label={`Clone of: ${game.cloneof}`} size="small" variant="outlined"
                      onClick={() => game.parent?.id && navigate(`/collections/${collectionId || ''}/game/${game.parent.id}`, { replace: true })}
                      sx={{ cursor: game.parent?.id ? 'pointer' : 'default' }}
                    />}
                    {game.synopsis && <Chip label="Scraped" size="small" color="success" />}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                    <Button size="small" variant="outlined" onClick={handleScrape} disabled={scraping}>
                      {scraping ? <CircularProgress size={14} /> : scrapedTitle ? 'Re-scrape' : 'Scrape'}
                    </Button>
                    {scrapeError && <Typography variant="caption" color="error">{scrapeError}</Typography>}
                    {scrapedTitle && <Typography variant="caption" color="success.main">{scrapedTitle}</Typography>}
                  </Box>
                  {game.synopsis && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{game.synopsis}</Typography>
                  )}
                </Box>
              </Box>

              {game.screenshots?.length > 0 && (
                <>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Screenshots</Typography>
                  <ImageList cols={4} gap={8} sx={{ mb: 2 }}>
                    {game.screenshots.slice(0, 12).map((url, i) => (
                      <ImageListItem key={i} sx={{ cursor: 'pointer' }}>
                        <img src={i === 0 ? screenshotUrl(game.id) : url} alt="" loading="lazy" style={{ borderRadius: 4 }}
                          onClick={() => setLightbox(url)} />
                      </ImageListItem>
                    ))}
                  </ImageList>
                </>
              )}

              {game.videos?.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Video</Typography>
                  <Box sx={{ borderRadius: 1, overflow: 'hidden', width: '25%', bgcolor: '#000', cursor: 'pointer' }}
                    onClick={() => setVideoLightbox(game.videos[0])}>
                    <video
                      src={game.videos[0]}
                      autoPlay muted playsInline loop
                      preload="auto"
                      style={{ width: '100%', display: 'block', pointerEvents: 'none' }}
                    />
                  </Box>
                </Box>
              )}

              {game.clones?.length > 0 && (
                <>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Variants ({game.clones.length})</Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                    {game.clones.map(v => (
                      <Chip key={v.id} label={v.name} size="small" variant="outlined" color="primary"
                        onClick={() => navigate(`/collections/${collectionId || ''}/game/${v.id}`, { replace: true })}
                        title={v.description}
                      />
                    ))}
                  </Box>
                </>
              )}

              {game.roms?.length > 0 && (
                <>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>ROM Files</Typography>
                  <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                    <Table size="small" sx={{ tableLayout: 'fixed' }}>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ width: '40%' }}>Filename</TableCell>
                          <TableCell sx={{ width: 70 }}>Type</TableCell>
                          <TableCell sx={{ width: 80 }}>Size</TableCell>
                          <TableCell sx={{ width: 70 }}>Status</TableCell>
                          <TableCell sx={{ width: 60, textAlign: 'center' }}>Available</TableCell>
                          <TableCell sx={{ width: 100 }}>CRC</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {game.roms.map((rom, i) => (
                          <TableRow key={i}>
                            <TableCell>
                              {(() => {
                                const raw = rom.name || rom.filename || '';
                                const dot = raw.lastIndexOf('.');
                                const base = dot > 0 ? raw.slice(0, dot) : raw;
                                const ext = dot > 0 ? raw.slice(dot) : '';
                                return (
                                  <Box sx={{ display: 'flex', overflow: 'hidden' }}>
                                    <Typography variant="body2" fontFamily="monospace" fontSize={12}
                                      noWrap sx={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                                      {base}
                                    </Typography>
                                    {ext && (
                                      <Typography variant="body2" fontFamily="monospace" fontSize={12}
                                        sx={{ flexShrink: 0 }}>
                                        {ext}
                                      </Typography>
                                    )}
                                  </Box>
                                );
                              })()}
                            </TableCell>
                            <TableCell>{rom.subtype === 'chd' ? 'CHD' : rom.subtype === 'sample' ? 'Sample' : rom.merge_target ? 'Split' : 'ROM'}</TableCell>
                            <TableCell>{rom.size ? `${(rom.size / 1024).toFixed(0)}KB` : ''}</TableCell>
                            <TableCell>
                              <Chip label={rom.status || 'unknown'} size="small" color={
                                rom.status === 'good' ? 'success' : rom.status === 'baddump' ? 'error' : 'default'
                              } />
                            </TableCell>
                            <TableCell sx={{ textAlign: 'center' }}>
                              {romAvailability?.available?.[rom.id]
                                ? <Check sx={{ color: 'success.main', fontSize: 20, verticalAlign: 'middle' }} />
                                : <Close sx={{ color: 'text.disabled', fontSize: 20, verticalAlign: 'middle' }} />}
                            </TableCell>
                            <TableCell><Typography variant="caption" fontFamily="monospace">{rom.crc32 || ''}</Typography></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </>
              )}
</>
          )}
        </Box>
      </Dialog>

      {lightbox && (
        <Dialog open maxWidth="lg" onClose={() => setLightbox(null)}>
          <img src={lightbox} alt="" style={{ width: '100%', maxHeight: '90vh', objectFit: 'contain' }} />
        </Dialog>
      )}

      {videoLightbox && (
        <Dialog open maxWidth="lg" onClose={() => setVideoLightbox(null)}
          PaperProps={{ sx: { bgcolor: '#000' } }}>
          <video src={videoLightbox} controls autoPlay
            style={{ width: '100%', display: 'block' }} />
        </Dialog>
      )}

      {showEmulator && game && (
        <EmulatorModal key={`emu-${game.id}-${Date.now()}`} game={{ id: game.id, name: game.name, description: game.description, platform: game.platform, source: game.source }}
          onClose={() => setShowEmulator(false)} />
      )}

      <DownloadDialog
        open={showDownloadDialog}
        gameName={game?.description || game?.name}
        progress={downloadProgress}
        jobId={downloadJobId}
        onClose={() => setShowDownloadDialog(false)}
      />
    </>
  );
}
