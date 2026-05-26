Develop a webapp that can easily manage games roms. e.g. MAME, final burn neo, NDS, offlinelist, NoPlayStaton. Some of them provide DAT file with checksum, and checksum is eeesential to these ROM set (e.g. MAME, FBNeo), some are loosely handled by filename only.

Reference to the ROM List:

https://www.progettosnaps.net/dats/MAME/
https://git.libretro.com/libretro/FBNeo/-/tree/master/dats
https://nopaystation.com
https://github.com/libretro/libretro-database/tree/master/metadat/no-intro

Some rom set contains different versions, and some emulator may support older version only. So we must able to collect rom set for different versions for specific rom sets (MAME, FBNeo for now)

- Need a UI to add games in collections to libraries, so that we can export the games to a predefined foler structure later.

Future plan:
- Note, docs for each games that user can edit it and save the status of the game he play.
- Tools to upload games to hacked machine, or easier, run scp or ftp
