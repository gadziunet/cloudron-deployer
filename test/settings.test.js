import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { normalizeAddress } from '../src/integrations.js';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };
const quiet = { info() {}, warn() {} };
let server, base, dir, cookie, db, calls, queryOnly = false;

// Atrapa sieci: GitHub akceptuje "gh-ok", Cloudron akceptuje "cl-ok"
const fakeFetch = async (url, opts = {}) => {
  calls.push({ url: String(url), auth: opts.headers?.Authorization });
  const auth = opts.headers?.Authorization;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (String(url).startsWith('https://api.github.com/user')) {
    return auth === 'Bearer gh-ok' ? json(200, { login: 'przyklad' }) : json(401, {});
  }
  if (/\/api\/v1\/(profile|apps)(\?|$)/.test(String(url))) {
    if (String(url).includes('offline.example.com')) throw new Error('ECONNREFUSED');
    const viaHeader = !queryOnly && auth === 'Bearer cl-ok';
    const viaQuery = String(url).includes('access_token=cl-ok');
    if (!viaHeader && !viaQuery) return json(401, { message: 'Invalid token' });
    return String(url).includes('/profile') ? json(200, { username: 'admin-cloudron' }) : json(200, { apps: [] });
  }
  return json(404, {});
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-'));
  const created = createApp({
    port: 0, dataDir: dir, appSecret: 'test-secret-1234567890',
    adminPassword: 'haslo-testowe-123', sessionMinutes: 5, secureCookie: false,
  }, quiet, { fetchFn: fakeFetch });
  db = created.db;
  await new Promise((r) => { server = created.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'haslo-testowe-123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (method, p, body) => fetch(base + p, {
  method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body),
});

test('normalizeAddress czyści adres i odrzuca śmieci', () => {
  assert.equal(normalizeAddress('https://My.Example.com/'), 'my.example.com');
  assert.equal(normalizeAddress('my.example.com:3000'), 'my.example.com:3000');
  assert.throws(() => normalizeAddress('zly adres'));
  assert.throws(() => normalizeAddress('a.com?x=1'));
});

test('GitHub: zły token odrzucony, dobry zapisany szyfrowany', async () => {
  calls = [];
  let r = await call('PUT', '/api/settings/github', { token: 'gh-zly' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/settings/github', { token: 'gh-ok' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).login, 'przyklad');
  const stored = db.prepare("SELECT value_enc FROM settings WHERE key = 'github_token'").get().value_enc;
  assert.ok(!stored.includes('gh-ok'));
  const status = await (await call('GET', '/api/settings/github')).json();
  assert.deepEqual(status, { configured: true, login: 'przyklad', expires: null });
  assert.ok(!JSON.stringify(status).includes('gh-ok'));
});

test('serwery: dodanie z poprawnym tokenem, token nigdy nie wraca w odpowiedzi', async () => {
  const bad = await call('POST', '/api/servers', { name: 'Test', address: 'test.example.com', token: 'cl-zly' });
  assert.equal(bad.status, 400);
  const offline = await call('POST', '/api/servers', { name: 'Off', address: 'offline.example.com', token: 'cl-ok' });
  assert.equal(offline.status, 502);

  const ok = await call('POST', '/api/servers', { name: 'Test', address: 'https://test.example.com/', token: 'cl-ok' });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.address, 'test.example.com');
  assert.ok(!JSON.stringify(body).includes('cl-ok'));

  const dup = await call('POST', '/api/servers', { name: 'Test', address: 'test.example.com', token: 'cl-ok' });
  assert.equal(dup.status, 400);

  const list = await (await call('GET', '/api/servers')).json();
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('cl-ok'));
  const enc = db.prepare('SELECT token_enc FROM servers').get().token_enc;
  assert.ok(!enc.includes('cl-ok'));
});

test('sprawdzenie serwera używa zapisanego tokenu', async () => {
  const id = db.prepare('SELECT id FROM servers').get().id;
  calls = [];
  const r = await call('POST', `/api/servers/${id}/check`);
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).auth, 'Bearer cl-ok');
});

