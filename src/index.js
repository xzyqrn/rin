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

  bot.telegram.setMyCommands([
    { command: 'help', description: 'List available commands and capabilities' },
    { command: 'myfiles', description: 'List your uploaded files' },
    { command: 'cancel', description: 'Cancel an ongoing request' }
  ]).catch(err => console.error('[bot] Failed to set commands:', err));

  startPollers(db, bot.telegram);
  console.log('[poller] Reminder + health-check pollers started.');

  initCron(db, bot.telegram);

  if (process.env.ENABLE_WEBHOOKS !== 'false') {
    webhookRef.current = startWebhookServer(db, bot.telegram);
  }
}).catch((err) => {
  const is409 = err?.response?.error_code === 409 || /409|getUpdates|Conflict/i.test(err?.message || '');
  if (is409) {
    console.error('[bot] 409 Conflict: Another process is already polling for this bot. Stop the other instance (e.g. other terminal or PM2) and try again.');
  } else {
    console.error('[bot] Launch failed:', err.message || err);
  }
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.once('SIGINT',  () => { console.log('[bot] Shutting down…'); bot.stop('SIGINT');  db.close(); });
process.once('SIGTERM', () => { console.log('[bot] Shutting down…'); bot.stop('SIGTERM'); db.close(); });
