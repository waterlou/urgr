# Scraper Analysis & Improvement Plan

## Comparison: Our Scraper vs Batocera Linux

### Our Architecture

- **Language**: Rust (standalone CLI binary `scraper-cli`)
- **Library**: `libs/rom-scraper/` — provider modules under `src/sources/`
- **Output**: JSON over stdout, designed for server-side (Node.js) consumption
- **Providers**: TheGamesDB, ScreenScraper, IGDB, NoIntroPictures, VGMuseum, SonyStore
- **Matching**: Priority-based fan-out by name → hash fallback
- **Media**: Covers + screenshots only

### Batocera Architecture (C++, compiled into EmulationStation)

| Feature | Batocera | Us | Priority |
|---------|----------|----|----------|
| **ArcadeDB source** | Dedicated MAME scraper at `adb.arcadeitalia.net` | No MAME-specific source | **High** |
| **Video scraping** | ScreenScraper video URLs in output | Videos dropped in output model | **Medium** |
| **Multi-region fallback** | ROM language → system lang → World → US → EU → JP | No fallback chain | **Medium** |
| **Media types** | 20+ (marquee, wheel, fanart, titleshot, cartridge, map, manual, bezel) | Only covers + screenshots | **Low** (nice-to-have) |
| **Rate limit handling** | Reads `Retry-After` header, pauses | No handling | **High** |
| **Threading** | Configurable thread count | Single-threaded | **Medium** |
| **Hash matching** | MD5 only (1MB–128MB range) | CRC32, MD5, SHA1 via ScreenScraper | **Already better** |

### Key Batocera Design Decisions

1. **Scraper as part of frontend** — compiled into EmulationStation, not standalone. Makes automation harder but integration tighter.
2. **Compile-time feature gating** — ScreenScraper, TheGamesDB, HfsDB require API keys compiled in via `-D` flags. Different builds have different capabilities.
3. **XML-based metadata storage** — `gamelist.xml` per system directory instead of SQL database.
4. **Two-phase scraping** — Search → resolve (download images). Search results shown before media is downloaded.
5. **ArcadeDB**: Dedicated MAME scraper at `http://adb.arcadeitalia.net/service_scraper.php?ajax=query_mame` — returns MAME short names, clone info, screenshots, videos, marquees.
6. **ScreenScraper FastScrap mode**: Constructs direct image URLs instead of API redirect — reduces server load.

## Improvement Plan

### 1. Rate Limit Handling (High Priority)
- Add `Retry-After` header parsing to `HttpClient`
- On 429 response, extract seconds from header, sleep, then retry once
- Prevents scraper-cli from hitting API limits and losing data

### 2. ArcadeDB Source (High Priority)
- New provider at `adb.arcadeitalia.net/service_scraper.php`
- MAME-specific — takes MAME short name as query
- Returns: screenshot, box2d, marquee, title shot, video, short title
- Critical for MAME/FBNeo collections

### 3. Video URL Passthrough (Medium Priority)
- ScreenScraper already returns video URLs in its API response
- Our `ScrapeMatch` and `DetailOutput` models need a `videos` field
- Server-side can use this for EmulatorJS video preview or gallery

### 4. Multi-Region Fallback (Medium Priority)
- For ScreenScraper, when getting game names, try region chain:
  `rom_language → system_language → WOR → US → EU → JP → SS → CUS`
- For media, same fallback chain per media type

### Future Ideas
- Multi-threaded batch scraping
- Image resizing/download optimization
- Configurable output media types
