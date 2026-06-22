# Scraper Platform Support Matrix

## Provider Categories

| Type | Providers | Coverage |
|------|-----------|----------|
| **API-based** (all platforms) | TheGamesDB, IGDB, ScreenScraper, MobyGames, SteamGridDB | Resolved dynamically via API — no local mapping needed |
| **MAME-specific** | ArcadeDB | Arcade/MAME only |
| **PSN-specific** | SonyStore | PlayStation Network only |
| **Hash-based with platform mapping** | RetroAchievements | 42 explicitly mapped platforms (NES, SNES, Genesis, Arcade, etc.) |
| **File-probe based** (mapped platforms) | NoIntroPictures, LibretroThumbnails, VGMuseum | ~30–50 platforms each with explicit folder/slug mappings |

## Platform Matrix

MobyGames and SteamGridDB are API-based (cover all platforms). RetroAchievements has 42 mapped console IDs.

| Platform Family | Platform | ArcadeDB | VGMuseum | NoIntroPics | LibretroTn | MobyGames | RAchievemts | SteamGridDB |
|---------------|----------|:--------:|:--------:|:-----------:|:----------:|:---------:|:-----------:|:-----------:|
| **Nintendo** | NES / Famicom | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Famicom Disk System | — | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| | SNES / Super Famicom | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | N64 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | GameCube | — | — | — | ✓ | ✓ | ✓ | ✓ |
| | Wii | — | — | — | ✓ | ✓ | ✓ | ✓ |
| | Virtual Boy | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Game Boy | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Game Boy Color | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Game Boy Advance | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Nintendo DS | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Nintendo 3DS | — | — | ✓ | ✓ | ✓ | — | ✓ |
| **Sega** | Master System | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Mega Drive / Genesis | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Saturn | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Dreamcast | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Game Gear | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | 32X | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Sega CD / Mega CD | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | SG-1000 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Sony** | PlayStation / PS1 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | PlayStation 2 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | PlayStation 3 | — | — | — | ✓ | ✓ | ✓ | ✓ |
| | PlayStation Portable | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | PlayStation Vita | — | — | — | ✓ | ✓ | ✓ | ✓ |
| **NEC** | PC Engine / TG-16 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | SuperGrafx | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| **SNK** | Neo Geo AES/MVS | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Neo Geo Pocket | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Neo Geo Pocket Color | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | Neo Geo CD | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| **Atari** | Atari 2600 | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Atari 5200 | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Atari 7800 | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Jaguar | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Lynx | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| **Commodore** | Commodore 64 | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| | Amiga | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| **Microsoft** | MSX | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | MSX2 | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | DOS | — | — | — | ✓ | ✓ | ✓ | ✓ |
| **Sinclair** | ZX Spectrum | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Coleco** | ColecoVision | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Fairchild** | Channel F | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Bandai** | WonderSwan | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | WonderSwan Color | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Other** | 3DO | — | ✓ | — | — | ✓ | — | ✓ |
| | CD-i | — | ✓ | — | — | ✓ | — | ✓ |
| | Vectrex | — | ✓ | — | — | ✓ | — | ✓ |
| | Intellivision | — | ✓ | — | — | ✓ | — | ✓ |
| | Atomiswave | — | — | — | ✓ | ✓ | ✓ | ✓ |
| **Arcade** | Arcade / MAME | **✓** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| | FBNeo | — | — | — | ✓ | ✓ | ✓ | ✓ |

**Legend:**
- `—` = Not supported by this provider
- `✓` = Has an explicit platform mapping in the provider code
- API-based providers (TheGamesDB, IGDB, ScreenScraper, MobyGames, SteamGridDB) support all platforms dynamically and are not marked in the matrix — they are added as columns with `✓` for all rows for at-a-glance comparison.
- RetroAchievements (`RAchievemts`) has 42 explicitly mapped console IDs covering most major platforms. Unmapped platforms show `—`.
