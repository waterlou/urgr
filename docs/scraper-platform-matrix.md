# Scraper Platform Support Matrix

## Provider Categories

| Type | Providers | Coverage |
|------|-----------|----------|
| **API-based** (all platforms) | TheGamesDB, IGDB, ScreenScraper | Resolved dynamically via API — no local mapping needed |
| **MAME-specific** | ArcadeDB | Arcade/MAME only |
| **PSN-specific** | SonyStore | PlayStation Network only |
| **File-probe based** (mapped platforms) | NoIntroPictures, LibretroThumbnails, VGMuseum | ~30–50 platforms each with explicit folder/slug mappings |

## Platform Matrix

| Platform Family | Platform | ArcadeDB | VGMuseum | NoIntroPics | LibretroTn |
|---------------|----------|:--------:|:--------:|:-----------:|:----------:|
| **Nintendo** | NES / Famicom | — | ✓ | ✓ | ✓ |
| | Famicom Disk System | — | ✓ | ✓ | ✓ |
| | SNES / Super Famicom | — | ✓ | ✓ | ✓ |
| | N64 | — | ✓ | ✓ | ✓ |
| | GameCube | — | — | — | ✓ |
| | Wii | — | — | — | ✓ |
| | Virtual Boy | — | ✓ | — | ✓ |
| | Game Boy | — | ✓ | ✓ | ✓ |
| | Game Boy Color | — | ✓ | ✓ | ✓ |
| | Game Boy Advance | — | ✓ | ✓ | ✓ |
| | Nintendo DS | — | ✓ | ✓ | ✓ |
| | Nintendo 3DS | — | — | ✓ | ✓ |
| **Sega** | Master System | — | ✓ | ✓ | ✓ |
| | Mega Drive / Genesis | — | ✓ | ✓ | ✓ |
| | Saturn | — | ✓ | ✓ | ✓ |
| | Dreamcast | — | ✓ | ✓ | ✓ |
| | Game Gear | — | ✓ | ✓ | ✓ |
| | 32X | — | ✓ | — | ✓ |
| | Sega CD / Mega CD | — | ✓ | — | ✓ |
| | SG-1000 | — | ✓ | ✓ | ✓ |
| **Sony** | PlayStation / PS1 | — | ✓ | ✓ | ✓ |
| | PlayStation 2 | — | ✓ | ✓ | ✓ |
| | PlayStation 3 | — | — | — | ✓ |
| | PlayStation Portable | — | ✓ | ✓ | ✓ |
| | PlayStation Vita | — | — | — | ✓ |
| **NEC** | PC Engine / TG-16 | — | ✓ | ✓ | ✓ |
| | SuperGrafx | — | — | ✓ | ✓ |
| **SNK** | Neo Geo AES/MVS | — | ✓ | — | ✓ |
| | Neo Geo Pocket | — | ✓ | ✓ | ✓ |
| | Neo Geo Pocket Color | — | ✓ | ✓ | ✓ |
| | Neo Geo CD | — | ✓ | — | ✓ |
| **Atari** | Atari 2600 | — | ✓ | — | ✓ |
| | Atari 5200 | — | ✓ | — | ✓ |
| | Atari 7800 | — | ✓ | — | ✓ |
| | Jaguar | — | ✓ | — | ✓ |
| | Lynx | — | ✓ | — | ✓ |
| **Commodore** | Commodore 64 | — | ✓ | — | ✓ |
| | Amiga | — | ✓ | — | ✓ |
| **Microsoft** | MSX | — | ✓ | ✓ | ✓ |
| | MSX2 | — | ✓ | ✓ | ✓ |
| | DOS | — | — | — | ✓ |
| **Sinclair** | ZX Spectrum | — | ✓ | ✓ | ✓ |
| **Coleco** | ColecoVision | — | ✓ | ✓ | ✓ |
| **Fairchild** | Channel F | — | — | ✓ | ✓ |
| **Bandai** | WonderSwan | — | ✓ | ✓ | ✓ |
| | WonderSwan Color | — | ✓ | ✓ | ✓ |
| **Other** | 3DO | — | ✓ | — | — |
| | CD-i | — | ✓ | — | — |
| | Vectrex | — | ✓ | — | — |
| | Intellivision | — | ✓ | — | — |
| | Atomiswave | — | — | — | ✓ |
| **Arcade** | Arcade / MAME | **✓** | ✓ | ✓ | ✓ |
| | FBNeo | — | — | — | ✓ |

**Legend:**
- `—` = Not supported by this provider
- `✓` = Has an explicit platform mapping in the provider code
- API-based providers (TheGamesDB, IGDB, ScreenScraper) support all platforms dynamically and are not listed in the matrix.
