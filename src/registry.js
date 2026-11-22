import { cloudronRequest, serverMessage, UserError } from './integrations.js';

const GHCR = 'ghcr.io';
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseGithubUsername(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const v = String(input).trim();
  if (!GITHUB_USER.test(v)) throw new UserError('Niepoprawna nazwa uzytkownika GitHub');
  return v;
}

const serverOf = (r) => String(r?.serverAddress ?? r?.server ?? r?.hostname ?? r?.registry ?? '')
  .toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

async function describe(res) {
  const msg = await serverMessage(res);
  return `${res.status}${msg ? `: ${msg}` : ''}`;
}

// Dodaje albo aktualizuje wpis ghcr.io na serwerze Cloudron (API wielu rejestrow: /docker/registries).
// Nie nadpisuje innych rejestrow. Na starszym Cloudronie bez tego API zwraca czytelny blad.
export async function syncGhcr(fetchFn, { address, token }, { username, password }) {
  const listRes = await cloudronRequest(fetchFn, address, token, '/api/v1/docker/registries');
  if (listRes.status === 404) {
    throw new UserError('Ten Cloudron nie obsluguje wielu rejestrow Docker (brak /docker/registries). Dodaj ghcr.io recznie.');
  }
  if (!listRes.ok) throw new UserError(`Lista rejestrow: ${await describe(listRes)}`);

  const data = await listRes.json().catch(() => []);
  const list = Array.isArray(data) ? data : (data.registries || data.dockerRegistries || []);
  const existing = list.find((r) => serverOf(r) === GHCR);
  if (existing && (existing.id === undefined || existing.id === null)) {
    throw new UserError('Cloudron zwrocil wpis ghcr.io bez identyfikatora, nie mozna go zaktualizowac');
  }
  const path = existing
    ? `/api/v1/docker/registries/${encodeURIComponent(existing.id)}`
    : '/api/v1/docker/registries';

  // nazwa pola z adresem rejestru nie jest opisana w dokumentacji: najpierw serverAddress, w razie 400 server
  let lastError = '';
  for (const key of ['serverAddress', 'server']) {
    const res = await cloudronRequest(fetchFn, address, token, path, {
      method: 'POST', body: { [key]: GHCR, username, password },
    });
    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return { action: existing ? 'updated' : 'added' };
    }
    lastError = await describe(res);
    if (res.status !== 400) break;
  }
  throw new UserError(`Cloudron odrzucil dane rejestru (${lastError})`);
}

export function makeRegistrySync({ db, vault, fetchFn }) {
  const read = (key) => {
    const row = db.prepare('SELECT value_enc FROM settings WHERE key = ?').get(key);
    return row ? vault.decrypt(row.value_enc) : null;
  };

  function credentials() {
    const password = read('github_token');
    const username = read('ghcr_username') || read('github_login');
    if (!password || !username) return null;
    return { username, password };
  }

  async function syncServer(server) {
    const creds = credentials();
    if (!creds) return { server: server.name, ok: false, message: 'Brak tokenu GitHub w ustawieniach' };
    try {
      const { action } = await syncGhcr(fetchFn, { address: server.address, token: vault.decrypt(server.token_enc) }, creds);
      return { server: server.name, ok: true, action };
    } catch (e) {
      if (!(e instanceof UserError)) console.error(e);
      return { server: server.name, ok: false, message: e instanceof UserError ? e.message : 'Nieoczekiwany blad' };
    }
  }

  async function syncAll() {
    const servers = db.prepare('SELECT id, name, address, token_enc FROM servers ORDER BY name').all();
    const results = [];
    for (const s of servers) results.push(await syncServer(s));
    return results;
  }

  return { syncServer, syncAll, hasCredentials: () => credentials() !== null };
}
