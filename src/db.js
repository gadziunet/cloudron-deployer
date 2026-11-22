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

  // rodzaj operacji w historii: update (aktualizacja) albo install (nowa instalacja)
  const depCols = db.prepare('PRAGMA table_info(deployments)').all().map((c) => c.name);
  if (!depCols.includes('action')) db.exec("ALTER TABLE deployments ADD COLUMN action TEXT NOT NULL DEFAULT 'update'");

  // wiele serwerow: kazdy serwer ma rodzaj (testowa/produkcja), a domena aplikacji jest per serwer
  db.exec(`CREATE TABLE IF NOT EXISTS server_targets (
    repo TEXT NOT NULL,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    app_domain TEXT NOT NULL,
    PRIMARY KEY (repo, server_id)
  )`);
  if (!cols.includes('kind')) {
    db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'testowa'");
    // przeniesienie dotychczasowego przypisania srodowisk i zapamietanych domen
    db.exec(`UPDATE servers SET kind = (SELECT e.name FROM environments e WHERE e.server_id = servers.id LIMIT 1)
             WHERE id IN (SELECT server_id FROM environments WHERE server_id IS NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO server_targets(repo, server_id, app_domain)
             SELECT t.repo, e.server_id, t.app_domain FROM targets t
             JOIN environments e ON e.name = t.environment WHERE e.server_id IS NOT NULL`);
  }
  return db;
}
