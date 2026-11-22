import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { parseGithubUsername } from '../src/registry.js';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };
const quiet = { info() {}, warn() {} };
let server, base, dir, cookie, requests, registries, listStatus, postRules;

const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });

// Atrapa: GitHub i dwa serwery Cloudron (a.example.com, b.example.com)
const fakeFetch = async (url, opts = {}) => {
  const u = String(url);
  const auth = opts.headers?.Authorization;
  if (u === 'https://api.github.com/user') return json(200, { login: 'konto-tokenu' });
  const m = /^https:\/\/([a-z]\.example\.com)(\/api\/v1\/[^?]*)/.exec(u);
  if (!m) return json(404, {});
  const [, host, apiPath] = m;
  if (auth !== 'Bearer cl-ok' && !u.includes('access_token=cl-ok')) return json(401, { message: 'Invalid token' });
  requests.push({ host, apiPath, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  if (apiPath === '/api/v1/apps') return json(200, { apps: [] });
  if (apiPath === '/api/v1/profile') return json(200, { username: 'admin' });
  if (apiPath === '/api/v1/docker/registries' && (opts.method || 'GET') === 'GET') {
    return listStatus === 200 ? json(200, { registries: registries[host] || [] }) : json(listStatus, { message: 'Not found' });
  }
  if (apiPath.startsWith('/api/v1/docker/registries') && opts.method === 'POST') {
    const rule = postRules[host];
    if (rule) { const r = rule(JSON.parse(opts.body)); if (r) return r; }
    return apiPath === '/api/v1/docker/registries' ? json(201, { id: 'nowy' }) : { status: 204, ok: true, json: async () => ({}), text: async () => '' };
  }
  return json(404, {});
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-'));
  const created = createApp({
    port: 0, dataDir: dir, appSecret: 'test-secret-1234567890',
    adminPassword: 'haslo-testowe-123', sessionMinutes: 5, secureCookie: false,
  }, quiet, { fetchFn: fakeFetch });
  await new Promise((r) => { server = created.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'haslo-testowe-123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (method, p, body) => fetch(base + p, {
  method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body),
});
const reset = () => { requests = []; registries = {}; listStatus = 200; postRules = {}; };
const posts = () => requests.filter((r) => r.method === 'POST' && r.apiPath.startsWith('/api/v1/docker/registries'));

test('parseGithubUsername: poprawna, pusta i zła nazwa', () => {
  assert.equal(parseGithubUsername('  przyklad-1 '), 'przyklad-1');
  assert.equal(parseGithubUsername(''), null);
  assert.throws(() => parseGithubUsername('zly uzytkownik'));
  assert.throws(() => parseGithubUsername('-zly'));
});

test('serwer dodany bez tokenu GitHub: brak synchronizacji, serwer zapisany', async () => {
  reset();
  const r = await call('POST', '/api/servers', { name: 'A', address: 'a.example.com', token: 'cl-ok' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).registry, null);
  assert.equal(posts().length, 0);
});

test('zapis tokenu GitHub dodaje ghcr.io na wszystkich serwerach, domyślnie z loginem tokenu', async () => {
  reset();
  await call('POST', '/api/servers', { name: 'B', address: 'b.example.com', token: 'cl-ok' });
  reset();
  const r = await call('PUT', '/api/settings/github', { token: 'gh-token-123' });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.registry.length, 2);
  assert.ok(data.registry.every((x) => x.ok && x.action === 'added'));
  assert.ok(!JSON.stringify(data).includes('gh-token-123'));
  const ps = posts();
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0].body, { serverAddress: 'ghcr.io', username: 'konto-tokenu', password: 'gh-token-123' });
  assert.equal(ps[0].apiPath, '/api/v1/docker/registries');
});

test('istniejący wpis ghcr.io jest aktualizowany (POST na /:id), inne rejestry nietknięte', async () => {
  reset();
  registries = { 'a.example.com': [{ id: 'r1', serverAddress: 'registry.example.com' }, { id: 'r2', serverAddress: 'ghcr.io' }] };
  const r = await call('POST', '/api/registry/sync', {});
  const { registry } = await r.json();
  const a = registry.find((x) => x.server === 'A');
  assert.equal(a.action, 'updated');
  const upd = posts().find((p) => p.host === 'a.example.com');
  assert.equal(upd.apiPath, '/api/v1/docker/registries/r2');
  assert.ok(!posts().some((p) => p.apiPath.endsWith('/r1')));
  assert.equal(registry.find((x) => x.server === 'B').action, 'added');
});

test('własna nazwa użytkownika zastępuje login tokenu i uruchamia synchronizację', async () => {
  reset();
  const r = await call('PATCH', '/api/settings/github', { username: 'inny-uzytkownik' });
  const data = await r.json();
  assert.equal(data.username, 'inny-uzytkownik');
  assert.equal(data.registry.length, 2);
  assert.ok(posts().every((p) => p.body.username === 'inny-uzytkownik'));
  const status = await (await call('GET', '/api/settings/github')).json();
  assert.equal(status.username, 'inny-uzytkownik');
  assert.equal((await call('PATCH', '/api/settings/github', { username: 'zly uzytkownik' })).status, 400);
});

test('zmiana samej daty ważności nie uruchamia synchronizacji', async () => {
  reset();
  const r = await call('PATCH', '/api/settings/github', { expires: '2027-05-01' });
  assert.equal(r.status, 200);
  assert.equal(posts().length, 0);
});

test('pole z adresem: gdy serverAddress daje 400, próbujemy server', async () => {
  reset();
  postRules['a.example.com'] = (body) => ('serverAddress' in body ? json(400, { message: 'server is required' }) : null);
  const r = await call('POST', '/api/registry/sync', { server_id: (await (await call('GET', '/api/servers')).json()).find((s) => s.name === 'A').id });
  const [a] = (await r.json()).registry;
  assert.equal(a.ok, true);
  assert.deepEqual(posts().map((p) => Object.keys(p.body)[0]), ['serverAddress', 'server']);
});

test('błąd jednego serwera nie blokuje drugiego i pokazuje odpowiedź Cloudrona', async () => {
  reset();
  postRules['a.example.com'] = () => json(500, { message: 'blad wewnetrzny' });
  const { registry } = await (await call('POST', '/api/registry/sync', {})).json();
  const a = registry.find((x) => x.server === 'A');
  const b = registry.find((x) => x.server === 'B');
  assert.equal(a.ok, false);
  assert.match(a.message, /500: blad wewnetrzny/);
  assert.equal(b.ok, true);
});

test('Cloudron bez wielu rejestrów (404): czytelny komunikat, nic nie nadpisane', async () => {
  reset(); listStatus = 404;
  const { registry } = await (await call('POST', '/api/registry/sync', {})).json();
  assert.ok(registry.every((x) => !x.ok && /nie obsluguje wielu rejestrow/.test(x.message)));
  assert.equal(posts().length, 0);
});

test('synchronizacja bez sesji: 401, a bez tokenu GitHub: 409', async () => {
  assert.equal((await fetch(`${base}/api/registry/sync`, { method: 'POST', headers: H })).status, 401);
  await call('DELETE', '/api/settings/github');
  const r = await call('POST', '/api/registry/sync', {});
  assert.equal(r.status, 409);
});
