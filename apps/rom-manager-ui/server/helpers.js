import { getDb, initDb } from './db.js';
import { dbPath } from './paths.js';

export { dbPath };
export const dbReady = Promise.resolve(initDb(dbPath));

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params) || null;
}

export function run(sql, params = []) {
  getDb().prepare(sql).run(...params);
}

export function runNow(sql, params = []) {
  getDb().prepare(sql).run(...params);
}

export function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export const KNOWN_PLATFORMS = [
  { name: 'Arcade', slug: 'arcade' },
  { name: 'Multi', slug: 'multi' },
  { name: 'NES', slug: 'nes' },
  { name: 'SNES', slug: 'snes' },
  { name: 'Nintendo 64', slug: 'n64' },
  { name: 'Game Boy', slug: 'gb' },
  { name: 'Game Boy Color', slug: 'gbc' },
  { name: 'Game Boy Advance', slug: 'gba' },
  { name: 'Nintendo DS', slug: 'nds' },
  { name: 'Nintendo 3DS', slug: 'n3ds' },
  { name: 'Sega Genesis', slug: 'genesis' },
  { name: 'Sega Saturn', slug: 'saturn' },
  { name: 'Sega Dreamcast', slug: 'dreamcast' },
  { name: 'PlayStation', slug: 'psx' },
  { name: 'PlayStation 2', slug: 'ps2' },
  { name: 'PlayStation Portable', slug: 'psp' },
  { name: 'MSX', slug: 'msx' },
  { name: 'Commodore 64', slug: 'c64' },
  { name: 'Amiga', slug: 'amiga' },
  { name: 'Atari 2600', slug: 'atari2600' },
  { name: 'Atari 7800', slug: 'atari7800' },
  { name: 'TurboGrafx-16', slug: 'tg16' },
  { name: 'Neo Geo', slug: 'neogeo' },
  { name: 'Neo Geo Pocket', slug: 'ngp' },
  { name: 'WonderSwan', slug: 'wonderswan' },
];
