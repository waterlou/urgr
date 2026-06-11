import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirnameServer = path.dirname(__filename);

const isElectron = process.env.ELECTRON_RUN === '1';

// dataDir: Electron uses userData, standalone uses repo/data/
const dataDir = isElectron
  ? path.join(process.env.ELECTRON_USER_DATA || '', 'data')
  : path.resolve(__dirnameServer, '..', '..', '..', 'data');

const dbPath    = process.env.ROM_DB || path.join(dataDir, 'roms.db');
const envFile   = path.join(dataDir, '.env');
const cacheFile = path.join(dataDir, 'ia-cache.json');
const romsDir   = path.join(dataDir, 'roms');

// distDir: where the built Vite frontend lives
const distDir = isElectron
  ? path.join(process.env.ELECTRON_APP_ROOT || __dirnameServer, 'dist')
  : path.join(__dirnameServer, '..', 'dist');

// iconsDir: collection icons
const iconsDir = isElectron
  ? path.join(process.env.ELECTRON_APP_ROOT || __dirnameServer, '..', '..', '..', 'icons')
  : path.resolve(__dirnameServer, '..', '..', '..', 'icons');

// cliDir: Rust CLI binaries
const cliDir = path.resolve(__dirnameServer, '..', '..', 'target', 'release');

export { dataDir, dbPath, envFile, cacheFile, romsDir, distDir, iconsDir, cliDir, isElectron };
