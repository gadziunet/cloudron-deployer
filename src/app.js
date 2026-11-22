import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeVault } from './crypto.js';
import { ensureAdmin, makeAuth } from './auth.js';
import { settingsRouter } from './settings.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(config, log = console, { fetchFn = fetch } = {}) {
  const db = openDb(config.dataDir);
  const vault = makeVault(config.appSecret);
  ensureAdmin(db, config.adminPassword, log);
  const auth = makeAuth(db, config);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'");
    next();
  });

  // --- API publiczne (tylko logowanie)
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.post('/api/login', auth.requireCsrfHeader, auth.login);

  // --- Od tego miejsca wszystko pod /api wymaga sesji
  app.use('/api', auth.requireSession, auth.requireCsrfHeader);
  app.get('/api/me', (req, res) => res.json({ username: req.user.username }));
  app.post('/api/logout', auth.logout);
  app.post('/api/password', auth.changePassword);
  app.use('/api', settingsRouter({ db, vault, fetchFn }));

  // Strony statyczne: login.html jest publiczny, reszta ładuje dane przez /api
  app.use(express.static(publicDir, { index: false }));
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, auth.sessionFrom(req) ? 'index.html' : 'login.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Nie znaleziono' }));
  return { app, db, vault, auth };
}
