import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeVault } from './crypto.js';
import { ensureAdmin, makeAuth } from './auth.js';
import { settingsRouter } from './settings.js';
import { makeGithub } from './github.js';
import { reposRouter } from './repos.js';
import { makeDeployer, defaultRunCli } from './deploy.js';
import { deploymentsRouter } from './deployments.js';
import { makeRegistrySync } from './registry.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(config, log = console, { fetchFn = fetch, runCli = defaultRunCli } = {}) {
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
  const readSecret = (key) => {
    const row = db.prepare('SELECT value_enc FROM settings WHERE key = ?').get(key);
    return row ? vault.decrypt(row.value_enc) : null;
  };
  const github = makeGithub({ fetchFn, getToken: () => readSecret('github_token') });
  const getGithub = () => ({ token: readSecret('github_token'), login: readSecret('github_login') });
  const deployer = makeDeployer({ db, vault, github, fetchFn, runCli, getGithub });
  const registry = makeRegistrySync({ db, vault, fetchFn });
  app.use('/api', settingsRouter({ db, vault, fetchFn, registry, onGithubChange: () => github.clearCache() }));
  app.use('/api', reposRouter({ db, github, fetchFn, getGithub }));
  app.use('/api', deploymentsRouter({ db, deployer }));

  // Strony statyczne: login.html jest publiczny, reszta ładuje dane przez /api
  app.use(express.static(publicDir, { index: false }));
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, auth.sessionFrom(req) ? 'index.html' : 'login.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Nie znaleziono' }));
  return { app, db, vault, auth, deployer };
}
