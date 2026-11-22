import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'wdrazacz.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      token_enc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS environments (
      name TEXT PRIMARY KEY CHECK (name IN ('testowa','produkcja')),
      server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS targets (
      repo TEXT NOT NULL,
      environment TEXT NOT NULL REFERENCES environments(name),
      app_domain TEXT NOT NULL,
      PRIMARY KEY (repo, environment)
    );
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      tag TEXT NOT NULL,
      environment TEXT NOT NULL,
      server_name TEXT,
      app_domain TEXT,
      status TEXT NOT NULL,
      log TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    INSERT OR IGNORE INTO environments(name) VALUES ('testowa'), ('produkcja');
  `);
  // migracja: data ważności tokenu serwera (YYYY-MM-DD, wpisywana ręcznie)
  const cols = db.prepare('PRAGMA table_info(servers)').all().map((c) => c.name);
  if (!cols.includes('token_expires')) db.exec('ALTER TABLE servers ADD COLUMN token_expires TEXT');
  return db;
}
