import { UserError } from './integrations.js';

const TTL_MS = 30_000;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function checkRepoName(owner, repo) {
  if (!NAME.test(owner) || !NAME.test(repo) || owner === '.' || repo === '.' || owner === '..' || repo === '..') {
    throw new UserError('Niepoprawna nazwa repozytorium');
  }
}

// Klient GitHub z krótkim cache. getToken() zwraca odszyfrowany token albo null.
export function makeGithub({ fetchFn, getToken }) {
  const cache = new Map();

  async function get(path) {
    const token = getToken();
    if (!token) throw new UserError('Najpierw dodaj token GitHub w ustawieniach', 409);
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

    let res;
    try {
      res = await fetchFn(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cloudron-deployer',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new UserError('Nie mozna polaczyc sie z GitHub', 502);
    }
    if (res.status === 401) throw new UserError('GitHub odrzucil token (wygasl?). Zmien go w ustawieniach.', 409);
    if (res.status === 404) throw new UserError('Nie znaleziono w GitHub (repozytorium lub brak uprawnien tokenu)', 404);
    if (res.status === 403 || res.status === 429) throw new UserError('GitHub ogranicza zapytania lub brak uprawnien. Sprobuj za chwile.', 502);
    if (!res.ok) throw new UserError(`GitHub zwrocil blad ${res.status}`, 502);
    const data = await res.json();
    cache.set(path, { at: Date.now(), data });
    return data;
  }

  return {
    clearCache: () => cache.clear(),

    async listRepos() {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const chunk = await get(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,organization_member`);
        all.push(...chunk);
        if (chunk.length < 100) break;
      }
      return all.filter((r) => !r.archived).map((r) => ({
        full_name: r.full_name,
        description: r.description || '',
        private: !!r.private,
        pushed_at: r.pushed_at,
      }));
    },

    async listTagNames(owner, repo) {
      checkRepoName(owner, repo);
      const data = await get(`/repos/${owner}/${repo}/tags?per_page=100`);
      return data.map((t) => t.name);
    },
  };
}
