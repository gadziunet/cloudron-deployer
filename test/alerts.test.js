import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, daysLeft } from '../src/alerts.js';

const today = new Date('2026-11-22T10:00:00Z');

test('daysLeft liczy pełne dni kalendarzowe', () => {
  assert.equal(daysLeft('2026-11-22', today), 0);
  assert.equal(daysLeft('2026-11-23', today), 1);
  assert.equal(daysLeft('2026-11-21', today), -1);
  assert.equal(daysLeft('2026-12-06', today), 14);
});

test('ostrzeżenia tylko dla tokenów z 14 dniami lub mniej, posortowane od najpilniejszych', () => {
  const alerts = buildAlerts({
    githubExpires: '2026-12-06',               // 14 dni - ostrzega
    servers: [
      { name: 'Test', expires: '2026-12-07' },  // 15 dni - cicho
      { name: 'Produkcja', expires: '2026-11-20' }, // wygasł
      { name: 'Bez daty', expires: null },
    ],
  }, today);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].name, 'Produkcja');
  assert.equal(alerts[0].expired, true);
  assert.match(alerts[0].message, /wygasl 2026-11-20/);
  assert.equal(alerts[1].kind, 'github');
  assert.match(alerts[1].message, /za 14 dni/);
});

test('token wygasający dzisiaj ma osobny komunikat', () => {
  const [a] = buildAlerts({ githubExpires: '2026-11-22', servers: [] }, today);
  assert.match(a.message, /wygasa dzisiaj/);
  assert.equal(a.expired, false);
});

test('brak dat = brak ostrzeżeń', () => {
  assert.deepEqual(buildAlerts({ githubExpires: null, servers: [{ name: 'X', expires: null }] }, today), []);
});
