import { api, el, bindLogout, STATUS, followDeployment } from './common.js';

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
    showEnvHint();
  } catch (e) { $('error').textContent = e.message; }
}

async function deploy() {
  $('error').textContent = '';
  const tag = $('tag').value;
  const env = $('env').value;
  if (!tag) { $('error').textContent = 'Brak tagu do wdrożenia.'; return; }
  if (!$('domain').value.trim()) { $('error').textContent = 'Wpisz domenę aplikacji.'; return; }
  if (env === 'produkcja' && !confirm(`Wdrożyć ${name}:${tag} na PRODUKCJĘ?`)) return;
  $('deploy').disabled = true;
  try {
    if ($('domain').value.trim() !== targets[env]) await saveDomain();
    const { id } = await api('/api/deployments', { method: 'POST', body: JSON.stringify({ repo: name, tag, environment: env }) });
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
  }
}

$('deploy').addEventListener('click', deploy);
$('env').addEventListener('change', showEnvHint);
$('domain').addEventListener('change', saveDomain);
init();
