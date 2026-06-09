// Maps platform names to EmulatorJS core identifiers
// See https://emulatorjs.org/docs4devs/cores for the full cores list

const PLATFORM_TO_CORE = {
  // Nintendo
  'nes': 'nes',
  'nintendo entertainment system': 'nes',
  'famicom': 'nes',
  'snes': 'snes',
  'super nintendo': 'snes',
  'super nintendo entertainment system': 'snes',
  'super famicom': 'snes',
  'nintendo 64': 'n64',
  'n64': 'n64',
  'game boy': 'gb',
  'gb': 'gb',
  'game boy color': 'gb',
  'gbc': 'gb',
  'game boy advance': 'gba',
  'gba': 'gba',
  'nintendo ds': 'nds',
  'nds': 'nds',
  'virtual boy': 'vb',

  // Sega
  'sega genesis': 'segaMD',
  'genesis': 'segaMD',
  'sega mega drive': 'segaMD',
  'mega drive': 'segaMD',
  'sega mega-drive': 'segaMD',
  'sega master system': 'segaMS',
  'master system': 'segaMS',
  'sega game gear': 'segaGG',
  'game gear': 'segaGG',
  'sega saturn': 'segaSaturn',
  'saturn': 'segaSaturn',
  'sega cd': 'segaCD',
  'sega-cd': 'segaCD',
  'sega 32x': 'sega32x',
  'sega-d': 'sega32x',

  // Sony
  'playstation': 'psx',
  'psx': 'psx',
  'ps1': 'psx',
  'playstation portable': 'psp',
  'psp': 'psp',

  // Atari
  'atari 2600': 'atari2600',
  'atari7800': 'atari7800',
  'atari 7800': 'atari7800',
  'atari lynx': 'lynx',
  'lynx': 'lynx',
  'atari jaguar': 'jaguar',
  'jaguar': 'jaguar',

  // Arcade
  'arcade': 'fbneo',
  'mame': 'mame2003',
  'mame 2003': 'mame2003',
  'fbneo': 'fbneo',
  'final burn neo': 'fbneo',

  // Other
  'commodore 64': 'c64',
  'c64': 'c64',
  'commodore amiga': 'amiga',
  'amiga': 'amiga',
  'neo geo pocket': 'ngp',
  'neo geo': 'arcade',
  'wonderswan': 'ws',
  'wonder swan': 'ws',
  'turbografx-16': 'pce',
  'turbo grafx 16': 'pce',
  'pc engine': 'pce',
  'colecovision': 'coleco',
  '3do': '3do',
  'dos': 'dos',
}

// Normalize platform name for lookup (lowercase, trim)
function normalizePlatform(p) {
  return (p || '').toLowerCase().trim()
}

// Get EmulatorJS core name for a platform, or null if unsupported
export function getEmulatorCore(platform) {
  const key = normalizePlatform(platform)
  return PLATFORM_TO_CORE[key] || null
}

// Check if a platform is supported by EmulatorJS
export function isEmulatorSupported(platform) {
  return getEmulatorCore(platform) !== null
}

// Get all supported platforms (for reference)
export function getSupportedPlatforms() {
  const unique = new Set(Object.values(PLATFORM_TO_CORE))
  return [...unique].sort()
}
