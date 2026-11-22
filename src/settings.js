import express from 'express';
import { normalizeAddress, verifyGithubToken, verifyCloudron, UserError } from './integrations.js';

// Wszystkie ścieżki są montowane pod /api (czyli za ochroną sesji).
export function settingsRouter({ db, vault, fetchFn }) {
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

  const publicServer = (s) => ({ id: s.id, name: s.name, address: s.address });

  // --- GitHub
  router.get('/settings/github', (req, res) => {
    const row = db.prepare("SELECT value_enc FROM settings WHERE key = 'github_token'").get();
    const login = db.prepare("SELECT value_enc FROM settings WHERE key = 'github_login'").get();
    res.json({ configured: !!row, login: login ? vault.decrypt(login.value_enc) : null });
  });

  router.put('/settings/github', wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) throw new UserError('Podaj token GitHub');
    const { login } = await verifyGithubToken(fetchFn, token);
    const upsert = db.prepare('INSERT INTO settings(key, value_enc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc');
    upsert.run('github_token', vault.encrypt(token));
    upsert.run('github_login', vault.encrypt(login));
    res.json({ configured: true, login });
  }));

  router.delete('/settings/github', (req, res) => {
    db.prepare("DELETE FROM settings WHERE key IN ('github_token', 'github_login')").run();
    res.json({ configured: false });
  });

  // --- Serwery Cloudron
  router.get('/servers', (req, res) => {
    res.json(db.prepare('SELECT id, name, address FROM servers ORDER BY name').all());
  });

  router.post('/servers', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!name || name.length > 60) throw new UserError('Podaj nazwe serwera (do 60 znakow)');
    if (!token) throw new UserError('Podaj token API Cloudrona');
    const address = normalizeAddress(req.body?.address);
    const { username } = await verifyCloudron(fetchFn, address, token);
    try {
      const info = db.prepare('INSERT INTO servers(name, address, token_enc) VALUES (?, ?, ?)')
        .run(name, address, vault.encrypt(token));
      res.status(201).json({ id: Number(info.lastInsertRowid), name, address, username });
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

  router.delete('/servers/:id', (req, res) => {
    const info = db.prepare('DELETE FROM servers WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Nie ma takiego serwera' });
    res.json({ ok: true });
  });

  // --- Środowiska (testowa / produkcja -> serwer)
  router.get('/environments', (req, res) => {
    res.json(db.prepare('SELECT name, server_id FROM environments ORDER BY name DESC').all());
  });

  router.put('/environments/:name', wrap(async (req, res) => {
    const name = req.params.name;
    if (!['testowa', 'produkcja'].includes(name)) throw new UserError('Nieznane srodowisko', 404);
    const serverId = req.body?.server_id ?? null;
    if (serverId !== null) {
      const s = db.prepare('SELECT id FROM servers WHERE id = ?').get(Number(serverId));
      if (!s) throw new UserError('Nie ma takiego serwera');
    }
    db.prepare('UPDATE environments SET server_id = ? WHERE name = ?').run(serverId === null ? null : Number(serverId), name);
    res.json({ name, server_id: serverId === null ? null : Number(serverId) });
  }));

  return router;
}
