import {
  Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText,
  Collapse, IconButton, Tooltip, Divider, Typography, Box, useMediaQuery,
} from '@mui/material';
import { useTheme, useColorScheme } from '@mui/material/styles';
import {
  Home as HomeIcon, SportsEsports, Add, Edit, Delete, Folder,
  Inventory2, Download, Settings as SettingsIcon, DarkMode, LightMode,
  ExpandLess, ExpandMore, PlaylistPlay, Science,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useCollections } from '../contexts/CollectionContext.jsx';
import { useUI } from '../contexts/UIContext.jsx';
import IconDisplay from './IconDisplay.jsx';

const DRAWER_WIDTH = 270;

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { collections, gameSets, queueCount, operationCount, deleteGameSet } = useCollections();
  const { sidebarOpen, closeSidebar, openCollectionForm, openGameSetForm, openSettings } = useUI();
  const { mode, setMode } = useColorScheme();
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down('md'));
  const [collOpen, setCollOpen] = useState(true);
  const [gsOpen, setGsOpen] = useState(true);

  // Auto-close sidebar on navigation for small screens
  useEffect(() => {
    if (isSmallScreen) closeSidebar();
  }, [location.pathname, isSmallScreen]);

  function handleNav(path) {
    navigate(path);
  }

  function confirmDeleteGameSet(gs) {
    if (window.confirm(`Are you sure you want to delete "${gs.name}"?`)) {
      deleteGameSet(gs.id);
      if (location.pathname.startsWith(`/game-sets/${gs.id}`)) navigate('/');
    }
  }

  return (
    <Drawer
      variant={isSmallScreen ? 'temporary' : 'permanent'}
      open={isSmallScreen ? sidebarOpen : undefined}
      onClose={isSmallScreen ? closeSidebar : undefined}
      sx={{
        width: isSmallScreen ? undefined : DRAWER_WIDTH,
        flexShrink: isSmallScreen ? undefined : 0,
        '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
      }}
    >
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <SportsEsports color="primary" />
        <Typography variant="h6" fontWeight={700} color="primary">ROM Manager</Typography>
      </Box>
      <Divider />
      <List dense>
        <ListItem disablePadding>
          <ListItemButton selected={location.pathname === '/'} onClick={() => handleNav('/')}>
            <ListItemIcon><HomeIcon /></ListItemIcon>
            <ListItemText primary="Home" />
          </ListItemButton>
        </ListItem>
      </List>
      <Divider />
      <List dense>
        <ListItemButton onClick={() => setCollOpen(!collOpen)}>
          <ListItemIcon><Folder /></ListItemIcon>
          <ListItemText primary="Collections" />
          {collOpen ? <ExpandLess /> : <ExpandMore />}
        </ListItemButton>
        <Collapse in={collOpen}>
          <List dense disablePadding>
            <ListItemButton sx={{ pl: 4 }} onClick={() => openCollectionForm(null)}>
              <ListItemIcon><Add fontSize="small" /></ListItemIcon>
              <ListItemText primary="New Collection" primaryTypographyProps={{ variant: 'body2' }} />
            </ListItemButton>
            {Array.isArray(collections) && collections.length === 0 && (
              <ListItem sx={{ pl: 4 }}>
                <ListItemText primary="No collections" primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }} />
              </ListItem>
            )}
            {Array.isArray(collections) && collections.map(col => (
              <ListItem key={col.id} disablePadding>
                <ListItemButton selected={location.pathname.startsWith(`/collections/${col.id}`)} sx={{ pl: 4 }} onClick={() => handleNav(`/collections/${col.id}`)}>
                  <ListItemIcon sx={{ minWidth: 32 }}><IconDisplay name={col.logo} fallback="folder" size={20} /></ListItemIcon>
                  <ListItemText primary={col.name} primaryTypographyProps={{ variant: 'body2', noWrap: true }} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Collapse>
      </List>
      <Divider />
      <List dense>
        <ListItemButton onClick={() => setGsOpen(!gsOpen)}>
          <ListItemIcon><PlaylistPlay /></ListItemIcon>
          <ListItemText primary="Game Sets" />
          {gsOpen ? <ExpandLess /> : <ExpandMore />}
        </ListItemButton>
        <Collapse in={gsOpen}>
          <List dense disablePadding>
            <ListItemButton sx={{ pl: 4 }} onClick={() => openGameSetForm(null)}>
              <ListItemIcon><Add fontSize="small" /></ListItemIcon>
              <ListItemText primary="New Game Set" primaryTypographyProps={{ variant: 'body2' }} />
            </ListItemButton>
            {(!Array.isArray(gameSets) || gameSets.length === 0) && (
              <ListItem sx={{ pl: 4 }}>
                <ListItemText primary="No game sets" primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }} />
              </ListItem>
            )}
            {Array.isArray(gameSets) && gameSets.map(gs => (
              <ListItem key={gs.id} disablePadding secondaryAction={
                <Box>
                  <IconButton size="small" onClick={() => openGameSetForm(gs)}><Edit fontSize="small" /></IconButton>
                  <IconButton size="small" onClick={() => confirmDeleteGameSet(gs)}><Delete fontSize="small" /></IconButton>
                </Box>
              }>
                <ListItemButton selected={location.pathname === `/game-sets/${gs.id}`} sx={{ pl: 4 }} onClick={() => handleNav(`/game-sets/${gs.id}`)}>
                  <ListItemIcon sx={{ minWidth: 32 }}><IconDisplay name={gs.icon} fallback="inventory_2" size={20} /></ListItemIcon>
                  <ListItemText primary={gs.name} primaryTypographyProps={{ variant: 'body2', noWrap: true }} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Collapse>
      </List>
      <Divider />
      <List dense>
        <ListItem disablePadding>
          <ListItemButton onClick={() => handleNav('/downloads')}>
            <ListItemIcon><Download /></ListItemIcon>
            <ListItemText primary="Downloads" />
            {queueCount > 0 && <Typography variant="caption" color="primary">({queueCount})</Typography>}
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton onClick={() => handleNav('/operations')}>
            <ListItemIcon><Science /></ListItemIcon>
            <ListItemText primary="Operations" />
            {operationCount > 0 && <Typography variant="caption" color="primary">({operationCount})</Typography>}
          </ListItemButton>
        </ListItem>
      </List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <Box sx={{ display: 'flex', p: 1, justifyContent: 'space-around' }}>
        <Tooltip title="Settings">
          <IconButton onClick={() => openSettings()}><SettingsIcon /></IconButton>
        </Tooltip>
        <Tooltip title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
          <IconButton onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
            {mode === 'dark' ? <LightMode /> : <DarkMode />}
          </IconButton>
        </Tooltip>
      </Box>
    </Drawer>
  );
}
