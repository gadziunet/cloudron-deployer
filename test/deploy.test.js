import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { referencedFiles } from '../src/deploy.js';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };
const quiet = { info() {}, warn() {} };
let server, base, dir, cookie, app, serverId;
let slow = null;
let imageTags = [], missingRefs = [];
let ghcrStatus, cliExit, cliOutput, manifest, cliCalls, appsOnServer, files;

const res = (status, body, text) => ({
  status, ok: status < 300, json: async () => body, text: async () => text ?? JSON.stringify(body),
});

const fakeFetch = async (url, opts = {}) => {
  const u = String(url);
  const auth = opts.headers?.Authorization;
  if (u === 'https://api.github.com/user') return res(200, { login: 'przyklad' });
  if (u.startsWith('https://api.github.com/repos/przyklad/aplikacja-a/tags')) return res(200, [{ name: 'v0.3.1' }, { name: 'v0.3.0' }]);
  if (u.startsWith('https://api.github.com/repos/przyklad/aplikacja-a/contents/')) {
    const file = decodeURIComponent(u.split('/contents/')[1].split('?')[0]);
    const ref = new URL(u).searchParams.get('ref') ?? '';
    if (missingRefs.includes(ref)) return res(404, {});
    if (file === 'CloudronManifest.json') return res(200, null, manifest);
    if (files[file] !== undefined) return res(200, null, files[file]);
    return res(404, {});
  }
  if (u.startsWith('https://ghcr.io/v2/przyklad/aplikacja-a/tags/list')) return res(200, { tags: imageTags });
  if (u.startsWith('https://ghcr.io/token')) return res(200, { token: 'ghcr-bearer' });
  if (u.startsWith('https://ghcr.io/v2/przyklad/aplikacja-a/manifests/')) return res(ghcrStatus, {});
  if (u === 'https://test.example.com/api/v1/profile') return auth === 'Bearer cl-ok' ? res(200, { username: 'admin' }) : res(401, {});
  if (u === 'https://test.example.com/api/v1/apps') return auth === 'Bearer cl-ok' ? res(200, { apps: appsOnServer }) : res(401, {});
  return res(404, {});
};

