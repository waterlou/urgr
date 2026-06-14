import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box, Typography, TextField, InputAdornment, IconButton, ToggleButtonGroup,
  ToggleButton, Chip, Select, MenuItem, FormControl, Table, TableBody,
  TableContainer, TableHead, TableRow, TableCell, Paper, Tooltip,
  Button, CircularProgress, Checkbox, FormControlLabel,
} from '@mui/material';
import {
  GridView, ViewList, ViewModule, Search, ArrowUpward, ArrowDownward,
  FilterList, Star, CropOriginal, Close, PlayArrow, Settings as SettingsIcon,
} from '@mui/icons-material';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useCollections } from '../contexts/CollectionContext.jsx';
import { useUI } from '../contexts/UIContext.jsx';
import {
  batchScrapeGameMetadata, scrapeAllCollectionGames, coverUrl, playUrl,
} from '../api.js';
import GameGridCard from './GameGridCard.jsx';
import GameListItem from './GameListItem.jsx';
import IconDisplay from './IconDisplay.jsx';
import EmulatorModal from './EmulatorModal.jsx';

export default function GameBrowser() {
  const navigate = useNavigate();
  const { id: paramId } = useParams();
  const location = useLocation();
  const {
    games, loading, hasMore, activeMeta, totalGames, collectionVersions,
    selectedVersionId, setSelectedVersionId,
    loadGames, loadMore, addToGameSet, removeFromGameSet, updateGame, gameSets,
  } = useCollections();
  const { showSnackbar } = useUI();

  const activeView = location.pathname.startsWith('/collections') ? 'collection'
    : location.pathname.startsWith('/game-sets') ? 'game-set' : 'browse';
  const activeId = paramId;
  const isRootCollection = activeView === 'collection' && !location.pathname.includes('/browse') && !location.pathname.includes('/game/');

  // Read all filters from URL search params (persist across navigation)
  const searchParams = new URLSearchParams(location.search);
  const urlQ = searchParams.get('q') || '';
  const urlYear = searchParams.get('year') || '';
  const urlManufacturer = searchParams.get('manufacturer') || '';
  const urlSort = searchParams.get('sort') || 'name';
  const urlOrder = searchParams.get('order') || 'asc';
  const urlParents = searchParams.get('parents_only') === 'true';
  const urlFavs = searchParams.get('favourites_only') === 'true';
  const urlRoms = searchParams.get('roms_only') === 'true';

  const [viewMode, setViewMode] = useState('grid');
  const [sortField, setSortField] = useState(urlSort);
  const [sortOrder, setSortOrder] = useState(urlOrder);
  const [searchQuery, setSearchQuery] = useState(urlQ);
  const [searchOpen, setSearchOpen] = useState(!!urlQ);
  const [parentsOnly, setParentsOnly] = useState(() => localStorage.getItem('rom-manager-parents-only') === 'true' || urlParents);
  const [favouritesOnly, setFavouritesOnly] = useState(() => localStorage.getItem('rom-manager-favourites-only') === 'true' || urlFavs);
  const [romsOnly, setRomsOnly] = useState(() => localStorage.getItem('rom-manager-roms-only') === 'true' || urlRoms);
  const [yearFilter, setYearFilter] = useState(urlYear);
  const [manufacturerFilter, setManufacturerFilter] = useState(urlManufacturer);
  const [listImageMode, setListImageMode] = useState(() => localStorage.getItem('rom-manager-list-image') || 'cover');
  const [batchShow, setBatchShow] = useState(false);
  const [batchOverwrite, setBatchOverwrite] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [batchResult, setBatchResult] = useState(null);
  const [emulatorGame, setEmulatorGame] = useState(null);
  const sentinelRef = useRef(null);

  function handleArr(field) {
    if (sortField === field) setSortOrder(p => p === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortOrder('asc'); }
  }

  useEffect(() => {
    loadGames(activeView, activeId, sortField, sortOrder, searchQuery,
      parentsOnly, favouritesOnly, romsOnly, selectedVersionId, activeView === 'collection' ? 'games' : undefined,
      yearFilter || urlYear, manufacturerFilter || urlManufacturer);
  }, [activeView, activeId, sortField, sortOrder, searchQuery, parentsOnly, favouritesOnly, romsOnly, selectedVersionId, loadGames, yearFilter, manufacturerFilter, urlYear, urlManufacturer]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && hasMore && !loading) {
        loadMore(activeView, activeId, sortField, sortOrder, searchQuery,
          parentsOnly, favouritesOnly, romsOnly, selectedVersionId, yearFilter || urlYear, manufacturerFilter || urlManufacturer);
      }
    }, { rootMargin: '200px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, activeView, activeId, sortField, sortOrder, searchQuery,
    parentsOnly, favouritesOnly, romsOnly, selectedVersionId, loadMore, yearFilter, manufacturerFilter, urlYear, urlManufacturer]);

  // Sync filters to URL so they survive navigation
  useEffect(() => {
    if (activeView !== 'collection') return;
    const p = new URLSearchParams(location.search);
    if (searchQuery) p.set('q', searchQuery); else p.delete('q');
    if (sortField !== 'name') p.set('sort', sortField); else p.delete('sort');
    if (sortOrder !== 'asc') p.set('order', sortOrder); else p.delete('order');
    if (parentsOnly) p.set('parents_only', 'true'); else p.delete('parents_only');
    if (favouritesOnly) p.set('favourites_only', 'true'); else p.delete('favourites_only');
    if (romsOnly) p.set('roms_only', 'true'); else p.delete('roms_only');
    if (yearFilter) p.set('year', yearFilter); else p.delete('year');
    if (manufacturerFilter) p.set('manufacturer', manufacturerFilter); else p.delete('manufacturer');
    const qs = p.toString();
    const current = location.search.replace(/^\?/, '');
    if (qs !== current) navigate(location.pathname + (qs ? '?' + qs : ''), { replace: true });
  }, [searchQuery, sortField, sortOrder, parentsOnly, favouritesOnly, romsOnly, yearFilter, manufacturerFilter, activeView]);

  // Save/restore scroll position
  const scrollKey = `scroll-${activeView}-${activeId || ''}`;
  useEffect(() => {
    if (loading) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) window.scrollTo(0, parseInt(saved, 10));
    return () => sessionStorage.setItem(scrollKey, String(window.scrollY));
  }, [scrollKey, loading]);

  // Batch scrape
  async function startBatchScrape() {
    setBatchRunning(true);
    setBatchProgress(null);
    setBatchResult(null);
    try {
      let data;
      if (activeView === 'collection') {
        data = await scrapeAllCollectionGames(activeId);
      } else {
        const ids = games.filter(g => !g.synopsis || batchOverwrite).map(g => g.id);
        data = await batchScrapeGameMetadata(ids, batchOverwrite);
      }
      setBatchResult(data);
      showSnackbar(`Scraped ${data.scraped || 0} games`, 'success');
    } catch (e) {
      showSnackbar(`Scrape failed: ${e.message}`, 'error');
    } finally {
      setBatchRunning(false);
    }
  }

  function playGame(game) {
    setEmulatorGame({
      id: game.id, name: game.name, platform: game.platform, source: game.source,
    });
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2, pb: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          {activeView === 'collection' && !isRootCollection && (
            <IconButton onClick={() => navigate(`/collections/${activeId}`)}><Close /></IconButton>
          )}
          <Box>
            <Typography variant="h6" fontWeight={600}>
              {activeMeta?.name || (activeView === 'browse' ? 'All Games' : '')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {totalGames} game{totalGames !== 1 ? 's' : ''}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {activeView === 'collection' && isRootCollection && (
            <IconButton onClick={() => navigate(`/collections/${activeId}/settings`)}>
              <SettingsIcon />
            </IconButton>
          )}
          {activeMeta?.platforms && activeMeta.platforms.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {activeMeta.platforms.map(p => <Chip key={p} label={p} size="small" icon={<IconDisplay name={p} size={16} />} />)}
            </Box>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <ToggleButtonGroup value={viewMode} exclusive onChange={(e, v) => v && setViewMode(v)} size="small">
            <ToggleButton value="grid"><GridView fontSize="small" /></ToggleButton>
            <ToggleButton value="list"><ViewList fontSize="small" /></ToggleButton>
            <ToggleButton value="large"><ViewModule fontSize="small" /></ToggleButton>
          </ToggleButtonGroup>

          <FormControl size="small" sx={{ minWidth: 80 }}>
            <Select value={`${sortField}-${sortOrder}`} onChange={e => {
              const [f, o] = e.target.value.split('-');
              setSortField(f); setSortOrder(o);
            }}>
              <MenuItem value="name-asc">Name ↑</MenuItem>
              <MenuItem value="name-desc">Name ↓</MenuItem>
              <MenuItem value="rating-desc">Rating ↓</MenuItem>
              <MenuItem value="rating-asc">Rating ↑</MenuItem>
              <MenuItem value="year-desc">Year ↓</MenuItem>
              <MenuItem value="year-asc">Year ↑</MenuItem>
            </Select>
          </FormControl>

          <Tooltip title={parentsOnly ? 'Showing parents only' : 'Showing all'}>
            <Chip label="Parents" size="small" color={parentsOnly ? 'primary' : 'default'}
              onClick={() => { const v = !parentsOnly; setParentsOnly(v); localStorage.setItem('rom-manager-parents-only', v); }} />
          </Tooltip>
          <Tooltip title={favouritesOnly ? 'Favourites only' : 'All games'}>
            <Chip icon={<Star fontSize="small" />} label="Fav" size="small" color={favouritesOnly ? 'warning' : 'default'}
              onClick={() => { const v = !favouritesOnly; setFavouritesOnly(v); localStorage.setItem('rom-manager-favourites-only', v); }} />
          </Tooltip>
          <Tooltip title={romsOnly ? 'ROMs only' : 'All entries'}>
            <Chip label="ROMs" size="small" color={romsOnly ? 'primary' : 'default'}
              onClick={() => { const v = !romsOnly; setRomsOnly(v); localStorage.setItem('rom-manager-roms-only', v); }} />
          </Tooltip>

          {(yearFilter || urlYear) && (
            <Chip label={`Year: ${yearFilter || urlYear}`} size="small" color="primary"
              onDelete={() => setYearFilter('')} />
          )}
          {(manufacturerFilter || urlManufacturer) && (
            <Chip label={`Mfg: ${manufacturerFilter || urlManufacturer}`} size="small" color="primary"
              onDelete={() => setManufacturerFilter('')} />
          )}

          <Select size="small" value={listImageMode} onChange={e => { setListImageMode(e.target.value); localStorage.setItem('rom-manager-list-image', e.target.value); }}
            sx={{ minWidth: 80 }}>
            <MenuItem value="cover">Cover</MenuItem>
            <MenuItem value="screenshot">Screenshot</MenuItem>
            <MenuItem value="none">None</MenuItem>
          </Select>

          <Box sx={{ flex: 1 }} />
          {searchOpen ? (
            <TextField size="small" variant="outlined" placeholder="Search..." autoFocus
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              InputProps={{ endAdornment: <InputAdornment position="end"><IconButton size="small" onClick={() => { setSearchOpen(false); setSearchQuery(''); }}><Close /></IconButton></InputAdornment> }}
            />
          ) : (
            <IconButton onClick={() => setSearchOpen(true)}><Search /></IconButton>
          )}

          <Button size="small" variant="outlined" onClick={() => setBatchShow(!batchShow)}>
            {batchShow ? 'Hide Scrape' : 'Batch Scrape'}
          </Button>
        </Box>

        {collectionVersions?.length > 1 && (
          <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
            <Chip label="All versions" size="small" color={!selectedVersionId ? 'primary' : 'default'}
              onClick={() => setSelectedVersionId(null)} />
            {collectionVersions.map(v => (
              <Chip key={v.id} label={`${v.version} (${v.total_games})`} size="small"
                color={selectedVersionId === v.id ? 'primary' : 'default'}
                onClick={() => setSelectedVersionId(v.id)} />
            ))}
          </Box>
        )}

        {batchShow && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="body2">{activeView === 'collection' ? 'Scrape all unscraped' : `Scrape ${games.filter(g => !g.synopsis || batchOverwrite).length} games`}</Typography>
            <FormControlLabel control={<Checkbox checked={batchOverwrite} onChange={e => setBatchOverwrite(e.target.checked)} />} label="Overwrite" />
            <Button size="small" variant="contained" onClick={startBatchScrape} disabled={batchRunning}>
              {batchRunning ? <CircularProgress size={16} /> : 'Scrape'}
            </Button>
            {batchResult && (
              <Typography variant="caption">✓ {batchResult.scraped} · ⏭ {batchResult.skipped} · ✗ {batchResult.failed}</Typography>
            )}
          </Box>
        )}
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
        {loading && games.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
        ) : games.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
            <Typography variant="h5">No games found</Typography>
          </Box>
        ) : viewMode === 'list' ? (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 50 }}></TableCell>
                  <TableCell sx={{ cursor: 'pointer' }} onClick={() => handleArr('name')}>
                    Name {sortField === 'name' && (sortOrder === 'asc' ? <ArrowUpward fontSize="inherit" /> : <ArrowDownward fontSize="inherit" />)}
                  </TableCell>
                  <TableCell>Platform</TableCell>
                  <TableCell sx={{ cursor: 'pointer' }} onClick={() => handleArr('year')}>
                    Year {sortField === 'year' && (sortOrder === 'asc' ? <ArrowUpward fontSize="inherit" /> : <ArrowDownward fontSize="inherit" />)}
                  </TableCell>
                  <TableCell>Rating</TableCell>
                  <TableCell>Fav</TableCell>
                  {gameSets?.length > 0 && <TableCell>Set</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {games.map(g => (
                  <GameListItem key={g.id} game={g} onSelect={(game) => navigate(`${location.pathname}/game/${game.id}`)}
                    onRating={(id, patch) => updateGame(id, patch)}
                    onFavourite={(id, patch) => updateGame(id, patch)}
                    onAddToGameSet={addToGameSet} onRemoveFromGameSet={removeFromGameSet}
                    gameSets={gameSets} listImageMode={listImageMode} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, contentVisibility: 'auto', containIntrinsicSize: 220 }}>
            {games.map(g => (
              <Box key={g.id} sx={{
                width: viewMode === 'large' ? 240 : 180,
                flexShrink: 0,
              }}>
                <GameGridCard game={g} onSelect={(game) => navigate(`${location.pathname}/game/${game.id}`)}
                  onRating={(id, patch) => updateGame(id, patch)}
                  onFavourite={(id, patch) => updateGame(id, patch)}
                  onAddToGameSet={addToGameSet} onRemoveFromGameSet={removeFromGameSet}
                  gameSets={gameSets} listImageMode={listImageMode} onPlay={playGame} />
              </Box>
            ))}
          </Box>
        )}

        <div ref={sentinelRef} />
        {loading && games.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}><CircularProgress size={24} /></Box>
        )}
      </Box>

      {emulatorGame && <EmulatorModal game={emulatorGame} onClose={() => setEmulatorGame(null)} />}
    </Box>
  );
}
