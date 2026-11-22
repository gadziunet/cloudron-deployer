import express from 'express';
import { UserError, normalizeAddress } from './integrations.js';
import { checkRepoName } from './github.js';
import { sortTags, latestTag } from './tags.js';
import { listDeployableTags } from './ghcr.js';

export function reposRouter({ db, github, fetchFn, getGithub }) {
  const router = express.Router();

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Blad serwera' });
    }
  };

  router.get('/repos', wrap(async (req, res) => {
    res.json(await github.listRepos());
  }));

  router.get('/repos/:owner/:repo/tags', wrap(async (req, res) => {
    const { owner, repo } = req.params;
    checkRepoName(owner, repo);
    const { names, imageTags, warning } = await listDeployableTags({ fetchFn, github, creds: getGithub(), owner, repo });
    const tags = sortTags(names).map((t) => ({ ...t, image: imageTags.includes(t.name) }));
    res.json({ latest: latestTag(tags), tags, warning });
  }));

  // Zapamiętane domeny aplikacji dla repozytorium: { "<id serwera>": "domena" }
  router.get('/repos/:owner/:repo/targets', wrap(async (req, res) => {
    const { owner, repo } = req.params;
    checkRepoName(owner, repo);
    const rows = db.prepare('SELECT server_id, app_domain FROM server_targets WHERE repo = ?').all(`${owner}/${repo}`);
    const out = {};
    for (const r of rows) out[r.server_id] = r.app_domain;
    res.json(out);
  }));

  router.put('/repos/:owner/:repo/targets/:serverId', wrap(async (req, res) => {
    const { owner, repo } = req.params;
    checkRepoName(owner, repo);
    const serverId = Number(req.params.serverId);
    if (!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(serverId)) throw new UserError('Nie ma takiego serwera', 404);
    const domain = normalizeAddress(req.body?.app_domain);
    db.prepare(
      'INSERT INTO server_targets(repo, server_id, app_domain) VALUES (?, ?, ?) ON CONFLICT(repo, server_id) DO UPDATE SET app_domain = excluded.app_domain'
    ).run(`${owner}/${repo}`, serverId, domain);
    res.json({ server_id: serverId, app_domain: domain });
  }));

  return router;
}
