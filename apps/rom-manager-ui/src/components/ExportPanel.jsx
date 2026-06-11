import { useState } from 'react';
import {
  Box, Typography, Button, Select, MenuItem, FormControl, InputLabel,
} from '@mui/material';
import { exportCollection } from '../api.js';

export default function ExportPanel({ collectionId }) {
  const [exportFormat, setExportFormat] = useState('split');
  const [exportData, setExportData] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const data = await exportCollection(collectionId, { format: exportFormat });
      setExportData(data);
    } catch (e) {
      console.error(e);
    } finally { setExporting(false); }
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>Export</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Format</InputLabel>
          <Select value={exportFormat} onChange={e => setExportFormat(e.target.value)} label="Format">
            <MenuItem value="split">Split</MenuItem>
            <MenuItem value="merged">Merged</MenuItem>
            <MenuItem value="non-merged">Non-merged</MenuItem>
          </Select>
        </FormControl>
        <Button variant="contained" onClick={handleExport} disabled={exporting}>Generate</Button>
      </Box>
      {exportData && (
        <Box component="pre" sx={{ mt: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
          {JSON.stringify(exportData, null, 2)}
        </Box>
      )}
    </Box>
  );
}
