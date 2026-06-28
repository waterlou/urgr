import { AppBar, Toolbar, IconButton, Typography, Box, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import { useUI } from '../contexts/UIContext.jsx';

export default function AppLayout() {
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down('md'));
  const { toggleSidebar } = useUI();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {isSmallScreen && (
        <AppBar position="static" color="inherit" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
          <Toolbar variant="dense">
            <IconButton edge="start" color="inherit" onClick={toggleSidebar} sx={{ mr: 1 }}>
              <MenuIcon />
            </IconButton>
            <Box component="img" src="/logo.png" sx={{ width: 28, height: 28, mr: 1 }} alt="URGR" />
            <Typography variant="h6" noWrap fontWeight={700}>URGR</Typography>
          </Toolbar>
        </AppBar>
      )}
      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />
        <Box component="main" sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
