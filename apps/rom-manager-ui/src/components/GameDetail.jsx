import { useState, useEffect, useRef } from 'react';
import {
  Dialog, AppBar, Toolbar, IconButton, Typography, Box, Chip, Button,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, CircularProgress, ImageList, ImageListItem, Slide,
} from '@mui/material';
import { ArrowBack, PlayArrow, Download, CloudDownload, Check, Close } from '@mui/icons-material';
import { useNavigate, useParams } from 'react-router-dom';
import { getGame, coverUrl, playUrl, scrapeGameMetadata,
  downloadGameFromIA, getIaAuthStatus, enqueueDownload, getGameAvailability } from '../api.js';
import EmulatorModal from './EmulatorModal.jsx';

function Transition(props) {
  return <Slide direction="left" {...props} />;
}

export default function GameDetail() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState(null);
  const [scrapedTitle, setScrapedTitle] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [showEmulator, setShowEmulator] = useState(false);
  const [iaAuth, setIaAuth] = useState(null);
  const [iaDownloading, setIaDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState(null);
  const [romAvailability, setRomAvailability] = useState(null);
  const dataLoadedRef = useRef(null);

  useEffect(() => {
    if (!gameId) return;
    setLoading(true);
    getGame(gameId).then(data => {
      setGame(data);
      dataLoadedRef.current = data;
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
    setIaDownloading(true); setDownloadMsg(null);
    try {
      const r = await downloadGameFromIA(gameId);
      setDownloadMsg(r?.downloaded ? 'Downloaded!' : r?.message || 'Queued');
    } catch (e) {
      setDownloadMsg(e.message);
    } finally { setIaDownloading(false); }
  }

  async function handleEnqueueDownload() {
    setDownloadMsg(null);
    try {
      await enqueueDownload(gameId);
      setDownloadMsg('Added to download queue');
    } catch (e) {
      setDownloadMsg(e.message);
    }
  }

  if (!gameId) return null;

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
            <Button variant="contained" size="small" startIcon={<PlayArrow />}
              onClick={() => setShowEmulator(true)} disabled={!game}>
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
                  <Box sx={{ position: 'relative', borderRadius: 1, overflow: 'hidden', bgcolor: 'action.hover' }}>
                    {!coverFailed && (game.covers?.[0] || game.cover_url) ? (
                      <img src={coverUrl(game.id)} alt="" style={{ width: '100%', display: 'block', cursor: 'pointer' }}
                        onClick={() => setLightbox(coverUrl(game.id))} onError={() => setCoverFailed(true)} />
                    ) : (
                      <Box sx={{ aspectRatio: '3/4', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
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
                    {game.year && <Chip label={game.year} size="small" />}
                    {game.platform && <Chip label={game.platform} size="small" color="primary" variant="outlined" />}
                    {game.manufacturer && <Chip label={game.manufacturer} size="small" />}
                    {game.cloneof && <Chip label={`Clone of: ${game.cloneof}`} size="small" variant="outlined" />}
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
                        <img src={url} alt="" loading="lazy" style={{ borderRadius: 4 }}
                          onClick={() => setLightbox(url)} />
                      </ImageListItem>
                    ))}
                  </ImageList>
                </>
              )}

              {game.variants?.length > 0 && (
                <>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Variants</Typography>
                  {game.variants.map(v => (
                    <Box key={v.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Typography variant="body2" sx={{ cursor: 'pointer', color: 'primary.main' }}
                        onClick={() => navigate(`/collections/${game.collection_id}/game/${v.id}`)}>
                        {v.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">{v.rom_name}</Typography>
                    </Box>
                  ))}
                </>
              )}

              {game.roms?.length > 0 && (
                <>
                  <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>ROM Files</Typography>
                  <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Filename</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell>Size</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Available</TableCell>
                          <TableCell>CRC</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {game.roms.map((rom, i) => (
                          <TableRow key={i}>
                            <TableCell>
                              <Typography variant="body2" fontFamily="monospace" fontSize={12}>
                                {rom.name || rom.filename}
                              </Typography>
                            </TableCell>
                            <TableCell>{rom.merge_target ? 'Split' : 'Parent'}</TableCell>
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

              <Box sx={{ display: 'flex', gap: 1 }}>
                {game.source === 'NPS' ? (
                  <>
                    {game.downloaded ? (
                      <Chip label="Downloaded" color="success" />
                    ) : (
                      <Button variant="contained" size="small" startIcon={<Download />}
                        onClick={handleEnqueueDownload}>Download</Button>
                    )}
                    {game.dlc_count > 0 && <Chip label={`${game.dlc_count} DLC`} size="small" />}
                    {game.update_count > 0 && <Chip label={`${game.update_count} Updates`} size="small" />}
                  </>
                ) : (
                  <Box>
                    {iaAuth?.authenticated ? (
                      <Button variant="outlined" size="small" startIcon={<CloudDownload />}
                        onClick={handleDownloadIA} disabled={iaDownloading}>
                        {iaDownloading ? <CircularProgress size={14} /> : 'Download from IA'}
                      </Button>
                    ) : (
                      <Typography variant="caption" color="text.secondary">Configure IA in Settings</Typography>
                    )}
                  </Box>
                )}
              </Box>
              {downloadMsg && <Typography variant="caption" sx={{ mt: 1, display: 'block' }}>{downloadMsg}</Typography>}
            </>
          )}
        </Box>
      </Dialog>

      {lightbox && (
        <Dialog open maxWidth="lg" onClose={() => setLightbox(null)}>
          <img src={lightbox} alt="" style={{ width: '100%', maxHeight: '90vh', objectFit: 'contain' }} />
        </Dialog>
      )}

      {showEmulator && game && (
        <EmulatorModal key={`emu-${game.id}-${Date.now()}`} game={{ id: game.id, name: game.name, platform: game.platform, source: game.source }}
          onClose={() => setShowEmulator(false)} />
      )}
    </>
  );
}
