'use strict';

const { getDueReminders, deleteFiredReminder,
        getHealthChecksToRun, updateHealthCheckStatus } = require('./database');
const { checkUrl } = require('./capabilities/web');

const REMINDER_INTERVAL_MS     = 30_000;  // 30 s
const HEALTH_CHECK_INTERVAL_MS = 60_000;  // 60 s

/**
 * Start all background polling loops.
 * Returns a stop() function that clears all intervals.
 *
 * @param {object} db       - better-sqlite3 instance
 * @param {object} telegram - Telegraf telegram instance
 */
function startPollers(db, telegram) {

  // ── Reminders ──────────────────────────────────────────────────────────────
  async function tickReminders() {
    const due = getDueReminders(db);
    for (const r of due) {
      try {
        await telegram.sendMessage(r.user_id, `Reminder: ${r.message}`);
      } catch (err) {
        console.error(`[poller] Reminder #${r.id} failed:`, err.message);
      } finally {
        deleteFiredReminder(db, r.id);
      }
    }
  }

  // ── Health checks ──────────────────────────────────────────────────────────
  async function tickHealthChecks() {
    const checks = getHealthChecksToRun(db);
    for (const hc of checks) {
      try {
        const result  = await checkUrl(hc.url);
        const wasDown = hc.last_status !== null && hc.last_status >= 400;
        const isDown  = !result.ok;

        if (!wasDown && isDown) {
          const msg = `Alert [${hc.name}]: ${hc.url} is DOWN — ${result.status || result.error}`;
          await telegram.sendMessage(hc.user_id, msg).catch(() => {});
        } else if (wasDown && !isDown) {
          const msg = `Recovered [${hc.name}]: ${hc.url} is back up (HTTP ${result.status})`;
          await telegram.sendMessage(hc.user_id, msg).catch(() => {});
        }

        updateHealthCheckStatus(db, hc.id, result.status ?? -1);
      } catch (err) {
        console.error(`[poller] Health check "${hc.name}":`, err.message);
      }
    }
  }

  // Fire immediately on start to catch anything missed while offline
  tickReminders().catch((e)    => console.error('[poller] Reminder init:', e.message));
  tickHealthChecks().catch((e) => console.error('[poller] Health init:', e.message));

  const t1 = setInterval(tickReminders,    REMINDER_INTERVAL_MS);
  const t2 = setInterval(tickHealthChecks, HEALTH_CHECK_INTERVAL_MS);

  return () => { clearInterval(t1); clearInterval(t2); };
}

// Backwards-compatible alias
function startReminderPoller(db, telegram) { return startPollers(db, telegram); }

module.exports = { startPollers, startReminderPoller };
