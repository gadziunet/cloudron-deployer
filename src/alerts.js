// Ostrzeżenia o wygasających tokenach na podstawie dat wpisanych ręcznie w ustawieniach.
export const WARN_DAYS = 14;

export function daysLeft(expires, today = new Date()) {
  const end = Date.parse(`${expires}T00:00:00Z`);
  const start = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

// Zwraca ostrzeżenia dla tokenów, którym zostało WARN_DAYS dni lub mniej (albo już wygasły).
export function buildAlerts({ githubExpires, servers }, today = new Date()) {
  const items = [];
  if (githubExpires) items.push({ kind: 'github', name: 'GitHub', expires: githubExpires });
  for (const s of servers) {
    if (s.expires) items.push({ kind: 'cloudron', name: s.name, expires: s.expires });
  }
  return items
    .map((i) => ({ ...i, days: daysLeft(i.expires, today) }))
    .filter((i) => i.days <= WARN_DAYS)
    .map((i) => ({
      ...i,
      expired: i.days < 0,
      message: i.days < 0
        ? `Token ${i.kind === 'github' ? 'GitHub' : `serwera ${i.name}`} wygasl ${i.expires}`
        : i.days === 0
          ? `Token ${i.kind === 'github' ? 'GitHub' : `serwera ${i.name}`} wygasa dzisiaj (${i.expires})`
          : `Token ${i.kind === 'github' ? 'GitHub' : `serwera ${i.name}`} wygasa ${i.expires} (za ${i.days} dni)`,
    }))
    .sort((a, b) => a.days - b.days);
}
