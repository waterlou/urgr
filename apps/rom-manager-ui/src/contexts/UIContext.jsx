import { createContext, useContext, useState, useCallback } from 'react';

const UIContext = createContext(null);

export function UIProvider({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCollectionForm, setShowCollectionForm] = useState(false);
  const [showGameSetForm, setShowGameSetForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });

  const toggleSidebar = useCallback(() => setSidebarOpen(p => !p), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const openCollectionForm = useCallback((target) => {
    setEditTarget(target ?? null);
    setShowCollectionForm(true);
  }, []);

  const closeCollectionForm = useCallback(() => {
    setShowCollectionForm(false);
    setEditTarget(null);
  }, []);

  const openGameSetForm = useCallback((target) => {
    setEditTarget(target ?? null);
    setShowGameSetForm(true);
  }, []);

  const closeGameSetForm = useCallback(() => {
    setShowGameSetForm(false);
    setEditTarget(null);
  }, []);

  const openSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);

  const showSnackbar = useCallback((message, severity = 'info') => {
    setSnackbar({ open: true, message, severity });
  }, []);

  const closeSnackbar = useCallback(() => {
    setSnackbar(p => ({ ...p, open: false }));
  }, []);

  return (
    <UIContext.Provider value={{
      sidebarOpen, toggleSidebar, closeSidebar,
      showCollectionForm, openCollectionForm, closeCollectionForm, editTarget,
      showGameSetForm, openGameSetForm, closeGameSetForm,
      showSettings, openSettings, closeSettings,
      snackbar, showSnackbar, closeSnackbar,
    }}>
      {children}
    </UIContext.Provider>
  );
}

export function useUI() {
  return useContext(UIContext);
}
