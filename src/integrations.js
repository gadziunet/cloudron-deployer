// Połączenia z GitHub i Cloudron. Funkcja fetch jest wstrzykiwana, żeby dało się testować bez sieci.

const TIMEOUT_MS = 10_000;

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Przyjmuje "my.example.com", "https://my.example.com/" lub "my.example.com:3000"
export function normalizeAddress(input) {
  let a = String(input || '').trim();
  a = a.replace(/^https?:\/\//i, '');
  a = a.split('/')[0];
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(a)) {
    throw new UserError('Niepoprawny adres serwera (np. my.example.com)');
  }
  return a.toLowerCase();
}

export async function verifyGithubToken(fetchFn, token) {
  let res;
  try {
    res = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cloudron-deployer',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UserError('Nie mozna polaczyc sie z GitHub', 502);
  }
  if (res.status === 401) throw new UserError('GitHub odrzucil token (zly lub wygasniety)');
  if (!res.ok) throw new UserError(`GitHub zwrocil blad ${res.status}`, 502);
  const data = await res.json();
  return { login: data.login };
}

// Zapytanie do API Cloudrona. Najpierw token w nagłówku, a gdy serwer odpowie 401,
// ponownie tak jak robi to Cloudron CLI (access_token w adresie).
export async function cloudronRequest(fetchFn, address, token, apiPath, { method = 'GET', body } = {}) {
  const url = `https://${address}${apiPath}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const attempt = (u, headers) => fetchFn(u, {
    method,
    headers: payload === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  try {
    let res = await attempt(url, { Authorization: `Bearer ${token}` });
    if (res.status === 401) {
      res = await attempt(`${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, {});
    }
    return res;
  } catch {
    throw new UserError(`Nie mozna polaczyc sie z serwerem ${address} (adres, siec, certyfikat?)`, 502);
  }
}

export async function serverMessage(res) {
  try {
    const body = await res.json();
    const m = typeof body?.message === 'string' ? body.message : '';
    return m.slice(0, 200);
  } catch {
    return '';
  }
}

export async function verifyCloudron(fetchFn, address, token) {
  // /apps to dokladnie to, czego potrzebujemy przy wdrazaniu
  const res = await cloudronRequest(fetchFn, address, token, '/api/v1/apps');
  if (res.status === 401 || res.status === 403) {
    const msg = await serverMessage(res);
    throw new UserError(
      `Cloudron odrzucil token API (${res.status}${msg ? `: ${msg}` : ''}). Sprawdz, czy token jest z tego serwera i ma odczyt i zapis.`
    );
  }
  if (!res.ok) throw new UserError(`Cloudron zwrocil blad ${res.status}`, 502);

  // nazwa wlasciciela tokenu jest tylko informacja dodatkowa
  let username = 'token dziala';
  try {
    const p = await cloudronRequest(fetchFn, address, token, '/api/v1/profile');
    if (p.ok) {
      const data = await p.json();
      username = data.username || data.email || username;
    }
  } catch { /* pomijamy */ }
  return { username };
}

// Data ważności tokenu: pusta = brak daty, inaczej poprawne YYYY-MM-DD
export function parseExpires(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const v = String(input).trim();
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new UserError('Niepoprawna data (format RRRR-MM-DD)');
  }
  return v;
}
