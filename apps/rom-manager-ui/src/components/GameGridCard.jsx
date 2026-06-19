import { useState, useMemo } from 'react';
import {
  Card, CardMedia, CardContent, Typography, Box, IconButton, Rating, Chip,
  Menu, MenuItem, ListItemIcon, ListItemText,
} from '@mui/material';
import {
  Star, StarBorder, MoreVert, PlaylistAdd, PlaylistRemove,
} from '@mui/icons-material';
import { updateGameRating, coverUrl, screenshotUrl } from '../api.js';

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 30%)`;
}

export default function GameGridCard({ game, onSelect, onRating, onFavourite, onAddToGameSet, onRemoveFromGameSet, gameSets, gameSetId, listImageMode, onPlay }) {
  const [anchorEl, setAnchorEl] = useState(null);
  const [imgFailed, setImgFailed] = useState(false);
  const bg = useMemo(() => hashColor(game.name), [game.name]);

  async function handleRating(e, v) {
    const newRating = v === null ? 0 : Math.round(v * 2);
    await updateGameRating(game.id, { rating: newRating, favourite: game.favourite }).catch(() => {});
    onRating?.(game.id, { rating: newRating });
  }

  function handleFav(e) {
    e.stopPropagation();
    const newFav = game.favourite ? 0 : 1;
    updateGameRating(game.id, { favourite: newFav, rating: game.rating || 0 }).catch(() => {});
    onFavourite?.(game.id, { favourite: newFav });
  }

  const showImage = listImageMode !== 'none' && !imgFailed && (
    listImageMode === 'screenshot' ? game.screenshots?.[0] : (game.covers?.[0] || game.cover_url)
  );

  return (
    <Card sx={{ position: 'relative', cursor: 'pointer', '&:hover': { boxShadow: 6 } }} onClick={() => onSelect?.(game)}>
      <Box sx={{ position: 'relative', aspectRatio: '1/1', bgcolor: '#111', overflow: 'hidden' }}>
        {showImage ? (
          listImageMode === 'screenshot' && game.screenshots?.[0] ? (
            <CardMedia component="img" image={screenshotUrl(game.id)} sx={{ width: '100%', height: '100%', objectFit: 'contain', p: 0.5 }}
              onError={() => setImgFailed(true)} />
          ) : (
            <CardMedia component="img" image={coverUrl(game.id)} sx={{ width: '100%', height: '100%', objectFit: 'contain', p: 0.5 }}
              onError={() => setImgFailed(true)}
            />
          )
        ) : (
          <Box sx={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: bg }}>
            <Typography sx={{ fontSize: 48, fontWeight: 700, color: 'rgba(255,255,255,0.25)', userSelect: 'none' }}>
              {(game.name || '?')[0].toUpperCase()}
            </Typography>
          </Box>
        )}
        <Box sx={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 0.5 }}>
          <IconButton size="small" sx={{ bgcolor: 'rgba(0,0,0,0.5)', color: game.favourite ? 'warning.main' : '#fff' }}
            onClick={handleFav}>
            {game.favourite ? <Star fontSize="small" /> : <StarBorder fontSize="small" />}
          </IconButton>
          {gameSets?.length > 0 && (
            <>
              <IconButton size="small" sx={{ bgcolor: 'rgba(0,0,0,0.5)', color: '#fff' }}
                onClick={(e) => { e.stopPropagation(); setAnchorEl(e.currentTarget); }}>
                <MoreVert fontSize="small" />
              </IconButton>
              <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
                {gameSets.map(gs => (
                  <MenuItem key={gs.id} onClick={(e) => {
                    e.stopPropagation();
                    setAnchorEl(null);
                    if (gameSetId) {
                      onRemoveFromGameSet?.(game.id, gs.id);
                    } else {
                      onAddToGameSet?.(game.id, gs.id);
                    }
                  }}>
                    <ListItemIcon>{gameSetId ? <PlaylistRemove fontSize="small" /> : <PlaylistAdd fontSize="small" />}</ListItemIcon>
                    <ListItemText>{gs.name}</ListItemText>
                  </MenuItem>
                ))}
              </Menu>
            </>
          )}
        </Box>
        {game.source && (
          <Chip label={game.source} size="small" sx={{ position: 'absolute', bottom: 4, left: 4, height: 18, fontSize: 10 }} />
        )}
      </Box>
      <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
        <Typography variant="body2" noWrap fontWeight={600}>{game.name}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {game.platform} {game.year && `· ${game.year}`}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Rating value={(game.rating || 0) / 2} precision={0.5} size="small" onChange={handleRating}
            onClick={(e) => e.stopPropagation()} />
        </Box>
      </CardContent>
    </Card>
  );
}