const fakeRunCli = async ({ args, env, cwd, onData }) => {
  cliCalls.push({ args, env: { ...env }, cwd, files: fs.readdirSync(cwd).sort(), manifest: fs.readFileSync(path.join(cwd, 'CloudronManifest.json'), 'utf8') });
  if (slow) await slow;
  onData(cliOutput);
  return cliExit;
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-'));
  app = createApp({
    port: 0, dataDir: dir, appSecret: 'test-secret-1234567890',
    adminPassword: 'haslo-testowe-123', sessionMinutes: 5, secureCookie: false,
  }, quiet, { fetchFn: fakeFetch, runCli: fakeRunCli });
  await new Promise((r) => { server = app.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'haslo-testowe-123' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (method, p, body) => fetch(base + p, {
  method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body),
});
const reset = () => {
  ghcrStatus = 200; cliExit = 0; cliOutput = 'Waiting for app to be updated ...\nApp is updated.\n';
  manifest = JSON.stringify({ id: 'com.example.aplikacja', version: '0.3.1' });
  cliCalls = []; files = {}; imageTags = []; missingRefs = [];
  appsOnServer = [{ id: '11111111-2222-3333-4444-555555555555', fqdn: 'app-dev.example.com' }];
};
const deploy = async (body) => {
  const r = await call('POST', '/api/deployments', body);
  return r;
};
const waitDone = async (id) => {
  for (let i = 0; i < 100; i++) {
    const row = await (await call('GET', `/api/deployments/${id}`)).json();
    if (row.status !== 'running') return row;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('wdrozenie nie skonczylo sie');
};
const body = { repo: 'przyklad/aplikacja-a', tag: 'v0.3.1', environment: 'testowa' };

test('przygotowanie: GitHub, serwer, środowisko, domena', async () => {
  reset();
  assert.equal((await call('PUT', '/api/settings/github', { token: 'gh-ok' })).status, 200);
  const r = await call('POST', '/api/servers', { name: 'Test', address: 'test.example.com', token: 'cl-ok' });
  serverId = (await r.json()).id;
});

test('bez przypisanego serwera i bez domeny wdrożenie jest odrzucone z czytelnym błędem', async () => {
  let r = await deploy(body);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /nie wybrano serwera/);
  await call('PUT', '/api/environments/testowa', { server_id: serverId });
  r = await deploy(body);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /domene/);
  await call('PUT', '/api/repos/przyklad/aplikacja-a/targets/testowa', { app_domain: 'app-dev.example.com' });
});

test('niepoprawne dane wejściowe: tag, środowisko, repozytorium, nieistniejący tag', async () => {
  reset();
  assert.equal((await deploy({ ...body, tag: 'v1; rm -rf /' })).status, 400);
  assert.equal((await deploy({ ...body, tag: '--image=x' })).status, 400);
  assert.equal((await deploy({ ...body, environment: 'inna' })).status, 400);
  assert.equal((await deploy({ ...body, repo: 'zly' })).status, 400);
  assert.equal((await deploy({ ...body, tag: 'v9.9.9' })).status, 404);
  assert.equal(cliCalls.length, 0);
});

test('udane wdrożenie: poprawne argumenty CLI, token tylko w env, manifest w katalogu roboczym', async () => {
  reset();
  const r = await deploy(body);
  assert.equal(r.status, 202);
  const row = await waitDone((await r.json()).id);
  assert.equal(row.status, 'success');
  assert.equal(cliCalls.length, 1);
  const c = cliCalls[0];
  assert.deepEqual(c.args, ['--server', 'test.example.com', '--wait-timeout', '15m', 'update',
    '--app', '11111111-2222-3333-4444-555555555555', '--image', 'ghcr.io/przyklad/aplikacja-a:v0.3.1']);
  assert.ok(!c.args.join(' ').includes('cl-ok'), 'token nie moze byc w argumentach');
  assert.equal(c.env.CLOUDRON_CLI_AUTH_TOKEN, 'cl-ok');
  assert.deepEqual(c.files, ['CloudronManifest.json']);
  assert.match(row.log, /App is updated/);
  assert.match(row.log, /Gotowe/);
  assert.ok(!fs.existsSync(c.cwd), 'katalog tymczasowy ma byc usuniety');
  assert.equal(row.environment, 'testowa');
  assert.equal(row.server_name, 'Test');
});

test('manifest z ikoną i opisem: pliki są pobierane obok manifestu', async () => {
  reset();
  manifest = JSON.stringify({ id: 'x', icon: 'logo.png', description: 'file://DESCRIPTION.md', changelog: 'file://CHANGELOG', postInstallMessage: 'file://docs/POST.md' });
  files = { 'logo.png': 'PNG', 'DESCRIPTION.md': 'opis', CHANGELOG: 'zmiany', 'docs/POST.md': 'po instalacji' };
  const r = await deploy(body);
  const row = await waitDone((await r.json()).id);
  assert.equal(row.status, 'success');
  assert.deepEqual(cliCalls[0].files, ['CHANGELOG', 'CloudronManifest.json', 'DESCRIPTION.md', 'docs', 'logo.png']);
});

test('brak pliku wskazanego w manifeście kończy wdrożenie błędem, CLI nie rusza', async () => {
  reset();
  manifest = JSON.stringify({ id: 'x', icon: 'brak.png' });
  const row = await waitDone((await (await deploy(body)).json()).id);
  assert.equal(row.status, 'failed');
  assert.match(row.log, /BLAD/);
  assert.equal(cliCalls.length, 0);
});

test('referencedFiles odrzuca ścieżki wychodzące poza repozytorium i adresy URL', () => {
  assert.throws(() => referencedFiles({ icon: '../../etc/passwd' }));
  assert.throws(() => referencedFiles({ description: 'file:///etc/passwd' }));
  assert.deepEqual(referencedFiles({ icon: 'https://example.com/i.png', description: 'zwykly tekst' }), []);
  assert.deepEqual(referencedFiles({ icon: 'file://logo.png' }), ['logo.png']);
});

test('CLI kończy się błędem: status failed, a log nie zawiera tokenów', async () => {
  reset();
  cliExit = 1; cliOutput = 'Failed to update app: token cl-ok oraz gh-ok\n';
  const row = await waitDone((await (await deploy(body)).json()).id);
  assert.equal(row.status, 'failed');
  assert.match(row.log, /kodem 1/);
  assert.ok(!row.log.includes('cl-ok') && !row.log.includes('gh-ok'));
});

test('obraz nie istnieje w ghcr.io: wdrożenie zatrzymane przed CLI', async () => {
  reset(); ghcrStatus = 404;
  const row = await waitDone((await (await deploy(body)).json()).id);
  assert.equal(row.status, 'failed');
  assert.match(row.log, /nie istnieje w ghcr\.io/);
  assert.equal(cliCalls.length, 0);
});

test('brak uprawnień do sprawdzenia obrazu (403) nie blokuje wdrożenia', async () => {
  reset(); ghcrStatus = 403;
  const row = await waitDone((await (await deploy(body)).json()).id);
  assert.equal(row.status, 'success');
  assert.match(row.log, /Nie udalo sie sprawdzic obrazu/);
});

test('aplikacji o takiej domenie nie ma na serwerze: wdrożenie zatrzymane', async () => {
  reset(); appsOnServer = [{ id: 'inne', fqdn: 'inna.example.com' }];
  const row = await waitDone((await (await deploy(body)).json()).id);
  assert.equal(row.status, 'failed');
  assert.match(row.log, /nie ma aplikacji o domenie app-dev\.example\.com/);
  assert.equal(cliCalls.length, 0);
});

test('blokada: drugie wdrożenie tej samej aplikacji w trakcie pierwszego dostaje 409', async () => {
  reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  // podmieniamy CLI na wolne (czeka na zwolnienie)
  slow = gate;
  const first = await deploy(body);
  assert.equal(first.status, 202);
  const second = await deploy(body);
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /wlasnie wdrazana/);
  release();
  const row = await waitDone((await first.json()).id);
  assert.equal(row.status, 'success');
  slow = null;
  // po zakończeniu można wdrożyć ponownie
  const again = await deploy(body);
  assert.equal(again.status, 202);
  await waitDone((await again.json()).id);
});

