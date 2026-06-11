import { useState } from 'react';
import {
  TableRow, TableCell, Box, Typography, IconButton, Rating, Chip, Avatar,
  Menu, MenuItem, ListItemIcon, ListItemText,
} from '@mui/material';
import { Star, StarBorder, MoreVert, PlaylistAdd, PlaylistRemove } from '@mui/icons-material';
import { updateGameRating } from '../api.js';

export default function GameListItem({ game, onSelect, onRating, onFavourite, onAddToGameSet, onRemoveFromGameSet, gameSets, gameSetId, listImageMode }) {
  const [anchorEl, setAnchorEl] = useState(null);

  async function handleRating(e, v) {
    const newRating = v === null ? 0 : Math.round(v * 2);
    await updateGameRating(game.id, { rating: newRating, favourite: game.favourite }).catch(() => {});
    onRating?.(game.id, { rating: newRating });
  }

  function handleFav() {
    const newFav = game.favourite ? 0 : 1;
    updateGameRating(game.id, { favourite: newFav, rating: game.rating || 0 }).catch(() => {});
    onFavourite?.(game.id, { favourite: newFav });
  }

  return (
    <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => onSelect?.(game)}>
      <TableCell sx={{ width: 50 }}>
        {listImageMode !== 'none' && game.cover_url ? (
          <Avatar src={game.cover_url} variant="rounded" sx={{ width: 40, height: 40 }} />
        ) : (
          <Avatar variant="rounded" sx={{ width: 40, height: 40, bgcolor: 'action.hover' }}>?</Avatar>
        )}
      </TableCell>
      <TableCell>
        <Typography variant="body2" fontWeight={600}>{game.name}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 300, display: 'block' }}>
          {game.description || ''}
        </Typography>
      </TableCell>
      <TableCell>
        <Chip label={game.platform} size="small" variant="outlined" />
      </TableCell>
      <TableCell>{game.year || ''}</TableCell>
      <TableCell>
        <Rating value={(game.rating || 0) / 2} precision={0.5} size="small" onChange={handleRating}
          onClick={(e) => e.stopPropagation()} />
      </TableCell>
      <TableCell sx={{ width: 40 }}>
        <IconButton size="small" onClick={(e) => { e.stopPropagation(); handleFav(); }}>
          {game.favourite ? <Star fontSize="small" color="warning" /> : <StarBorder fontSize="small" />}
        </IconButton>
      </TableCell>
      {gameSets?.length > 0 && (
        <TableCell sx={{ width: 40 }}>
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); setAnchorEl(e.currentTarget); }}>
            <MoreVert fontSize="small" />
          </IconButton>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
            {gameSets.map(gs => (
              <MenuItem key={gs.id} onClick={() => {
                setAnchorEl(null);
                gameSetId ? onRemoveFromGameSet?.(game.id, gs.id) : onAddToGameSet?.(game.id, gs.id);
              }}>
                <ListItemIcon>{gameSetId ? <PlaylistRemove fontSize="small" /> : <PlaylistAdd fontSize="small" />}</ListItemIcon>
                <ListItemText>{gs.name}</ListItemText>
              </MenuItem>
            ))}
          </Menu>
        </TableCell>
      )}
    </TableRow>
  );
}
