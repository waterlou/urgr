import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
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

export function initUsersDb() {
  dbFilePath = path.join(dataDir, USERS_DB_FILENAME);

  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  return db;
}

export function getUsersDb() {
  return db;
}

export function saveUsersDb() {}

export function closeUsersDb() {
  if (db) db.close();
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

export function run(sql, params = []) {
  db.prepare(sql).run(...params);
}
