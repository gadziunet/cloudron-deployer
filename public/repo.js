import { api, el, bindLogout } from './common.js';

bindLogout();
const $ = (id) => document.getElementById(id);
const name = new URLSearchParams(location.search).get('name') || '';
const [owner, repo] = name.split('/');
const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

let targets = { testowa: null, produkcja: null };
let servers = [];
let environments = [];

function showEnvHint() {
  const env = $('env').value;
  const assigned = environments.find((e) => e.name === env)?.server_id;
  const server = servers.find((s) => s.id === assigned);
  $('server-hint').textContent = server
    ? `Serwer: ${server.name} (${server.address})`
    : 'Brak serwera dla tego środowiska. Wybierz go w ustawieniach.';
  $('domain').value = targets[env] || '';
  $('domain-hint').textContent = targets[env]
    ? 'Zapamiętana dla tego repozytorium i środowiska.'
    : 'Przy pierwszym razie wpisz domenę, zostanie zapamiętana.';
}

async function saveDomain() {
  const value = $('domain').value.trim();
  if (!value) return;
  const env = $('env').value;
  try {
    const r = await api(`${base}/targets/${env}`, { method: 'PUT', body: JSON.stringify({ app_domain: value }) });
    targets[env] = r.app_domain;
    $('domain').value = r.app_domain;
    $('domain-hint').textContent = 'Zapamiętano.';
    $('error').textContent = '';
  } catch (e) { $('error').textContent = e.message; }
}

async function init() {
  if (!owner || !repo) { $('error').textContent = 'Brak nazwy repozytorium.'; return; }
  $('title').textContent = name;
  api('/api/alerts').then((list) => {
    for (const a of list) {
      $('alerts').append(el('div', { class: 'alert', role: 'alert' }, `⚠ ${a.message}`,
        el('a', { href: '/settings.html', textContent: 'Zmień w ustawieniach' })));
    }
  });

  try {
    [servers, environments, targets] = await Promise.all([
      api('/api/servers'), api('/api/environments'), api(`${base}/targets`),
    ]);
    const { latest, tags } = await api(`${base}/tags`);
    if (!tags.length) {
      $('tag-hint').textContent = 'To repozytorium nie ma jeszcze żadnego tagu.';
    }
    for (const t of tags) {
      $('tag').append(el('option', {
        value: t.name,
        textContent: t.name + (t.name === latest ? ' (najnowszy)' : '') + (t.prerelease ? ' [wstępna]' : ''),
      }));
    }
    if (latest) $('tag').value = latest;
    showEnvHint();
  } catch (e) { $('error').textContent = e.message; }
}

$('env').addEventListener('change', showEnvHint);
$('domain').addEventListener('change', saveDomain);
init();
