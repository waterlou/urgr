import { getDb, saveDb, initDb } from './db.js';
import { dbPath } from './paths.js';

export { dbPath };
export const dbReady = Promise.resolve(initDb(dbPath));

export function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

let saveTimeout = null;
function saveDebounced() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveDb();
  }, 200);
}

export function run(sql, params = []) {
  getDb().run(sql, params);
  saveDebounced();
}

/** Force an immediate save (for process exit / critical ops) */
export function runNow(sql, params = []) {
  getDb().run(sql, params);
  saveDb();
}

export function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export const KNOWN_PLATFORMS = [
  'Arcade', 'Multi', 'NES', 'SNES', 'Nintendo 64', 'Game Boy', 'Game Boy Color',
  'Game Boy Advance', 'Nintendo DS', 'Nintendo 3DS', 'Sega Genesis', 'Sega Saturn',
  'Sega Dreamcast', 'PlayStation', 'PlayStation 2', 'PlayStation Portable',
  'MSX', 'Commodore 64', 'Amiga', 'Atari 2600', 'Atari 7800', 'TurboGrafx-16',
  'Neo Geo', 'Neo Geo Pocket', 'WonderSwan',
];
