'use strict';

const { getDueReminders, deleteFiredReminder,
  getHealthChecksToRun, updateHealthCheckStatus } = require('./database');
const { checkUrl } = require('./capabilities/web');

const REMINDER_INTERVAL_MS = 30_000;  // 30 s
const HEALTH_CHECK_INTERVAL_MS = 60_000;  // 60 s
const RATE_LIMIT_CLEANUP_MS = 86_400_000; // 24 h

/**
 * Start all background polling loops.
 * Returns a stop() function that clears all intervals.
 *
 * @param {object} db       - Firestore database instance
 * @param {object} telegram - Telegraf telegram instance
 */
function startPollers(db, telegram) {

  // ── Reminders ──────────────────────────────────────────────────────────────
  async function tickReminders() {
    const due = await getDueReminders(db);
    for (const r of due) {
      let sendOk = false;
      try {
        await telegram.sendMessage(r.user_id, `Reminder: ${r.message}`);
        sendOk = true;
      } catch (err) {
        console.error(`[poller] Reminder #${r.id} failed:`, err.message);
      } finally {
        if (sendOk) await deleteFiredReminder(db, r.id);
      }
    }
  }

  // ── Health checks ──────────────────────────────────────────────────────────
  async function tickHealthChecks() {
    const checks = await getHealthChecksToRun(db);
    for (const hc of checks) {
      try {
        const result = await checkUrl(hc.url);
        const wasDown = hc.last_status !== null && hc.last_status >= 400;
        const isDown = !result.ok;

        if (!wasDown && isDown) {
          const msg = `Alert [${hc.name}]: ${hc.url} is DOWN — ${result.status || result.error}`;
          await telegram.sendMessage(hc.user_id, msg).catch(() => { });
        } else if (wasDown && !isDown) {
          const msg = `Recovered [${hc.name}]: ${hc.url} is back up (HTTP ${result.status})`;
          await telegram.sendMessage(hc.user_id, msg).catch(() => { });
        }

        await updateHealthCheckStatus(db, hc.id, result.status ?? -1);
      } catch (err) {
        console.error(`[poller] Health check "${hc.name}":`, err.message);
      }
    }
  }

  // ── Rate limit cleanup ─────────────────────────────────────────────────────
  async function cleanupRateLimits() {
    if (!db) return;
    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) return;
      const cutoff = String(Math.floor(Date.now() / 3600000) * 3600 - 86400 * 7);
      for (const userDoc of usersSnapshot.docs) {
        const rateLimitsSnapshot = await userDoc.ref.collection('rate_limits').get();
        if (rateLimitsSnapshot.empty) continue;
        const batch = db.batch();
        let count = 0;
        rateLimitsSnapshot.docs.forEach((doc) => {
          if (doc.id < cutoff) {
            batch.delete(doc.ref);
            count++;
          }
        });
        if (count > 0) await batch.commit();
      }
    } catch (err) {
      console.error('[poller] Rate limit cleanup:', err.message);
    }
  }

  // Fire immediately on start to catch anything missed while offline
  tickReminders().catch((e) => console.error('[poller] Reminder init:', e));
  tickHealthChecks().catch((e) => console.error('[poller] Health init:', e));
  cleanupRateLimits().catch((e) => console.error('[poller] Rate limit cleanup init:', e));

  const t1 = setInterval(tickReminders, REMINDER_INTERVAL_MS);
  const t2 = setInterval(tickHealthChecks, HEALTH_CHECK_INTERVAL_MS);
  const t3 = setInterval(cleanupRateLimits, RATE_LIMIT_CLEANUP_MS);

  return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
}

// Backwards-compatible alias
function startReminderPoller(db, telegram) { return startPollers(db, telegram); }

module.exports = { startPollers, startReminderPoller };