test('historia: lista bez logów, szczegóły z logiem, filtr po repozytorium', async () => {
  const list = await (await call('GET', '/api/deployments')).json();
  assert.ok(list.length >= 5);
  assert.ok(list.every((d) => !('log' in d)));
  assert.ok(list[0].id > list[1].id);
  const filtered = await (await call('GET', '/api/deployments?repo=inne/repo')).json();
  assert.deepEqual(filtered, []);
  assert.equal((await call('GET', '/api/deployments/99999')).status, 404);
});

test('wdrożenia bez sesji zwracają 401', async () => {
  for (const [m, p] of [['POST', '/api/deployments'], ['GET', '/api/deployments'], ['GET', '/api/deployments/1']]) {
    assert.equal((await fetch(base + p, { method: m, headers: H })).status, 401, p);
  }
});

test('tag istnieje tylko jako obraz (bez tagu git): manifest z domyślnej gałęzi, z ostrzeżeniem w logu', async () => {
  reset(); imageTags = ['0.4.0']; missingRefs = ['0.4.0', 'v0.4.0'];
  const r = await deploy({ ...body, tag: '0.4.0' });
  assert.equal(r.status, 202);
  const row = await waitDone((await r.json()).id);
  assert.equal(row.status, 'success');
  assert.match(row.log, /UWAGA: brak tagu git dla wersji 0\.4\.0/);
  assert.equal(cliCalls[0].args.at(-1), 'ghcr.io/przyklad/aplikacja-a:0.4.0');
});

test('tag obrazu bez "v", a tag git z "v": manifest bierze z tagu git', async () => {
  reset(); imageTags = ['0.3.1']; missingRefs = ['0.3.1'];
  const row = await waitDone((await (await deploy({ ...body, tag: '0.3.1' })).json()).id);
  assert.equal(row.status, 'success');
  assert.match(row.log, /ref v0\.3\.1/);
  assert.ok(!/UWAGA/.test(row.log));
});

test('tag, którego nie ma ani w ghcr.io, ani w git: 404', async () => {
  reset(); imageTags = ['0.4.0'];
  assert.equal((await deploy({ ...body, tag: '9.9.9' })).status, 404);
});

test('po restarcie wdrożenia w toku dostają status interrupted', async () => {
  app.db.prepare("INSERT INTO deployments(repo, tag, environment, status) VALUES ('a/b', 'v1', 'testowa', 'running')").run();
  const { createApp: create } = await import('../src/app.js');
  server.close();
  const again = create({
    port: 0, dataDir: dir, appSecret: 'test-secret-1234567890', adminPassword: 'x', sessionMinutes: 5, secureCookie: false,
  }, quiet, { fetchFn: fakeFetch, runCli: fakeRunCli });
  const rows = again.db.prepare("SELECT status FROM deployments WHERE repo = 'a/b'").all();
  assert.equal(rows[0].status, 'interrupted');
  server = again.app.listen(0);
});

