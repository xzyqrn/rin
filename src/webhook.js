'use strict';

const express = require('express');
const crypto = require('crypto');

/**
 * Start an Express HTTP server for incoming webhooks.
 * Webhooks are registered in the DB as (user_id, name, token, description).
 * Any POST to /webhook/:token delivers the request body as a Telegram message.
 *
 * @param {object} db       - Firestore database instance
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

function startWebhookServer(db, telegram) {
  const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ limit: '1mb' }));

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Google OAuth Auth URL
  app.get('/auth/google', (req, res) => {
    const { state } = req.query; // Expect userId to be passed here
    if (!state) return res.status(400).send('Missing user state');
    try {
      const { getAuthUrl } = require('./capabilities/google');
      const url = getAuthUrl(state);
      res.redirect(url);
    } catch (e) {
      res.status(500).send(`Setup incomplete: ${e.message}`);
    }
  });

  // Google OAuth Callback
  app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Auth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    try {
      const { handleCallback } = require('./capabilities/google');
      await handleCallback(db, code, parseInt(state, 10));

      // Notify the user via Telegram
      await telegram.sendMessage(parseInt(state, 10), '✅ Google Account successfully linked! You can now use Google tools.');
      res.send('Authorization successful. You can close this window and return to Telegram.');
    } catch (err) {
      console.error('[webhook] Error in google callback:', err);
      res.status(500).send('Internal Server Error during authorization.');
    }
  });

  // Incoming webhook
  app.post('/webhook/:token', async (req, res) => {
    const { token } = req.params;

    if (!_checkWebhookRateLimit(token)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Max 60 requests/minute per webhook.' });
    }

    const doc = await db.collection('webhooks').doc(token).get();
    if (!doc.exists || doc.data().enabled !== 1) return res.status(404).json({ error: 'Unknown webhook' });
    const hook = doc.data();

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

  async function addWebhook(userId, name, description = '') {
    const token = crypto.randomBytes(24).toString('hex');
    await db.collection('webhooks').doc(token).set({
      user_id: userId,
      name,
      token,
      description,
      enabled: 1,
      created_at: Math.floor(Date.now() / 1000)
    });
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    return { token, url: `${baseUrl}/webhook/${token}` };
  }

  async function removeWebhook(userId, name) {
    const snapshot = await db.collection('webhooks')
      .where('user_id', '==', userId)
      .where('name', '==', name)
      .get();

    if (snapshot.empty) return false;

    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return true;
  }

  async function listWebhooks(userId) {
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://YOUR_VPS_IP:${port}`;
    const snapshot = await db.collection('webhooks')
      .where('user_id', '==', userId)
      .where('enabled', '==', 1)
      .get();

    const webhooks = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      webhooks.push({ ...data, url: `${baseUrl}/webhook/${data.token}` });
    });
    return webhooks;
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
