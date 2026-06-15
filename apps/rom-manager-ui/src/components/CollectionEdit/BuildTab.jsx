import { Box, Typography, Divider } from '@mui/material';
import BuildManager from '../BuildManager.jsx';
import IaDownload from '../IaDownload.jsx';

export default function BuildTab({ collectionId, collection }) {
  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>Build</Typography>
      <BuildManager collectionId={collectionId} collection={collection} />
      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>Internet Archive Download</Typography>
      <IaDownload collectionId={collectionId} />
    </Box>
  );
}
