import { Box, Divider } from '@mui/material';
import BuildManager from '../BuildManager.jsx';
import IaDownload from '../IaDownload.jsx';

export default function BuildTab({ collectionId, collection }) {
  return (
    <Box>
      <BuildManager collectionId={collectionId} collection={collection} />
      <Divider sx={{ my: 3 }} />
      <IaDownload collectionId={collectionId} />
    </Box>
  );
}
