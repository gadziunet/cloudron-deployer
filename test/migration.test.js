import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('migracja ze starego układu: środowiska przypisane do serwerów stają się rodzajem serwera, domeny trafiają do serwerów', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-mig-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'wdrazacz.db'));
    old.exec(`
      CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, token_enc TEXT NOT NULL);
      CREATE TABLE environments (name TEXT PRIMARY KEY CHECK (name IN ('testowa','produkcja')), server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL);
      CREATE TABLE targets (repo TEXT NOT NULL, environment TEXT NOT NULL REFERENCES environments(name), app_domain TEXT NOT NULL, PRIMARY KEY (repo, environment));
      INSERT INTO servers(id, name, address, token_enc) VALUES (1, 'Dom', 'my.example.com', 'x'), (2, 'Prod', 'prod.example.com', 'x'), (3, 'Luzem', 'inny.example.com', 'x');
      INSERT INTO environments(name, server_id) VALUES ('testowa', 1), ('produkcja', 2);
      INSERT INTO targets(repo, environment, app_domain) VALUES ('o/r', 'testowa', 'app-dev.example.com'), ('o/r', 'produkcja', 'app.example.com');
    `);
    old.close();

    const db = openDb(dir);
    const kinds = Object.fromEntries(db.prepare('SELECT name, kind FROM servers').all().map((r) => [r.name, r.kind]));
    assert.deepEqual(kinds, { Dom: 'testowa', Prod: 'produkcja', Luzem: 'testowa' });
    const targets = db.prepare('SELECT server_id, app_domain FROM server_targets WHERE repo = ? ORDER BY server_id').all('o/r');
    assert.deepEqual(targets.map((t) => ({ ...t })), [
      { server_id: 1, app_domain: 'app-dev.example.com' },
      { server_id: 2, app_domain: 'app.example.com' },
    ]);
    db.close();

    // ponowne otwarcie nie psuje danych
    const again = openDb(dir);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM server_targets').get().n, 2);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
