'use strict';

const express = require('express');
const crypto  = require('crypto');

/**
 * Start an Express HTTP server for incoming webhooks.
 * Webhooks are registered in the DB as (user_id, name, token, description).
 * Any POST to /webhook/:token delivers the request body as a Telegram message.
 *
 * @param {object} db       - better-sqlite3 instance
 * @param {object} telegram - Telegraf telegram instance
 * @returns {{ app, server, addWebhook, removeWebhook, listWebhooks }}
 */
function startWebhookServer(db, telegram) {
  const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
  const app  = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ limit: '1mb' }));

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Incoming webhook
  app.post('/webhook/:token', async (req, res) => {
    const { token } = req.params;
    const hook = db.prepare('SELECT * FROM webhooks WHERE token = ? AND enabled = 1').get(token);

    if (!hook) return res.status(404).json({ error: 'Unknown webhook' });

    const body = typeof req.body === 'object'
      ? JSON.stringify(req.body, null, 2)
      : String(req.body || '(empty body)');

    const text = `Webhook [${hook.name}]:\n${body.slice(0, 3500)}`;

    try {
      await telegram.sendMessage(hook.user_id, text);
      res.json({ ok: true });
    } catch (err) {
      console.error('[webhook] Failed to send message:', err.message);
      res.status(500).json({ error: 'Failed to deliver' });
    }
  });

  // ── DB helpers (used by tools) ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  function addWebhook(userId, name, description = '') {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT OR REPLACE INTO webhooks (user_id, name, token, description) VALUES (?, ?, ?, ?)')
      .run(userId, name, token, description);
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    return { token, url: `${baseUrl}/webhook/${token}` };
  }

  function removeWebhook(userId, name) {
    return db.prepare('DELETE FROM webhooks WHERE user_id = ? AND name = ?')
      .run(userId, name).changes > 0;
  }

  function listWebhooks(userId) {
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    return db.prepare('SELECT name, token, description FROM webhooks WHERE user_id = ? AND enabled = 1 ORDER BY id')
      .all(userId)
      .map((w) => ({ ...w, url: `${baseUrl}/webhook/${w.token}` }));
  }

  const server = app.listen(port, () => {
    console.log(`[webhook] Server listening on port ${port}`);
  });

  return { app, server, addWebhook, removeWebhook, listWebhooks };
}

module.exports = { startWebhookServer };
