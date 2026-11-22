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

showAlerts();
api('/api/me').then((me) => {
  document.getElementById('info').textContent =
    `Zalogowano jako ${me.username}. Lista repozytoriów pojawi się w etapie 3.`;
});
