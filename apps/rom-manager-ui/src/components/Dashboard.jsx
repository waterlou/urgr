import { useState, useEffect } from 'react';
import {
  Box, Typography, Card, CardContent, Grid, CardMedia, LinearProgress, Chip,
} from '@mui/material';
import { useCollections } from '../contexts/CollectionContext.jsx';
import { getRecentlyPlayed } from '../api.js';
import IconDisplay from './IconDisplay.jsx';
import EmulatorModal from './EmulatorModal.jsx';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const { collections } = useCollections();
  const navigate = useNavigate();
  const [recentGames, setRecentGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [orientations, setOrientations] = useState({});
  const [emulatorGame, setEmulatorGame] = useState(null);

  useEffect(() => {
    Promise.all([
      getRecentlyPlayed().catch(() => []),
    ]).then(([recent]) => {
      setRecentGames(recent || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  function handleOrientation(id, w, h) {
    if (!orientations[id]) setOrientations(p => ({ ...p, [id]: w > h ? 'landscape' : 'portrait' }));
  }

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      {recentGames.length > 0 && (
        <>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>Recently Played</Typography>
          <Box sx={{ display: 'flex', gap: 2, overflow: 'auto', pb: 2, mb: 3 }}>
            {recentGames.map(g => (
              <Card key={g.id} sx={{ minWidth: 200, maxWidth: 240, cursor: 'pointer', flexShrink: 0 }}
                onClick={() => navigate(`/collections/${g.collection_id}/game/${g.id}`)}>
                {g.screenshots?.[0] || g.covers?.[0] ? (
                  <CardMedia
                    component="img"
                    height="140"
                    image={g.screenshots?.[0] || g.covers?.[0]}
                    sx={{ objectFit: 'cover' }}
                  />
                ) : (
                  <Box sx={{ height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover' }}>
                    <Typography color="text.secondary">No image</Typography>
                  </Box>
                )}
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{g.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{g.platform}</Typography>
                </CardContent>
              </Card>
            ))}
          </Box>
        </>
      )}

      <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>Collections</Typography>
      {collections.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
          <Typography variant="h5" sx={{ mb: 1 }}>No collections yet</Typography>
          <Typography>Create a collection to get started</Typography>
        </Box>
      ) : (
        <Grid container spacing={2}>
          {collections.map(col => {
            const total = col.total_games || 0;
            const scanned = col.scanned_games || 0;
            const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
            return (
              <Grid item xs={12} sm={6} md={4} lg={3} key={col.id}>
                <Card sx={{ cursor: 'pointer' }} onClick={() => navigate(`/collections/${col.id}`)}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <IconDisplay name={col.logo} fallback="folder" size={28} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body1" fontWeight={600} noWrap>{col.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{col.platform || ''}</Typography>
                      </Box>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                      <Chip label={`${total} games`} size="small" variant="outlined" />
                      {col.platform && <Chip label={col.platform} size="small" color="primary" variant="outlined" />}
                    </Box>
                    <LinearProgress variant="determinate" value={pct} sx={{ height: 6, borderRadius: 3 }} />
                    <Typography variant="caption" color="text.secondary">{pct}% available</Typography>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      )}

      {emulatorGame && <EmulatorModal game={emulatorGame} onClose={() => setEmulatorGame(null)} />}
    </Box>
  );
}
