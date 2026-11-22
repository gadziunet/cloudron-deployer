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

export async function verifyCloudron(fetchFn, address, token) {
  let res;
  try {
    res = await fetchFn(`https://${address}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UserError(`Nie mozna polaczyc sie z serwerem ${address} (adres, siec, certyfikat?)`, 502);
  }
  if (res.status === 401) throw new UserError('Cloudron odrzucil token API (zly lub wygasniety)');
  if (!res.ok) throw new UserError(`Cloudron zwrocil blad ${res.status}`, 502);
  const data = await res.json();
  return { username: data.username || data.email || 'nieznany' };
}
