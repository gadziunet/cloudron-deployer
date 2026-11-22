import crypto from 'node:crypto';
import { hashPassword, verifyPassword, randomToken, sha256 } from './crypto.js';

const COOKIE = 'wdr_sid';

export function ensureAdmin(db, adminPassword, log = console) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (existing) return;
  let password = adminPassword;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    log.warn(`Brak ADMIN_PASSWORD. Wygenerowane haslo poczatkowe dla "admin": ${password}`);
  }
  db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run('admin', hashPassword(password));
  log.info('Utworzono uzytkownika "admin".');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Limit prób logowania: 5 błędnych na 15 minut dla jednego adresu
function makeLimiter(max = 5, windowMs = 15 * 60 * 1000) {
  const hits = new Map();
  return {
    blocked(ip) {
      const e = hits.get(ip);
      if (!e) return false;
      if (Date.now() - e.first > windowMs) { hits.delete(ip); return false; }
      return e.count >= max;
    },
    fail(ip) {
      const e = hits.get(ip);
      if (!e || Date.now() - e.first > windowMs) hits.set(ip, { count: 1, first: Date.now() });
      else e.count++;
    },
    reset(ip) { hits.delete(ip); },
  };
}

export function makeAuth(db, config) {
  const limiter = makeLimiter();
  const ttlMs = config.sessionMinutes * 60 * 1000;

  function setCookie(res, value, maxAgeSec) {
    const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
    if (config.secureCookie) flags.push('Secure');
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; ${flags.join('; ')}`);
  }

  function sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(
      'SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    ).get(sha256(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    // przedłużanie sesji przy aktywności
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + ttlMs, row.token_hash);
    return row;
  }

  // Middleware: wszystko pod /api (poza logowaniem) wymaga sesji
  function requireSession(req, res, next) {
    const s = sessionFrom(req);
    if (!s) return res.status(401).json({ error: 'Wymagane logowanie' });
    req.user = { id: s.user_id, username: s.username };
    next();
  }

  // Ochrona CSRF: zapytania zmieniające dane muszą mieć nagłówek własny
  // (przeglądarka nie dołączy go sama w zapytaniu z innej strony)
  function requireCsrfHeader(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'wdrazacz') {
      return res.status(403).json({ error: 'Niepoprawne zapytanie' });
    }
    next();
  }

  function login(req, res) {
    const ip = req.ip;
    if (limiter.blocked(ip)) {
      return res.status(429).json({ error: 'Za duzo prob. Sprobuj za kilkanascie minut.' });
    }
    const { username, password } = req.body || {};
    const user = typeof username === 'string' && typeof password === 'string'
      ? db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username)
      : null;
    // zawsze wykonujemy weryfikację, żeby czas odpowiedzi nie zdradzał loginu
    const ok = verifyPassword(String(password ?? ''), user?.password_hash ?? 'scrypt$00$00') && !!user;
    if (!ok) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Bledny login lub haslo' });
    }
    limiter.reset(ip);
    const token = randomToken();
    db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, Date.now() + ttlMs);
    setCookie(res, token, Math.floor(ttlMs / 1000));
    res.json({ ok: true });
  }

  function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(res, '', 0);
    res.json({ ok: true });
  }

  function changePassword(req, res) {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string' || next.length < 10) {
      return res.status(400).json({ error: 'Nowe haslo musi miec co najmniej 10 znakow' });
    }
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, user.password_hash)) {
      return res.status(401).json({ error: 'Obecne haslo jest bledne' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    // unieważnij pozostałe sesje
    const keep = sha256(parseCookies(req.headers.cookie)[COOKIE] || '');
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, keep);
    res.json({ ok: true });
  }

  return { requireSession, requireCsrfHeader, login, logout, changePassword, sessionFrom };
}
