import { api, el, bindLogout } from './common.js';

bindLogout();

async function showAlerts() {
  const box = document.getElementById('alerts');
  box.textContent = '';
  for (const a of await api('/api/alerts')) {
    box.append(el('div', { class: 'alert', role: 'alert' },
      `⚠ ${a.message}`,
      el('a', { href: '/settings.html', textContent: 'Zmień w ustawieniach' })));
  }
}

let repos = [];
function render() {
  const box = document.getElementById('repos');
  const q = document.getElementById('filter').value.trim().toLowerCase();
  box.textContent = '';
  const shown = repos.filter((r) => r.full_name.toLowerCase().includes(q));
  if (!shown.length) box.textContent = 'Brak repozytoriów.';
  for (const r of shown) {
    box.append(el('a', { class: 'row repo', href: `/repo.html?name=${encodeURIComponent(r.full_name)}` },
      el('span', {}, r.full_name, el('small', { textContent: r.description })),
      el('span', { class: 'muted', textContent: r.private ? 'prywatne' : 'publiczne' })));
  }
}

async function loadRepos() {
  const box = document.getElementById('repos');
  try {
    repos = await api('/api/repos');
    render();
  } catch (e) {
    box.textContent = '';
    box.append(el('div', { class: 'error', textContent: e.message }),
      el('a', { href: '/settings.html', textContent: 'Przejdź do ustawień' }));
  }
}

document.getElementById('filter').addEventListener('input', render);
showAlerts();
loadRepos();
