import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import theme from './theme.js'
import { CollectionProvider } from './contexts/CollectionContext.jsx'
import { PlatformProvider } from './contexts/PlatformContext.jsx'
import { UIProvider } from './contexts/UIContext.jsx'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme} defaultMode="dark">
      <CssBaseline />
      <PlatformProvider>
        <CollectionProvider>
          <UIProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </UIProvider>
        </CollectionProvider>
      </PlatformProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
