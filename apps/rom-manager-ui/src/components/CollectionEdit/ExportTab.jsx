import { Box, Typography } from '@mui/material';
import ExportPanel from '../ExportPanel.jsx';

export default function ExportTab({ collectionId }) {
  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>Export</Typography>
      <ExportPanel collectionId={collectionId} />
    </Box>
  );
}
