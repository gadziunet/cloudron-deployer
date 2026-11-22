import express from 'express';
import { UserError, normalizeAddress } from './integrations.js';
import { checkRepoName } from './github.js';
import { sortTags, latestTag } from './tags.js';

export function reposRouter({ db, github }) {
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
    const names = await github.listTagNames(req.params.owner, req.params.repo);
    const tags = sortTags(names);
    res.json({ latest: latestTag(tags), tags });
  }));

  // Zapamiętane domeny aplikacji dla repozytorium: { testowa: "...", produkcja: "..." }
  router.get('/repos/:owner/:repo/targets', wrap(async (req, res) => {
    const { owner, repo } = req.params;
    checkRepoName(owner, repo);
    const rows = db.prepare('SELECT environment, app_domain FROM targets WHERE repo = ?').all(`${owner}/${repo}`);
    const out = { testowa: null, produkcja: null };
    for (const r of rows) out[r.environment] = r.app_domain;
    res.json(out);
  }));

  router.put('/repos/:owner/:repo/targets/:env', wrap(async (req, res) => {
    const { owner, repo, env } = req.params;
    checkRepoName(owner, repo);
    if (!['testowa', 'produkcja'].includes(env)) throw new UserError('Nieznane srodowisko', 404);
    const domain = normalizeAddress(req.body?.app_domain);
    db.prepare(
      'INSERT INTO targets(repo, environment, app_domain) VALUES (?, ?, ?) ON CONFLICT(repo, environment) DO UPDATE SET app_domain = excluded.app_domain'
    ).run(`${owner}/${repo}`, env, domain);
    res.json({ environment: env, app_domain: domain });
  }));

  return router;
}
