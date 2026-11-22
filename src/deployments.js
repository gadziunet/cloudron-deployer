import express from 'express';
import { UserError } from './integrations.js';

export function deploymentsRouter({ db, deployer }) {
  const router = express.Router();

  router.post('/deployments', async (req, res) => {
    try {
      const { id } = await deployer.start({
        repo: req.body?.repo, tag: req.body?.tag, server_id: req.body?.server_id,
      });
      res.status(202).json({ id });
    } catch (e) {
      if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Blad serwera' });
    }
  });

  router.get('/deployments', (req, res) => {
    const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
    const rows = repo
      ? db.prepare('SELECT id, repo, tag, environment, server_name, app_domain, status, started_at, finished_at FROM deployments WHERE repo = ? ORDER BY id DESC LIMIT 50').all(repo)
      : db.prepare('SELECT id, repo, tag, environment, server_name, app_domain, status, started_at, finished_at FROM deployments ORDER BY id DESC LIMIT 50').all();
    res.json(rows);
  });

  router.get('/deployments/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Nie ma takiego wdrozenia' });
    res.json(row);
  });

  return router;
}
