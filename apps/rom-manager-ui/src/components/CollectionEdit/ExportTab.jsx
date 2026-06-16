import { Box } from '@mui/material';
import ExportPanel from '../ExportPanel.jsx';

export default function ExportTab({ collectionId }) {
  return (
    <Box>
      <ExportPanel collectionId={collectionId} />
    </Box>
  );
}
