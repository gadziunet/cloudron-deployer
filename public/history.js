import { api, el, bindLogout, STATUS } from './common.js';

bindLogout();

async function load() {
  const box = document.getElementById('list');
  const rows = await api('/api/deployments');
  box.textContent = '';
  if (!rows.length) box.textContent = 'Nie było jeszcze żadnych wdrożeń.';
  for (const d of rows) {
    const st = STATUS[d.status] || { text: d.status, cls: '' };
    const log = el('pre', { class: 'log' });
    log.hidden = true;
    const head = el('div', { class: 'row clickable' },
      el('span', {}, `${d.repo}:${d.tag}${d.action === 'install' ? ' (instalacja)' : ''}`,
        el('small', { textContent: `${d.environment} · ${d.server_name || '?'} · ${d.app_domain || '?'} · ${d.started_at} UTC` })),
      el('span', { class: st.cls, textContent: st.text }));
    head.addEventListener('click', async () => {
      if (log.hidden) log.textContent = (await api(`/api/deployments/${d.id}`)).log || '(pusty log)';
      log.hidden = !log.hidden;
    });
    box.append(head, log);
  }
}

load();
