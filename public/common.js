const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' };

export async function api(path, options = {}) {
  const res = await fetch(path, { headers, ...options });
  if (res.status === 401) { location.href = '/'; throw new Error('401'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Blad ${res.status}`);
  return data;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

export function bindLogout() {
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/';
  });
}