test('środowiska: przypisanie serwera, nieznany serwer i środowisko odrzucone', async () => {
  const id = db.prepare('SELECT id FROM servers').get().id;
  let r = await call('PUT', '/api/environments/testowa', { server_id: id });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/environments/testowa', { server_id: 9999 });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/environments/inna', { server_id: id });
  assert.equal(r.status, 404);
  const envs = await (await call('GET', '/api/environments')).json();
  assert.deepEqual(envs.find((e) => e.name === 'testowa'), { name: 'testowa', server_id: id });
});

test('usunięcie serwera zeruje przypisanie środowiska', async () => {
  const id = db.prepare('SELECT id FROM servers').get().id;
  const r = await call('DELETE', `/api/servers/${id}`);
  assert.equal(r.status, 200);
  const envs = await (await call('GET', '/api/environments')).json();
  assert.equal(envs.find((e) => e.name === 'testowa').server_id, null);
});

test('zmiana hasła: za krótkie i błędne obecne hasło odrzucone, poprawna działa', async () => {
  let r = await call('POST', '/api/password', { current: 'haslo-testowe-123', next: 'krotkie' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/password', { current: 'zle-haslo', next: 'nowe-haslo-12345' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/password', { current: 'haslo-testowe-123', next: 'nowe-haslo-12345' });
  assert.equal(r.status, 200);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'nowe-haslo-12345' }) });
  assert.equal(login.status, 200);
});

test('endpointy ustawień bez sesji zwracają 401', async () => {
  for (const [m, p] of [['GET', '/api/servers'], ['PUT', '/api/settings/github'], ['DELETE', '/api/servers/1'], ['GET', '/api/environments']]) {
    const r = await fetch(base + p, { method: m, headers: H });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('daty ważności: zapis, zmiana bez tokenu, walidacja', async () => {
  let r = await call('PUT', '/api/settings/github', { token: 'gh-ok', expires: '2026-12-31' });
  assert.equal((await r.json()).expires, '2026-12-31');
  assert.equal((await (await call('GET', '/api/settings/github')).json()).expires, '2026-12-31');

  r = await call('PATCH', '/api/settings/github', { expires: '2027-01-15' });
  assert.equal((await r.json()).expires, '2027-01-15');
  r = await call('PATCH', '/api/settings/github', { expires: '2027-02-30' });
  assert.equal(r.status, 400);
  r = await call('PATCH', '/api/settings/github', { expires: 'jutro' });
  assert.equal(r.status, 400);
  r = await call('PATCH', '/api/settings/github', { expires: '' });
  assert.equal((await r.json()).expires, null);

  r = await call('POST', '/api/servers', { name: 'Prod', address: 'prod.example.com', token: 'cl-ok', expires: '2026-12-01' });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  let list = await (await call('GET', '/api/servers')).json();
  assert.equal(list.find((s) => s.id === id).expires, '2026-12-01');
  r = await call('PATCH', `/api/servers/${id}`, { expires: '2027-03-01' });
  assert.equal(r.status, 200);
  list = await (await call('GET', '/api/servers')).json();
  assert.equal(list.find((s) => s.id === id).expires, '2027-03-01');
  r = await call('PATCH', '/api/servers/9999', { expires: '2027-03-01' });
  assert.equal(r.status, 404);
  r = await call('POST', '/api/servers', { name: 'Zly', address: 'x.example.com', token: 'cl-ok', expires: '31.12.2026' });
  assert.equal(r.status, 400);
});

test('/api/alerts wymaga sesji i zwraca ostrzeżenie dla wygasłej daty', async () => {
  assert.equal((await fetch(`${base}/api/alerts`)).status, 401);
  await call('PATCH', '/api/settings/github', { expires: '2020-01-01' });
  const alerts = await (await call('GET', '/api/alerts')).json();
  const gh = alerts.find((a) => a.kind === 'github');
  assert.ok(gh && gh.expired);
});

test('serwer przyjmujący token tylko w adresie (jak CLI) też działa', async () => {
  queryOnly = true;
  try {
    const r = await call('POST', '/api/servers', { name: 'Query', address: 'query.example.com', token: 'cl-ok' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).username, 'admin-cloudron');
  } finally { queryOnly = false; }
});

test('odrzucony token: komunikat zawiera odpowiedź Cloudrona', async () => {
  const r = await call('POST', '/api/servers', { name: 'Zly', address: 'zly.example.com', token: 'cl-zly' });
  assert.equal(r.status, 400);
  const { error } = await r.json();
  assert.match(error, /401/);
  assert.match(error, /Invalid token/);
});
