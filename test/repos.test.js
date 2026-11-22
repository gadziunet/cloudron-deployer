import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { sortTags, latestTag } from '../src/tags.js';
import { checkRepoName } from '../src/github.js';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };
const quiet = { info() {}, warn() {} };
let server, base, dir, cookie, githubCalls, ghcrTags = null;

const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
const fakeFetch = async (url) => {
  const u = String(url);
  githubCalls.push(u);
  if (u === 'https://api.github.com/user') return json(200, { login: 'przyklad' });
  if (u.startsWith('https://api.github.com/user/repos')) {
    return json(200, [
      { full_name: 'przyklad/aplikacja-a', description: 'Opis A', private: true, pushed_at: '2026-11-01T10:00:00Z', archived: false },
      { full_name: 'przyklad/stare', description: '', private: false, pushed_at: '2020-01-01T10:00:00Z', archived: true },
    ]);
  }
  if (u.startsWith('https://api.github.com/repos/przyklad/aplikacja-a/tags')) {
    return json(200, [{ name: 'v0.9.0' }, { name: 'v0.10.0' }, { name: 'v1.0.0-rc1' }, { name: 'v0.3.1' }, { name: 'nightly' }]);
  }
  if (u.startsWith('https://ghcr.io/token')) return ghcrTags === null ? json(403, {}) : json(200, { token: 'b' });
  if (u.startsWith('https://ghcr.io/v2/przyklad/aplikacja-a/tags/list')) return json(200, { tags: ghcrTags });
  if (u.includes('/repos/')) return json(404, {});
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
  githubCalls = [];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (method, p, body) => fetch(base + p, {
  method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body),
});

test('sortTags: semver malejąco, wersja wstępna niżej niż wydanie, reszta na końcu', () => {
  const sorted = sortTags(['v0.9.0', 'v0.10.0', 'v1.0.0-rc1', 'v0.3.1', 'nightly']);
  assert.deepEqual(sorted.map((t) => t.name), ['v1.0.0-rc1', 'v0.10.0', 'v0.9.0', 'v0.3.1', 'nightly']);
  assert.equal(latestTag(sorted), 'v0.10.0');   // stabilny, nie rc
  assert.equal(latestTag(sortTags(['v1.0.0-rc1', 'v1.0.0'])), 'v1.0.0');
  assert.equal(latestTag(sortTags(['b', 'a'])), 'b');
  assert.equal(latestTag([]), null);
});

test('bez tokenu GitHub lista repozytoriów zwraca czytelny błąd 409', async () => {
  const r = await call('GET', '/api/repos');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /token GitHub/);
});

test('lista repozytoriów pomija zarchiwizowane i nie zdradza tokenu', async () => {
  await call('PUT', '/api/settings/github', { token: 'gh-ok' });
  const r = await call('GET', '/api/repos');
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.deepEqual(list.map((x) => x.full_name), ['przyklad/aplikacja-a']);
  assert.ok(!JSON.stringify(list).includes('gh-ok'));
});

test('tagi: posortowane i z najnowszym stabilnym', async () => {
  const r = await call('GET', '/api/repos/przyklad/aplikacja-a/tags');
  const data = await r.json();
  assert.equal(data.latest, 'v0.10.0');
  assert.equal(data.tags[0].name, 'v1.0.0-rc1');
  assert.equal(data.tags[0].prerelease, true);
});

test('nieistniejące repozytorium daje 404, a dziwna nazwa 400', async () => {
  assert.equal((await call('GET', '/api/repos/przyklad/nie-ma/tags')).status, 404);
  assert.equal((await call('GET', '/api/repos/przyklad/a%24b/tags')).status, 400);
  assert.throws(() => checkRepoName('przyklad', '..'));
  assert.throws(() => checkRepoName('..', 'x'));
  assert.equal((await call('GET', '/api/repos/prz%20yklad/x/tags')).status, 400);
});

test('cache: drugie zapytanie o repozytoria nie woła GitHuba ponownie', async () => {
  await call('GET', '/api/repos');
  const before = githubCalls.length;
  await call('GET', '/api/repos');
  assert.equal(githubCalls.length, before);
});

test('domena aplikacji jest zapamiętywana osobno dla środowisk', async () => {
  const get = async () => (await call('GET', '/api/repos/przyklad/aplikacja-a/targets')).json();
  assert.deepEqual(await get(), { testowa: null, produkcja: null });
  let r = await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/testowa', { app_domain: 'https://App-Dev.example.com/' });
  assert.equal((await r.json()).app_domain, 'app-dev.example.com');
  await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/produkcja', { app_domain: 'app.example.com' });
  assert.deepEqual(await get(), { testowa: 'app-dev.example.com', produkcja: 'app.example.com' });
  await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/testowa', { app_domain: 'app-dev2.example.com' });
  assert.equal((await get()).testowa, 'app-dev2.example.com');
  assert.equal((await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/inna', { app_domain: 'x.example.com' })).status, 404);
  assert.equal((await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/testowa', { app_domain: 'zly adres' })).status, 400);
});

test('endpointy repozytoriów bez sesji zwracają 401', async () => {
  for (const p of ['/api/repos', '/api/repos/przyklad/aplikacja-a/tags', '/api/repos/przyklad/aplikacja-a/targets']) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
});

test('tagi: obrazy z ghcr.io i tagi git razem, obraz oznaczony, brak ostrzeżenia', async () => {
  ghcrTags = ['0.3.1', '0.2.0', 'v0.9.0'];
  const data = await (await call('GET', '/api/repos/przyklad/aplikacja-a/tags')).json();
  assert.equal(data.warning, null);
  assert.equal(data.latest, 'v0.10.0');   // git ma wyzej niz obrazy
  const byName = Object.fromEntries(data.tags.map((t) => [t.name, t]));
  assert.equal(byName['0.3.1'].image, true);
  assert.equal(byName['nightly'].image, false);
  assert.ok(byName['0.2.0']);
});

test('repozytorium bez tagów git, ale z obrazami: najnowszy to najwyższa wersja obrazu', async () => {
  ghcrTags = ['0.3.0', '0.3.1'];
  // atrapa GitHuba zwraca tagi tylko dla aplikacja-a, wiec uzywamy jej z pustym zbiorem git przez nazwe bez tagow
  const data = await (await call('GET', '/api/repos/przyklad/aplikacja-a/tags')).json();
  assert.ok(data.tags.some((t) => t.name === '0.3.1' && t.image));
});

test('brak uprawnień do ghcr.io: ostrzeżenie i tagi git', async () => {
  ghcrTags = null;
  const data = await (await call('GET', '/api/repos/przyklad/aplikacja-a/tags')).json();
  assert.match(data.warning, /read:packages/);
  assert.equal(data.latest, 'v0.10.0');
});
