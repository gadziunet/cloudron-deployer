import { api, el, bindLogout } from './common.js';

bindLogout();
const $ = (id) => document.getElementById(id);

function say(box, text, ok = false) {
  box.className = ok ? 'ok' : 'error';
  box.textContent = text;
}

// --- GitHub
async function loadGithub() {
  const s = await api('/api/settings/github');
  const box = $('github-status');
  box.textContent = '';
  if (s.configured) {
    box.append(el('div', { class: 'row' },
      el('span', {}, `Połączono jako ${s.login}`),
      el('button', {
        class: 'danger flat', textContent: 'Usuń',
        onclick: async () => { await api('/api/settings/github', { method: 'DELETE' }); loadGithub(); },
      })));
  } else {
    box.textContent = 'Brak tokenu.';
  }
}

$('github-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/settings/github', { method: 'PUT', body: JSON.stringify({ token: $('github-token').value }) });
    $('github-token').value = '';
    say($('github-msg'), `Zapisano. Konto: ${r.login}`, true);
    loadGithub();
  } catch (err) { say($('github-msg'), err.message); }
});

// --- Serwery i środowiska
async function loadServers() {
  const servers = await api('/api/servers');
  const box = $('servers');
  box.textContent = '';
  if (!servers.length) box.textContent = 'Brak serwerów.';
  for (const s of servers) {
    const status = el('small', {}, s.address);
    box.append(el('div', { class: 'row' },
      el('span', {}, s.name, status),
      el('span', {},
        el('button', {
          class: 'secondary flat', textContent: 'Sprawdź',
          onclick: async () => {
            status.textContent = `${s.address} - sprawdzam...`;
            try { const r = await api(`/api/servers/${s.id}/check`, { method: 'POST' }); status.textContent = `${s.address} - OK (${r.username})`; }
            catch (err) { status.textContent = `${s.address} - ${err.message}`; }
          },
        }),
        el('button', {
          class: 'danger flat', textContent: 'Usuń',
          onclick: async () => {
            if (!confirm(`Usunąć serwer ${s.name}?`)) return;
            await api(`/api/servers/${s.id}`, { method: 'DELETE' });
            loadAll();
          },
        }))));
  }
  return servers;
}

async function loadEnvironments(servers) {
  const envs = await api('/api/environments');
  const box = $('environments');
  box.textContent = '';
  for (const env of envs) {
    const select = el('select', {},
      el('option', { value: '', textContent: '- nie wybrano -' }),
      ...servers.map((s) => el('option', { value: String(s.id), textContent: `${s.name} (${s.address})` })));
    select.value = env.server_id === null ? '' : String(env.server_id);
    select.addEventListener('change', async () => {
      await api(`/api/environments/${env.name}`, {
        method: 'PUT',
        body: JSON.stringify({ server_id: select.value === '' ? null : Number(select.value) }),
      });
    });
    box.append(el('label', { textContent: env.name === 'testowa' ? 'Testowa' : 'Produkcja' }), select);
  }
}

async function loadAll() {
  const servers = await loadServers();
  await loadEnvironments(servers);
}

$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: $('server-name').value, address: $('server-address').value, token: $('server-token').value }),
    });
    e.target.reset();
    say($('server-msg'), `Dodano. Token należy do: ${r.username}`, true);
    loadAll();
  } catch (err) { say($('server-msg'), err.message); }
});

// --- Hasło
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ current: $('pw-current').value, next: $('pw-new').value }) });
    e.target.reset();
    say($('pw-msg'), 'Hasło zmienione.', true);
  } catch (err) { say($('pw-msg'), err.message); }
});

loadGithub();
loadAll();
