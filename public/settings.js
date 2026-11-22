import { api, el, initHeader, expiryInfo, dateInput } from './common.js';

initHeader();
const $ = (id) => document.getElementById(id);

function say(box, text, ok = false) {
  box.className = ok ? 'ok' : 'error';
  box.textContent = text;
}

// Wynik synchronizacji rejestru ghcr.io: jedna linia na serwer
function showRegistry(results) {
  const box = $('sync-msg');
  box.textContent = '';
  for (const r of results || []) {
    const text = r.ok
      ? `${r.server}: ghcr.io ${r.action === 'updated' ? 'zaktualizowany' : 'dodany'}`
      : `${r.server}: BŁĄD, ${r.message}`;
    box.append(el('div', { class: r.ok ? 'ok-text' : 'err-text', textContent: text }));
  }
}

// --- GitHub
async function loadGithub() {
  const s = await api('/api/settings/github');
  const box = $('github-status');
  box.textContent = '';
  if (s.configured) {
    const info = expiryInfo(s.expires);
    const label = el('small', { class: info.cls, textContent: info.text });
    const userInput = el('input', { value: s.username || '', placeholder: s.login, title: 'Użytkownik ghcr.io' });
    userInput.className = 'date';
    userInput.addEventListener('change', async () => {
      try {
        const r = await api('/api/settings/github', { method: 'PATCH', body: JSON.stringify({ username: userInput.value }) });
        showRegistry(r.registry);
      } catch (err) { say($('github-msg'), err.message); }
    });
    box.append(el('div', { class: 'row' },
      el('span', {}, `Połączono jako ${s.login}`, label,
        el('small', { textContent: 'Użytkownik ghcr.io (zmiana wysyła dane na serwery):' }), userInput,
        dateInput(s.expires, async (value) => {
          await api('/api/settings/github', { method: 'PATCH', body: JSON.stringify({ expires: value }) });
          loadGithub();
        })),
      el('button', {
        class: 'danger', textContent: 'Usuń',
        onclick: async () => { await api('/api/settings/github', { method: 'DELETE' }); loadGithub(); },
      })));
  } else {
    box.textContent = 'Brak tokenu.';
  }
}

$('github-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/settings/github', { method: 'PUT', body: JSON.stringify({ token: $('github-token').value, expires: $('github-expires').value, username: $('github-username').value }) });
    $('github-token').value = '';
    $('github-expires').value = '';
    $('github-username').value = '';
    say($('github-msg'), `Zapisano. Konto: ${r.login}`, true);
    showRegistry(r.registry);
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
    const info = expiryInfo(s.expires);
    const expiry = el('small', { class: info.cls, textContent: `token: ${info.text}` });
    const kind = el('select', { title: 'Rodzaj serwera' },
      el('option', { value: 'testowa', textContent: 'Testowy' }),
      el('option', { value: 'produkcja', textContent: 'Produkcyjny' }));
    kind.className = 'date';
    kind.value = s.kind;
    kind.addEventListener('change', async () => {
      await api(`/api/servers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ kind: kind.value }) });
    });
    box.append(el('div', { class: 'row' },
      el('span', {}, s.name, status, expiry, kind,
        dateInput(s.expires, async (value) => {
          await api(`/api/servers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ expires: value }) });
          loadAll();
        })),
      el('span', { class: 'actions' },
        el('button', {
          class: 'secondary', textContent: 'Sprawdź',
          onclick: async () => {
            status.textContent = `${s.address} - sprawdzam...`;
            try { const r = await api(`/api/servers/${s.id}/check`, { method: 'POST' }); status.textContent = `${s.address} - OK (${r.username})`; }
            catch (err) { status.textContent = `${s.address} - ${err.message}`; }
          },
        }),
        el('button', {
          class: 'danger', textContent: 'Usuń',
          onclick: async () => {
            if (!confirm(`Usunąć serwer ${s.name}?`)) return;
            await api(`/api/servers/${s.id}`, { method: 'DELETE' });
            loadAll();
          },
        }))));
  }
  return servers;
}

async function loadAll() {
  await loadServers();
}

$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: $('server-name').value, address: $('server-address').value, token: $('server-token').value, expires: $('server-expires').value, kind: $('server-kind').value }),
    });
    e.target.reset();
    $('server-form').hidden = true;
    $('add-server').hidden = false;
    say($('sync-msg'), `Dodano serwer. Token należy do: ${r.username}`, true);
    if (r.registry) showRegistry([r.registry]);
    loadAll();
  } catch (err) { say($('server-msg'), err.message); }
});

$('add-server').addEventListener('click', () => {
  $('server-form').hidden = false;
  $('add-server').hidden = true;
  $('server-name').focus();
});
$('cancel-server').addEventListener('click', () => {
  $('server-form').reset();
  $('server-msg').textContent = '';
  $('server-form').hidden = true;
  $('add-server').hidden = false;
});

// --- Ręczna synchronizacja ghcr.io
$('sync-registry').addEventListener('click', async () => {
  $('sync-msg').textContent = 'Synchronizuję...';
  try {
    const r = await api('/api/registry/sync', { method: 'POST', body: JSON.stringify({}) });
    if (!r.registry.length) $('sync-msg').textContent = 'Brak serwerów do synchronizacji.';
    else showRegistry(r.registry);
  } catch (err) { $('sync-msg').textContent = err.message; }
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
