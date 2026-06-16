# Version Reference Counts

Expected game counts per version, verified against clrmamepro where available.

## Current Database

| ID | Source | Version | Games | ROMs | Notes |
|----|--------|---------|-------|------|-------|
| 1 | MAME | 0.288 | 50105 | 368078 | MAME listxml format |
| 2 | FBNeo | nightly | 22682 | 190395 | ClrMAMEPro format |
| 3 | NPS | PSV | 2147 | 13249 | NPS format |
| 4 | NPS | PSP | 1222 | 1962 | NPS format |
| 5 | MAME | 0.78 | 4720 | 70763 | MAME listxml format |
| 6 | MAME | 0.41 | 1355 | 32028 | MAME listxml format |
| 7 | MAME | 0.256 | 45875 | 343995 | Logiqx XML from `progettosnaps.net` |
| 8 | MAME | 0.37b5 | 2241 | 34222 | Logiqx XML from `progettosnaps.net` |

## Verified Against clrmamepro

| Version | DAT Source | Our Count | clrmamepro | Match? |
|---------|-----------|-----------|------------|--------|
| 0.256 | `MAME_Dats_256/XML/mame256.xml` | 45875 | 45875 | Yes |
| 0.37b5 | `MAME Dats 0.037/MAME 0.37b5.dat` | 2241 | 2241 | Yes |

## Known Differences Explained

### 0.256: +14 sampleof stubs

Our parser generates stub `ParsedGame` entries for `sampleof` references that don't have a matching `<machine>` element. clrmamepro does the same. Without this, count would be 45861.

Missing names: `MM1_keyboard`, `bbc`, `fantasy`, `fruitsamples`, `ftaerobi`, `genpin`, `moepro`, `moepro88`, `moepro90`, `mpsaikyo`, `mptennis`, `relay`, `smoepro`, `terao`

### 0.37b5: Empty element depth tracking

Parser had a bug where empty text elements (`<manufacturer></manufacturer>`) caused the depth tracking in `parse_game`/`parse_machine` to drift, consuming subsequent games. Fixed by reading all content up to the matching `</end>` tag and decrementing depth accordingly.

Fixed in: `libs/rom-manager/src/dat/logiqx.rs` and `libs/rom-manager/src/dat/mame.rs`
