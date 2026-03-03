'use strict';

const express = require('express');
const crypto = require('crypto');
const { getWebhook, createWebhook, removeWebhooks, listWebhooksByUser } = require('./database');

/**
 * Start an Express HTTP server for incoming webhooks.
 * Webhooks are registered in the DB as (user_id, name, token, description).
 * Any POST to /webhook/:token delivers the request body as a Telegram message.
 *
 * @param {object} db       - Database instance (kept for API compat)
 * @param {object} telegram - Telegraf telegram instance
 * @returns {{ app, server, addWebhook, removeWebhook, listWebhooks }}
 */
// Per-token in-memory rate limit: max 60 requests per minute.
const _webhookRateLimits = new Map();
function _checkWebhookRateLimit(token) {
  const now = Math.floor(Date.now() / 60000);
  const entry = _webhookRateLimits.get(token) || { count: 0, windowStart: now };
  if (entry.windowStart !== now) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  _webhookRateLimits.set(token, entry);
  return entry.count <= 60;
}

const WEBHOOK_BODY_LIMIT = 3500;

function startWebhookServer(db, telegram) {
  const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
  const app = express();
  const oauthBase = (process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ limit: '1mb' }));

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Google OAuth Auth URL (deprecated in Node runtime, forwarded to Vercel owner)
  app.get('/api/auth/google', (req, res) => {
    if (!oauthBase) {
      return res.status(410).send('Google OAuth now lives on the webview service. Configure GOOGLE_OAUTH_BASE_URL and use /linkgoogle.');
    }
    const target = new URL(`${oauthBase}/api/auth/google`);
    if (req.query?.state) target.searchParams.set('state', String(req.query.state));
    return res.redirect(308, target.toString());
  });

  // Google OAuth Callback (deprecated in Node runtime, forwarded to Vercel owner)
  app.get(['/auth/google/callback', '/api/auth/google/callback'], async (req, res) => {
    if (!oauthBase) {
      return res.status(410).send('Google OAuth callback moved to the webview service. Configure GOOGLE_OAUTH_BASE_URL and update Google redirect URIs.');
    }
    const target = new URL(`${oauthBase}/api/auth/google/callback`);
    for (const [key, value] of Object.entries(req.query || {})) {
      if (value === undefined || value === null) continue;
      target.searchParams.set(key, String(value));
    }
    return res.redirect(308, target.toString());
  });

  // Incoming webhook
  app.post('/webhook/:token', async (req, res) => {
    const { token } = req.params;

    if (!_checkWebhookRateLimit(token)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Max 60 requests/minute per webhook.' });
    }

    const hook = await getWebhook(token);
    if (!hook || hook.enabled !== 1) return res.status(404).json({ error: 'Unknown webhook' });

    const body = typeof req.body === 'object'
      ? JSON.stringify(req.body, null, 2)
      : String(req.body || '(empty body)');

    const truncated = body.length > WEBHOOK_BODY_LIMIT;
    const text = `Webhook [${hook.name}]:\n${body.slice(0, WEBHOOK_BODY_LIMIT)}${truncated ? '\n... [TRUNCATED]' : ''}`;

    try {
      await telegram.sendMessage(hook.user_id, text);
      res.json({ ok: true });
    } catch (err) {
      console.error('[webhook] Failed to send message:', err.message);
      res.status(500).json({ error: 'Failed to deliver' });
    }
  });

  async function addWebhook(userId, name, description = '') {
    const token = crypto.randomBytes(24).toString('hex');
    await createWebhook(userId, name, token, description);
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    return { token, url: `${baseUrl}/webhook/${token}` };
  }

  async function removeWebhook(userId, name) {
    return await removeWebhooks(userId, name);
  }

  async function listWebhooks(userId) {
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    const hooks = await listWebhooksByUser(userId);
    return hooks.map(h => ({ ...h, url: `${baseUrl}/webhook/${h.token}` }));
  }

  const server = app.listen(port, () => {
    console.log(`[webhook] Server listening on port ${port}`);
    const baseUrl = process.env.WEBHOOK_BASE_URL || '';
    if (baseUrl.startsWith('http://')) {
      console.warn('[webhook] WARNING: WEBHOOK_BASE_URL uses http:// (not https://). A reverse proxy with TLS is strongly recommended.');
    }
  });

  return { app, server, addWebhook, removeWebhook, listWebhooks };
}

module.exports = { startWebhookServer };
