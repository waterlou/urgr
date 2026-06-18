export const ALL_SOURCES = [
  'arcadedb', 'thegamesdb', 'screenscraper', 'igdb',
  'libretro-thumbnails', 'no-intro-pictures', 'vgmuseum', 'sony-store',
  'progettosnaps',
]

export const SOURCE_LABELS = {
  arcadedb: 'ArcadeDB',
  thegamesdb: 'TheGamesDB',
  screenscraper: 'ScreenScraper',
  igdb: 'IGDB',
  'libretro-thumbnails': 'LibretroThumbnails',
  'no-intro-pictures': 'No-Intro Pictures',
  vgmuseum: 'VGMuseum',
  'sony-store': 'Sony PlayStation Store',
  progettosnaps: 'ProgettoSnaps (pre-downloaded)',
}

export const SCRAPE_PRESETS = {
  mame:      ['arcadedb'],
  fbneo:     ['arcadedb'],
  fbalpha43: ['arcadedb'],
  fbalpha44: ['arcadedb'],
  offlinelist: ['libretro-thumbnails', 'no-intro-pictures', 'thegamesdb', 'igdb'],
  datomatic:   ['libretro-thumbnails', 'no-intro-pictures', 'thegamesdb', 'igdb'],
  nps:         ['sony-store', 'igdb', 'thegamesdb'],
}

export function getInitialPriority(datasetPreset) {
  return SCRAPE_PRESETS[datasetPreset?.toLowerCase()] ?? [...ALL_SOURCES]
}
