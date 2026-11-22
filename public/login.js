const form = document.getElementById('form');
const errorBox = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wdrazacz' },
    body: JSON.stringify({
      username: form.username.value,
      password: form.password.value,
    }),
  });
  if (res.ok) {
    location.href = '/';
  } else {
    const data = await res.json().catch(() => ({}));
    errorBox.textContent = data.error || 'Nie udalo sie zalogowac';
  }
});
