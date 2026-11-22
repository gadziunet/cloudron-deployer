import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { makeVault } from '../src/crypto.js';

let server, base, dir;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };
const quiet = { info() {}, warn() {} };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-'));
  const { app } = createApp({
    port: 0, dataDir: dir, appSecret: 'test-secret-1234567890',
    adminPassword: 'haslo-testowe-123', sessionMinutes: 5, secureCookie: false,
  }, quiet);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = (password) => fetch(`${base}/api/login`, {
  method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password }),
});

test('API bez sesji zwraca 401', async () => {
  for (const p of ['/api/me', '/api/servers', '/api/cokolwiek']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 401, p);
  }
});

test('logowanie blednym haslem jest odrzucone', async () => {
  const res = await login('zle');
  assert.equal(res.status, 401);
});

test('logowanie bez naglowka CSRF jest odrzucone', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'haslo-testowe-123' }),
  });
  assert.equal(res.status, 403);
});

test('poprawne logowanie daje ciasteczko HttpOnly i dostep do /api/me', async () => {
  const res = await login('haslo-testowe-123');
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const me = await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, 'admin');
});

test('wylogowanie niszczy sesje', async () => {
  const res = await login('haslo-testowe-123');
  const c = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { ...H, cookie: c } });
  const me = await fetch(`${base}/api/me`, { headers: { cookie: c } });
  assert.equal(me.status, 401);
});

test('strona glowna bez sesji pokazuje logowanie', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /logowanie/);
});

test('szyfrowanie tokenow: odczyt zwraca oryginal, blob nie zawiera jawnego tekstu', () => {
  const v = makeVault('test-secret-1234567890');
  const blob = v.encrypt('ghp_przykladowytoken');
  assert.ok(!blob.includes('ghp_'));
  assert.equal(v.decrypt(blob), 'ghp_przykladowytoken');
  assert.throws(() => makeVault('inny-sekret-1234567890').decrypt(blob));
});

test('limit prob logowania blokuje po 5 bledach', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await login('zle');
  assert.equal(last.status, 429);
});
