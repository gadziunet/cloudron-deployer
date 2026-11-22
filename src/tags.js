// Sortowanie tagów: wersje semver (v1.2.3, 1.2.3-rc1) od najnowszej, potem reszta w kolejności z GitHuba.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

export function parseTag(name) {
  const m = SEMVER.exec(name);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;   // wydanie > wersja wstępna
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function sortTags(names) {
  const semver = [];
  const other = [];
  names.forEach((name, index) => {
    const parsed = parseTag(name);
    if (parsed) semver.push({ name, parsed });
    else other.push({ name, index });
  });
  semver.sort((x, y) => compare(y.parsed, x.parsed));
  return [
    ...semver.map((t) => ({ name: t.name, semver: true, prerelease: t.parsed.pre !== null })),
    ...other.sort((x, y) => x.index - y.index).map((t) => ({ name: t.name, semver: false, prerelease: false })),
  ];
}

// "Najnowszy" = najwyższe stabilne semver, a gdy takich nie ma - pierwszy z listy
export function latestTag(sorted) {
  return (sorted.find((t) => t.semver && !t.prerelease) || sorted[0] || null)?.name ?? null;
}
