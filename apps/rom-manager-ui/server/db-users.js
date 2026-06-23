import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import { dataDir } from './paths.js';

const USERS_DB_FILENAME = 'users.db';
let db = null;
let dbFilePath = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_notes (
    game_id    INTEGER PRIMARY KEY,
    notes      TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
);
`;

let saveTimeout = null;

export async function initUsersDb() {
  const SQL = await initSqlJs();
  dbFilePath = path.join(dataDir, USERS_DB_FILENAME);

  if (fs.existsSync(dbFilePath)) {
    const buffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run(SCHEMA);

  return db;
}

export function getUsersDb() {
  return db;
}

function saveDebounced() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveUsersDb();
  }, 200);
}

export function saveUsersDb() {
  if (db && dbFilePath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  }
}

export function closeUsersDb() {
  if (db) db.close();
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

export function run(sql, params = []) {
  db.run(sql, params);
  saveDebounced();
}
