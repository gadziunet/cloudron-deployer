import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UserError, cloudronRequest } from './integrations.js';
import { checkRepoName } from './github.js';
import { getBearer, listDeployableTags } from './ghcr.js';

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_LOG = 200_000;
const CLI_TIMEOUT_MS = 20 * 60_000;

// Uruchamia Cloudron CLI. Wstrzykiwane, żeby testy nie potrzebowały prawdziwego CLI.
export function defaultRunCli({ args, env, cwd, onData }) {
  return new Promise((resolve) => {
    const child = spawn('cloudron', args, { env, cwd });
    const timer = setTimeout(() => {
      onData('\n[przekroczono limit czasu 20 minut, przerywam]\n');
      child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('error', (e) => { clearTimeout(timer); onData(`Nie mozna uruchomic Cloudron CLI: ${e.message}\n`); resolve(127); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

// Czy obraz ghcr.io/<owner>/<repo>:<tag> istnieje? 'yes' | 'no' | 'unknown'
export async function imageExists(fetchFn, creds, owner, repo, tag) {
  const image = `${owner}/${repo}`.toLowerCase();
  try {
    const bearer = await getBearer(fetchFn, creds, image);
    if (!bearer) return 'unknown';
    const m = await fetchFn(`https://ghcr.io/v2/${image}/manifests/${encodeURIComponent(tag)}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (m.status === 200) return 'yes';
    if (m.status === 404) return 'no';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// Znajduje aplikację o danej domenie (fqdn) na serwerze Cloudron
export async function findCloudronApp(fetchFn, address, token, domain) {
  const res = await cloudronRequest(fetchFn, address, token, '/api/v1/apps');
  if (res.status === 401 || res.status === 403) throw new UserError('Cloudron odrzucil token API (wygasl?). Zmien go w ustawieniach.');
  if (!res.ok) throw new UserError(`Cloudron zwrocil blad ${res.status}`);
  const { apps = [] } = await res.json();
  const app = apps.find((a) => String(a.fqdn).toLowerCase() === domain.toLowerCase());
  if (!app) throw new UserError(`Na serwerze ${address} nie ma aplikacji o domenie ${domain}`);
  return { id: app.id, fqdn: app.fqdn };
}

function safeRelPath(p) {
  const n = path.posix.normalize(String(p));
  if (!n || n === '.' || n.startsWith('/') || n.startsWith('..') || n.includes('\0')) {
    throw new UserError(`Niebezpieczna sciezka w manifescie: ${p}`);
  }
  return n;
}

// Pliki, do których odwołuje się manifest (CLI czyta je z katalogu obok manifestu)
export function referencedFiles(manifest) {
  const files = new Set();
  const icon = manifest.icon;
  if (typeof icon === 'string' && icon && !/^[a-z]+:\/\//i.test(icon.replace(/^file:\/\//, 'x'))) {
    files.add(safeRelPath(icon.startsWith('file://') ? icon.slice(7) : icon));
  }
  for (const key of ['description', 'changelog', 'postInstallMessage']) {
    const v = manifest[key];
    if (typeof v === 'string' && v.startsWith('file://')) files.add(safeRelPath(v.slice(7)));
  }
  return [...files];
}

export function makeDeployer({ db, vault, github, fetchFn, getGithub, runCli = defaultRunCli }) {
  // Po restarcie aplikacji wdrożenia, które były w toku, nie mają już procesu
  db.prepare("UPDATE deployments SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'").run();

  function stamp() { return new Date().toISOString().slice(11, 19); }

  async function run(id, ctx) {
    const { repo, tag, server, serverToken, domain, gh } = ctx;
    const [owner, name] = repo.split('/');
    const image = `ghcr.io/${owner}/${name}`.toLowerCase();
    const secrets = [serverToken, gh.token].filter(Boolean);
    let buffer = '';
    let timer = null;
    let workDir = null;

    const mask = (text) => secrets.reduce((t, s) => t.split(s).join('***'), text);
    const flush = () => {
      clearTimeout(timer); timer = null;
      db.prepare('UPDATE deployments SET log = ? WHERE id = ?').run(buffer.slice(-MAX_LOG), id);
    };
    const append = (text) => {
      buffer += mask(text);
      if (!timer) timer = setTimeout(flush, 400);
    };
    const log = (line) => append(`[${stamp()}] ${line}\n`);

    let status = 'failed';
    try {
      log(`Wdrazanie ${repo}:${tag} -> serwer ${server.name} (${server.kind}), ${domain}`);

      const exists = await imageExists(fetchFn, gh, owner, name, tag);
      if (exists === 'no') throw new UserError(`Obraz ${image}:${tag} nie istnieje w ghcr.io`);
      log(exists === 'yes'
        ? `Obraz ${image}:${tag} istnieje w ghcr.io`
        : 'Nie udalo sie sprawdzic obrazu w ghcr.io (brak uprawnien read:packages?). Kontynuuje.');

      const app = await findCloudronApp(fetchFn, server.address, serverToken, domain);
      log(`Aplikacja na serwerze: ${app.fqdn} (${app.id})`);

      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdr-deploy-'));
      // Tag obrazu nie musi byc tagiem git (np. obraz 0.3.1, tag git v0.3.1 albo brak): probujemy po kolei
      const refs = [...new Set([tag, tag.startsWith('v') ? tag.slice(1) : `v${tag}`])];
      let manifestText = null;
      let manifestRef = null;
      for (const ref of [...refs, '']) {
        try {
          manifestText = await github.getFileAtTag(owner, name, 'CloudronManifest.json', ref);
          manifestRef = ref;
          break;
        } catch (e) {
          if (!(e instanceof UserError) || e.status !== 404) throw e;
        }
      }
      if (manifestText === null) throw new UserError('Nie znaleziono CloudronManifest.json w repozytorium');
      if (manifestRef === '') {
        log(`UWAGA: brak tagu git dla wersji ${tag}. Uzywam CloudronManifest.json z domyslnej galezi, sprawdz czy pasuje do obrazu.`);
      }
      let manifest;
      try { manifest = JSON.parse(manifestText); } catch { throw new UserError('CloudronManifest.json w repozytorium nie jest poprawnym JSON'); }
      fs.writeFileSync(path.join(workDir, 'CloudronManifest.json'), manifestText);
      log(`Pobrano CloudronManifest.json (${manifestRef === '' ? 'domyslna galaz' : `ref ${manifestRef}`})`);

      for (const rel of referencedFiles(manifest)) {
        const text = await github.getFileAtTag(owner, name, rel, manifestRef);
        const target = path.join(workDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
        log(`Pobrano plik z manifestu: ${rel}`);
      }

      log('Uruchamiam: cloudron update');
      const code = await runCli({
        args: ['--server', server.address, '--wait-timeout', '15m', 'update', '--app', app.id, '--image', `${image}:${tag}`],
        // token tylko w zmiennej srodowiskowej (nie w argumentach), HOME w katalogu tymczasowym
        env: { PATH: process.env.PATH, HOME: workDir, CLOUDRON_CLI_AUTH_TOKEN: serverToken, NO_COLOR: '1' },
        cwd: workDir,
        onData: append,
      });
      if (code !== 0) throw new UserError(`Cloudron CLI zakonczylo sie kodem ${code}`);
      log('Gotowe: aplikacja zaktualizowana.');
      status = 'success';
    } catch (e) {
      if (e instanceof UserError) log(`BLAD: ${e.message}`);
      else { console.error(e); log('BLAD: nieoczekiwany blad aplikacji'); }
    } finally {
      flush();
      db.prepare("UPDATE deployments SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, id);
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // Kontrole przed startem (błędy wracają od razu), potem wdrożenie działa w tle.
  async function start({ repo, tag, server_id: serverId }) {
    const parts = String(repo || '').split('/');
    if (parts.length !== 2) throw new UserError('Niepoprawna nazwa repozytorium');
    checkRepoName(parts[0], parts[1]);
    if (!TAG_RE.test(String(tag || ''))) throw new UserError('Niepoprawny tag');

    const server = db.prepare('SELECT id, name, address, token_enc, kind FROM servers WHERE id = ?').get(Number(serverId));
    if (!server) throw new UserError('Nie ma takiego serwera (wybierz serwer)', 404);
    const target = db.prepare('SELECT app_domain FROM server_targets WHERE repo = ? AND server_id = ?').get(repo, server.id);
    if (!target) throw new UserError('Najpierw wpisz domene aplikacji dla tego serwera', 409);
    const gh = getGithub();
    if (!gh.token) throw new UserError('Najpierw dodaj token GitHub w ustawieniach', 409);

    const { names } = await listDeployableTags({ fetchFn, github, creds: gh, owner: parts[0], repo: parts[1] });
    if (!names.includes(tag)) throw new UserError('Taki tag nie istnieje (ani jako obraz w ghcr.io, ani jako tag git)', 404);

    // od tego miejsca bez await: kontrola blokady i zapis sa atomowe
    const busy = db.prepare("SELECT id FROM deployments WHERE status = 'running' AND server_name = ? AND app_domain = ?")
      .get(server.name, target.app_domain);
    if (busy) throw new UserError(`Ta aplikacja jest wlasnie wdrazana (wdrozenie nr ${busy.id})`, 409);

    const info = db.prepare(
      "INSERT INTO deployments(repo, tag, environment, server_name, app_domain, status) VALUES (?, ?, ?, ?, ?, 'running')"
    ).run(repo, tag, server.kind, server.name, target.app_domain);
    const id = Number(info.lastInsertRowid);

    const done = run(id, {
      repo, tag, server,
      serverToken: vault.decrypt(server.token_enc),
      domain: target.app_domain,
      gh,
    });
    return { id, done };
  }

  return { start };
}
