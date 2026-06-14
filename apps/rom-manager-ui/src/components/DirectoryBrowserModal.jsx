import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  List, ListItem, ListItemButton, ListItemIcon, ListItemText,
  Button, Breadcrumbs, Typography, Link, CircularProgress, Alert,
  Box,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { browseFilesystem } from '../api.js';

export default function DirectoryBrowserModal({ open, onClose, onSelect, initialPath }) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = useCallback(async (dir) => {
    setLoading(true);
    setError('');
    try {
      const result = await browseFilesystem(dir);
      setCurrentPath(result.path);
      setParent(result.parent);
      setEntries(result.entries || []);
    } catch (e) {
      setError(e.message);
      if (e.message.includes('403')) {
        // If path is not allowed, fall back to the home directory
        try {
          const result = await browseFilesystem('');
          setCurrentPath(result.path);
          setParent(result.parent);
          setEntries(result.entries || []);
        } catch {
          setError('Cannot browse filesystem');
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadDir(initialPath || '');
    }
  }, [open, initialPath, loadDir]);

  function handleNavigateUp() {
    if (parent) loadDir(parent);
  }

  function handleSelect() {
    onSelect(currentPath);
  }

  // Breadcrumb segments
  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const breadcrumbPaths = segments.map((_, i) => '/' + segments.slice(0, i + 1).join('/'));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" onClick={handleNavigateUp}
            disabled={!parent || loading} sx={{ minWidth: 0, px: 1 }}>
            ↑
          </Button>
          <Breadcrumbs maxItems={4} sx={{ flex: 1, minWidth: 0 }}>
            {breadcrumbPaths.map((p, i) => (
              <Link key={p} component="button" variant="body2" underline="hover"
                onClick={() => loadDir(p)}
                color={i === breadcrumbPaths.length - 1 ? 'text.primary' : 'inherit'}
                sx={{ cursor: 'pointer', textAlign: 'left' }}>
                {segments[i]}
              </Link>
            ))}
          </Breadcrumbs>
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ minHeight: 300 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>
        ) : entries.length === 0 ? (
          <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
            This folder is empty
          </Typography>
        ) : (
          <List dense disablePadding>
            {entries.map(e => (
              <ListItem key={e.name} disablePadding>
                {e.type === 'dir' ? (
                  <ListItemButton onClick={() => loadDir(currentPath + '/' + e.name)}>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <FolderIcon fontSize="small" color="primary" />
                    </ListItemIcon>
                    <ListItemText primary={e.name} />
                  </ListItemButton>
                ) : (
                  <ListItem sx={{ pl: 2, cursor: 'default', opacity: 0.7 }}>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <InsertDriveFileIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={e.name} />
                  </ListItem>
                )}
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSelect} disabled={!currentPath || loading}>
          Select this folder
        </Button>
      </DialogActions>
    </Dialog>
  );
}
