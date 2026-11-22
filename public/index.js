const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };

async function api(path, options = {}) {
  const res = await fetch(path, { headers, ...options });
  if (res.status === 401) { location.href = '/'; throw new Error('401'); }
  return res.json();
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});

api('/api/me').then((me) => {
  document.getElementById('info').textContent = `Zalogowano jako ${me.username}. Lista repozytoriów pojawi się w etapie 3.`;
});
