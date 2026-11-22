import express from 'express';
import { buildAlerts } from './alerts.js';
import { normalizeAddress, verifyGithubToken, verifyCloudron, parseExpires, UserError } from './integrations.js';
import { parseGithubUsername } from './registry.js';

// Wszystkie ścieżki są montowane pod /api (czyli za ochroną sesji).
export function settingsRouter({ db, vault, fetchFn, registry, onGithubChange = () => {} }) {
  const router = express.Router();

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Blad serwera' });
    }
  };

  const KINDS = ['testowa', 'produkcja'];
  const parseKind = (v) => {
    if (v === undefined || v === null || v === '') return 'testowa';
    if (!KINDS.includes(v)) throw new UserError('Rodzaj serwera: testowa lub produkcja');
    return v;
  };

  const upsertSetting = (key, value) => db.prepare(
    'INSERT INTO settings(key, value_enc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc'
  ).run(key, vault.encrypt(value));
  const readSetting = (key) => {
    const row = db.prepare('SELECT value_enc FROM settings WHERE key = ?').get(key);
    return row ? vault.decrypt(row.value_enc) : null;
  };

  // --- GitHub
  router.get('/settings/github', (req, res) => {
    const configured = !!db.prepare("SELECT 1 FROM settings WHERE key = 'github_token'").get();
    res.json({
      configured,
      login: readSetting('github_login'),
      username: readSetting('ghcr_username') || null,
      expires: readSetting('github_expires') || null,
    });
  });

  router.put('/settings/github', wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) throw new UserError('Podaj token GitHub');
    const expires = parseExpires(req.body?.expires);
    const username = parseGithubUsername(req.body?.username);
    const { login } = await verifyGithubToken(fetchFn, token);
    upsertSetting('github_token', token);
    upsertSetting('github_login', login);
    if (expires) upsertSetting('github_expires', expires);
    else db.prepare("DELETE FROM settings WHERE key = 'github_expires'").run();
    if (username) upsertSetting('ghcr_username', username);
    else db.prepare("DELETE FROM settings WHERE key = 'ghcr_username'").run();
    onGithubChange();
    // nowy token trafia automatycznie do ghcr.io na wszystkich serwerach Cloudron
    const sync = await registry.syncAll();
    res.json({ configured: true, login, username, expires, registry: sync });
  }));

  // zmiana samej daty ważności (bez ponownego wpisywania tokenu)
  router.patch('/settings/github', wrap(async (req, res) => {
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'github_token'").get()) throw new UserError('Brak tokenu GitHub', 404);
    const body = req.body || {};
    const out = {};
    if ('expires' in body) {
      const expires = parseExpires(body.expires);
      if (expires) upsertSetting('github_expires', expires);
      else db.prepare("DELETE FROM settings WHERE key = 'github_expires'").run();
      out.expires = expires;
    }
    if ('username' in body) {
      const username = parseGithubUsername(body.username);
      if (username) upsertSetting('ghcr_username', username);
      else db.prepare("DELETE FROM settings WHERE key = 'ghcr_username'").run();
      out.username = username;
      out.registry = await registry.syncAll();
    }
    res.json(out);
  }));

  // Reczna synchronizacja ghcr.io (wszystkie serwery albo jeden: { server_id })
  router.post('/registry/sync', wrap(async (req, res) => {
    if (!registry.hasCredentials()) throw new UserError('Najpierw dodaj token GitHub w ustawieniach', 409);
    if (req.body?.server_id !== undefined && req.body?.server_id !== null) {
      const s = db.prepare('SELECT id, name, address, token_enc FROM servers WHERE id = ?').get(Number(req.body.server_id));
      if (!s) throw new UserError('Nie ma takiego serwera', 404);
      return res.json({ registry: [await registry.syncServer(s)] });
    }
    res.json({ registry: await registry.syncAll() });
  }));

  router.delete('/settings/github', (req, res) => {
    db.prepare("DELETE FROM settings WHERE key IN ('github_token', 'github_login', 'github_expires', 'ghcr_username')").run();
    onGithubChange();
    res.json({ configured: false });
  });

  // --- Ostrzeżenia o wygasających tokenach (strona główna)
  router.get('/alerts', (req, res) => {
    const servers = db.prepare('SELECT name, token_expires AS expires FROM servers').all();
    res.json(buildAlerts({ githubExpires: readSetting('github_expires'), servers }));
  });

  // --- Serwery Cloudron
  router.get('/servers', (req, res) => {
    res.json(db.prepare('SELECT id, name, address, kind, token_expires AS expires FROM servers ORDER BY name').all());
  });

  router.post('/servers', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!name || name.length > 60) throw new UserError('Podaj nazwe serwera (do 60 znakow)');
    if (!token) throw new UserError('Podaj token API Cloudrona');
    const address = normalizeAddress(req.body?.address);
    const expires = parseExpires(req.body?.expires);
    const kind = parseKind(req.body?.kind);
    const { username } = await verifyCloudron(fetchFn, address, token);
    try {
      const info = db.prepare('INSERT INTO servers(name, address, token_enc, token_expires, kind) VALUES (?, ?, ?, ?, ?)')
        .run(name, address, vault.encrypt(token), expires, kind);
      const id = Number(info.lastInsertRowid);
      // nowy serwer od razu dostaje dane logowania do ghcr.io (jesli jest token GitHub)
      let sync = null;
      if (registry.hasCredentials()) {
        sync = await registry.syncServer({ id, name, address, token_enc: vault.encrypt(token) });
      }
      res.status(201).json({ id, name, address, kind, expires, username, registry: sync });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new UserError('Serwer o takiej nazwie juz istnieje');
      throw e;
    }
  }));

  router.post('/servers/:id/check', wrap(async (req, res) => {
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
    if (!s) throw new UserError('Nie ma takiego serwera', 404);
    const { username } = await verifyCloudron(fetchFn, s.address, vault.decrypt(s.token_enc));
    res.json({ ok: true, username });
  }));

  router.patch('/servers/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(id)) throw new UserError('Nie ma takiego serwera', 404);
    const body = req.body || {};
    if (!('expires' in body) && !('kind' in body)) throw new UserError('Brak zmian');
    const out = {};
    if ('expires' in body) {
      out.expires = parseExpires(body.expires);
      db.prepare('UPDATE servers SET token_expires = ? WHERE id = ?').run(out.expires, id);
    }
    if ('kind' in body) {
      if (!KINDS.includes(body.kind)) throw new UserError('Rodzaj serwera: testowa lub produkcja');
      out.kind = body.kind;
      db.prepare('UPDATE servers SET kind = ? WHERE id = ?').run(out.kind, id);
    }
    res.json(out);
  }));

  router.delete('/servers/:id', (req, res) => {
    const info = db.prepare('DELETE FROM servers WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Nie ma takiego serwera' });
    res.json({ ok: true });
  });

  return router;
}
