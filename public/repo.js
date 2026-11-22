import { api, el, initHeader, STATUS, followDeployment } from './common.js';

initHeader();
const $ = (id) => document.getElementById(id);
const name = new URLSearchParams(location.search).get('name') || '';
const [owner, repo] = name.split('/');
const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const KIND = { testowa: 'testowy', produkcja: 'produkcyjny' };

let targets = {};   // { "<id serwera>": "domena" }
let servers = [];

const currentServer = () => servers.find((s) => String(s.id) === $('server').value);

function showServer() {
  const s = currentServer();
  if (!s) {
    $('server-hint').textContent = 'Brak serwerów. Dodaj serwer w ustawieniach.';
    $('domain').value = '';
    return;
  }
  $('server-hint').textContent = `${s.address} · serwer ${KIND[s.kind] || s.kind}`;
  const domain = targets[s.id] || '';
  $('domain').value = domain;
  $('domain-hint').textContent = domain
    ? 'Zapamiętana dla tego repozytorium i serwera.'
    : 'Przy pierwszym razie wpisz domenę, zostanie zapamiętana.';
}

async function saveDomain() {
  const s = currentServer();
  const value = $('domain').value.trim();
  if (!s || !value) return;
  try {
    const r = await api(`${base}/targets/${s.id}`, { method: 'PUT', body: JSON.stringify({ app_domain: value }) });
    targets[s.id] = r.app_domain;
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
    [servers, targets] = await Promise.all([api('/api/servers'), api(`${base}/targets`)]);
    for (const s of servers) {
      $('server').append(el('option', { value: String(s.id), textContent: `${s.name} (${KIND[s.kind] || s.kind})` }));
    }
    // ostatnio wybrany serwer dla tego repozytorium
    const saved = localStorage.getItem(`server:${name}`);
    if (saved && servers.some((s) => String(s.id) === saved)) $('server').value = saved;
    showServer();

    const { latest, tags, warning } = await api(`${base}/tags`);
    if (!tags.length) {
      $('tag-hint').textContent = 'Nie znaleziono żadnego obrazu w ghcr.io ani tagu git.';
    }
    if (warning) $('tag-hint').textContent = warning;
    for (const t of tags) {
      $('tag').append(el('option', {
        value: t.name,
        textContent: t.name + (t.name === latest ? ' (najnowszy)' : '') + (t.prerelease ? ' [wstępna]' : '') + (t.image ? '' : ' [tylko tag git]'),
      }));
    }
    if (latest) $('tag').value = latest;
  } catch (e) { $('error').textContent = e.message; }
}

async function run(action) {
  $('error').textContent = '';
  const tag = $('tag').value;
  const s = currentServer();
  if (!tag) { $('error').textContent = 'Brak tagu do wdrożenia.'; return; }
  if (!s) { $('error').textContent = 'Wybierz serwer.'; return; }
  const domain = $('domain').value.trim();
  if (!domain) { $('error').textContent = 'Wpisz domenę aplikacji.'; return; }
  if (action === 'install') {
    if (!domain.includes('.')) { $('error').textContent = 'Do instalacji wpisz pełną domenę (np. app.example.com).'; return; }
    if (!confirm(`Zainstalować NOWĄ aplikację ${name}:${tag} na serwerze ${s.name} pod adresem ${domain}?`)) return;
  } else if (s.kind === 'produkcja' && !confirm(`Wdrożyć ${name}:${tag} na serwer produkcyjny ${s.name}?`)) {
    return;
  }
  $('deploy').disabled = true;
  $('install').disabled = true;
  try {
    if (domain !== targets[s.id]) await saveDomain();
    const { id } = await api('/api/deployments', { method: 'POST', body: JSON.stringify({ repo: name, tag, server_id: s.id, action }) });
    $('run').hidden = false;
    await followDeployment(id, (d) => {
      const st = STATUS[d.status] || { text: d.status, cls: '' };
      $('status').textContent = st.text;
      $('status').className = `badge ${st.cls}`;
      $('log').textContent = d.log;
      $('log').scrollTop = $('log').scrollHeight;
    });
  } catch (e) {
    $('error').textContent = e.message;
  } finally {
    $('deploy').disabled = false;
    $('install').disabled = false;
  }
}

$('deploy').addEventListener('click', () => run('update'));
$('install').addEventListener('click', () => run('install'));
$('server').addEventListener('change', () => {
  try { localStorage.setItem(`server:${name}`, $('server').value); } catch { /* brak pamieci przegladarki */ }
  showServer();
});
$('domain').addEventListener('change', saveDomain);
init();
