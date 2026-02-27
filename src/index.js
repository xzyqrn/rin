'use strict';

require('dotenv').config();

const { initDb }             = require('./database');
const { initLlm }            = require('./llm');
const { createBot }          = require('./bot');
const { startPollers }       = require('./poller');
const { initCron }           = require('./capabilities/cron');
const { startWebhookServer } = require('./webhook');

// ── Env validation ─────────────────────────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('[error] TELEGRAM_BOT_TOKEN is not set.'); process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error('[error] OPENROUTER_API_KEY is not set.'); process.exit(1);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
const db = initDb();
console.log('[db] SQLite initialized.');

initLlm(db);

// Mutable ref so the webhook service can be injected after bot.launch()
const webhookRef = { current: null };
const bot = createBot(db, { webhookRef });

bot.launch().then(() => {
  console.log('[bot] Rin is online.');

  startPollers(db, bot.telegram);
  console.log('[poller] Reminder + health-check pollers started.');

  initCron(db, bot.telegram);

  if (process.env.ENABLE_WEBHOOKS !== 'false') {
    webhookRef.current = startWebhookServer(db, bot.telegram);
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.once('SIGINT',  () => { console.log('[bot] Shutting down…'); bot.stop('SIGINT');  db.close(); });
process.once('SIGTERM', () => { console.log('[bot] Shutting down…'); bot.stop('SIGTERM'); db.close(); });
