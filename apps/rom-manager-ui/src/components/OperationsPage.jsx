import { useState } from 'react';
import {
  Box, Typography, Chip, Button, LinearProgress, Select, MenuItem,
  FormControl, InputLabel,
} from '@mui/material';
import { Cancel as CancelIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useOperations } from '../hooks/useOperations.js';
import { cancelOperation } from '../api.js';
import { useCollections } from '../contexts/CollectionContext.jsx';

export default function OperationsPage() {
  const navigate = useNavigate();
  const { collections } = useCollections();
  const [filter, setFilter] = useState('');
  const operations = useOperations(filter || undefined);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Typography variant="h6" fontWeight={600}>Operations</Typography>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Collection</InputLabel>
          <Select value={filter} onChange={e => setFilter(e.target.value)} label="Collection">
            <MenuItem value="">All</MenuItem>
            {collections.map(c => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
          </Select>
        </FormControl>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {operations.length === 0 ? (
          <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>No operations</Typography>
        ) : operations.map(op => (
          <Box key={op.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 1.5, mb: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" fontWeight={600}>{op.type}</Typography>
              <Typography variant="caption" color="text.secondary">{op.collection_name || ''} · {op.age || ''}</Typography>
            </Box>
            <Chip label={op.status} size="small" color={
              op.status === 'running' ? 'primary' : op.status === 'completed' ? 'success' : op.status === 'failed' ? 'error' : 'default'
            } />
            {op.progress != null && (
              <LinearProgress variant="determinate" value={op.progress} sx={{ width: 100 }} />
            )}
            {op.result && <Typography variant="caption">{op.result}</Typography>}
            {(op.status === 'running' || op.status === 'pending') && (
              <Button size="small" color="error" startIcon={<CancelIcon />}
                onClick={() => cancelOperation(op.id).catch(() => {})}>Cancel</Button>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
