import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  colorSchemes: {
    dark: {
      palette: {
        primary: { main: '#e50914' },
        background: { default: '#0d0d0d', paper: '#1a1a1a' },
        divider: '#333',
      },
    },
    light: {
      palette: {
        primary: { main: '#d40812' },
        background: { default: '#f5f5f5', paper: '#ffffff' },
        divider: '#e0e0e0',
      },
    },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
  },
  components: {
    MuiDrawer: {
      styleOverrides: {
        paper: ({ theme }) => ({
          backgroundColor: theme.palette.mode === 'dark' ? '#111' : '#fafafa',
          borderRight: `1px solid ${theme.palette.divider}`,
        }),
      },
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.palette.mode === 'dark' ? '#222' : '#fff',
        }),
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          overflow: 'hidden',
        },
      },
    },
  },
});

export default theme;
