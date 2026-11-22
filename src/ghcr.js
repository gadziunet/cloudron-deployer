// Rozmowa z rejestrem ghcr.io (token z uprawnieniem read:packages).
const TIMEOUT_MS = 15_000;

export async function getBearer(fetchFn, { login, token }, image) {
  const basic = Buffer.from(`${login || 'token'}:${token}`).toString('base64');
  const t = await fetchFn(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!t.ok) return null;
  const { token: bearer } = await t.json();
  return bearer || null;
}

// Tagi obrazu ghcr.io/<owner>/<repo>. status: 'ok' | 'unavailable'
export async function listImageTags(fetchFn, creds, owner, repo) {
  const image = `${owner}/${repo}`.toLowerCase();
  try {
    const bearer = await getBearer(fetchFn, creds, image);
    if (!bearer) return { tags: [], status: 'unavailable' };
    const res = await fetchFn(`https://ghcr.io/v2/${image}/tags/list?n=1000`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { tags: [], status: 'ok' }; // brak obrazu = brak tagow
    if (!res.ok) return { tags: [], status: 'unavailable' };
    const data = await res.json();
    return { tags: Array.isArray(data.tags) ? data.tags : [], status: 'ok' };
  } catch {
    return { tags: [], status: 'unavailable' };
  }
}

// Tagi do wdrozenia: obrazy z ghcr.io (to je Cloudron faktycznie pobierze) + tagi git repozytorium
export async function listDeployableTags({ fetchFn, github, creds, owner, repo }) {
  const image = await listImageTags(fetchFn, creds, owner, repo);
  let gitTags = [];
  try { gitTags = await github.listTagNames(owner, repo); } catch (e) { if (!image.tags.length) throw e; }
  const names = [...new Set([...image.tags, ...gitTags])];
  return {
    names,
    imageTags: image.tags,
    warning: image.status === 'ok' ? null
      : 'Nie udalo sie odczytac obrazow z ghcr.io (token potrzebuje uprawnienia read:packages). Pokazuje tylko tagi git.',
  };
}
