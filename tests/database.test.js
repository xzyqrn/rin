const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Use a temporary DB for each test run
const TEST_DB_PATH = path.join('/tmp', `rin-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = TEST_DB_PATH;

// Must require after setting env
const {
  initDb, closeDb,
  saveMemory, getRecentMemories,
  upsertFact, getAllFacts,
  addReminder, getPendingReminders, deleteReminder, getDueReminders, deleteFiredReminder,
  upsertNote, getNotes, deleteNote,
  storageSet, storageGet, storageDelete, storageList,
  addCronJob, listCronJobs, deleteCronJob, getAllEnabledCrons,
  addHealthCheck, listHealthChecks, deleteHealthCheck, getHealthChecksToRun, updateHealthCheckStatus,
  logApiCall, getApiUsageSummary,
  checkAndIncrementRateLimit,
  saveGoogleTokens, getGoogleTokens,
  getWebhook, createWebhook, removeWebhooks, listWebhooksByUser,
  logAuditEvent, getAuditLog,
  logAgentGuardMetric, logGoogleToolMetric,
  cleanupOldRateLimits,
} = require('../src/database');

// Initialize DB before tests
const db = initDb();

test.after(() => {
  closeDb();
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

// ── Memory ──────────────────────────────────────────────────────────────

test('saveMemory and getRecentMemories roundtrip', async () => {
  const userId = '100';
  await saveMemory(db, userId, 'user: hello');
  await saveMemory(db, userId, 'rin: hi there');
  const memories = await getRecentMemories(db, userId, 10);
  assert.equal(memories.length, 2);
  assert.equal(memories[0].content, 'user: hello');
  assert.equal(memories[1].content, 'rin: hi there');
});

test('getRecentMemories limits results', async () => {
  const userId = '101';
  for (let i = 0; i < 5; i++) {
    await saveMemory(db, userId, `msg ${i}`);
  }
  const memories = await getRecentMemories(db, userId, 3);
  assert.equal(memories.length, 3);
  assert.equal(memories[0].content, 'msg 2');
  assert.equal(memories[2].content, 'msg 4');
});

// ── Facts ───────────────────────────────────────────────────────────────

test('upsertFact and getAllFacts roundtrip', async () => {
  const userId = '200';
  await upsertFact(db, userId, 'name', 'Alice');
  await upsertFact(db, userId, 'language', 'English');
  const facts = await getAllFacts(db, userId);
  assert.equal(facts.name, 'Alice');
  assert.equal(facts.language, 'English');
});

test('upsertFact overwrites existing key', async () => {
  const userId = '201';
  await upsertFact(db, userId, 'color', 'blue');
  await upsertFact(db, userId, 'color', 'red');
  const facts = await getAllFacts(db, userId);
  assert.equal(facts.color, 'red');
});

// ── Reminders ───────────────────────────────────────────────────────────

test('addReminder, getPendingReminders, deleteReminder', async () => {
  const userId = '300';
  const id = await addReminder(db, userId, 'test reminder', 9999999999);
  assert.ok(id);

  const pending = await getPendingReminders(db, userId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message, 'test reminder');

  const deleted = await deleteReminder(db, userId, id);
  assert.equal(deleted, true);

  const afterDelete = await getPendingReminders(db, userId);
  assert.equal(afterDelete.length, 0);
});

test('getDueReminders returns only past reminders', async () => {
  const userId = '301';
  await addReminder(db, userId, 'past', 1000);
  await addReminder(db, userId, 'future', 9999999999);

  const due = await getDueReminders(db);
  const userDue = due.filter(r => r.user_id === userId);
  assert.equal(userDue.length, 1);
  assert.equal(userDue[0].message, 'past');

  await deleteFiredReminder(db, userDue[0].id);
  const afterFire = await getDueReminders(db);
  const userDueAfter = afterFire.filter(r => r.user_id === userId);
  assert.equal(userDueAfter.length, 0);
});

// ── Notes ───────────────────────────────────────────────────────────────

test('upsertNote, getNotes, deleteNote', async () => {
  const userId = '400';
  await upsertNote(db, userId, 'Shopping List', 'eggs, milk');

  const notes = await getNotes(db, userId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Shopping List');
  assert.equal(notes[0].content, 'eggs, milk');

  const deleted = await deleteNote(db, userId, 'Shopping List');
  assert.equal(deleted, true);

  const afterDelete = await getNotes(db, userId);
  assert.equal(afterDelete.length, 0);
});

test('getNotes search filter', async () => {
  const userId = '401';
  await upsertNote(db, userId, 'Work', 'finish report');
  await upsertNote(db, userId, 'Home', 'clean kitchen');

  const results = await getNotes(db, userId, 'report');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Work');
});

// ── Storage ─────────────────────────────────────────────────────────────

test('storageSet, storageGet, storageDelete, storageList', async () => {
  const userId = '500';
  await storageSet(db, userId, 'timezone', 'America/New_York');
  const val = await storageGet(db, userId, 'timezone');
  assert.equal(val, 'America/New_York');

  await storageSet(db, userId, 'theme', 'dark');
  const list = await storageList(db, userId);
  assert.equal(list.length, 2);

  const deleted = await storageDelete(db, userId, 'theme');
  assert.equal(deleted, true);

  const afterDelete = await storageList(db, userId);
  assert.equal(afterDelete.length, 1);
});

test('storageGet returns null for missing key', async () => {
  const val = await storageGet(db, '599', 'nonexistent');
  assert.equal(val, null);
});

// ── Cron jobs ───────────────────────────────────────────────────────────

test('addCronJob, listCronJobs, deleteCronJob', async () => {
  const userId = '600';
  const id = await addCronJob(db, userId, 'daily-check', '0 9 * * *', 'message', { message: 'Good morning!' });
  assert.ok(id);

  const jobs = await listCronJobs(db, userId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'daily-check');
  assert.equal(jobs[0].schedule, '0 9 * * *');

  const deleted = await deleteCronJob(db, userId, 'daily-check');
  assert.equal(deleted, true);

  const afterDelete = await listCronJobs(db, userId);
  assert.equal(afterDelete.length, 0);
});

test('getAllEnabledCrons returns only enabled jobs', async () => {
  const userId = '601';
  await addCronJob(db, userId, 'active-job', '*/5 * * * *', 'message', { message: 'ping' });

  const all = await getAllEnabledCrons(db);
  const userJobs = all.filter(j => j.user_id === userId);
  assert.ok(userJobs.length >= 1);
  assert.equal(userJobs[0].enabled, 1);
});

// ── Health checks ───────────────────────────────────────────────────────

test('addHealthCheck, listHealthChecks, deleteHealthCheck', async () => {
  const userId = '700';
  await addHealthCheck(db, userId, 'my-api', 'https://api.example.com', 10);

  const checks = await listHealthChecks(db, userId);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'my-api');
  assert.equal(checks[0].interval_minutes, 10);

  const deleted = await deleteHealthCheck(db, userId, 'my-api');
  assert.equal(deleted, true);
});

test('getHealthChecksToRun and updateHealthCheckStatus', async () => {
  const userId = '701';
  await addHealthCheck(db, userId, 'check-1', 'https://example.com', 1);

  const toRun = await getHealthChecksToRun(db);
  const userChecks = toRun.filter(c => c.user_id === userId);
  assert.ok(userChecks.length >= 1);

  await updateHealthCheckStatus(db, userChecks[0].id, 200);

  // After updating, it shouldn't be due again immediately (1 min interval)
  const toRunAfter = await getHealthChecksToRun(db);
  const userChecksAfter = toRunAfter.filter(c => c.user_id === userId);
  assert.equal(userChecksAfter.length, 0);
});

// ── API metrics ─────────────────────────────────────────────────────────

test('logApiCall and getApiUsageSummary', async () => {
  await logApiCall(db, 'gemini-flash', 100, 50);
  await logApiCall(db, 'gemini-flash', 200, 100);
  await logApiCall(db, 'gpt-4', 300, 150);

  const summary = await getApiUsageSummary(db, 1);
  assert.ok(summary.length >= 2);

  const gemini = summary.find(s => s.model === 'gemini-flash');
  assert.ok(gemini);
  assert.equal(gemini.calls, 2);
  assert.equal(gemini.tokens_in, 300);
  assert.equal(gemini.tokens_out, 150);
});

// ── Rate limiting ───────────────────────────────────────────────────────

test('checkAndIncrementRateLimit enforces limits', async () => {
  const userId = '900';
  const allowed1 = await checkAndIncrementRateLimit(db, userId, 2);
  assert.equal(allowed1, true);

  const allowed2 = await checkAndIncrementRateLimit(db, userId, 2);
  assert.equal(allowed2, true);

  const allowed3 = await checkAndIncrementRateLimit(db, userId, 2);
  assert.equal(allowed3, false);
});

test('checkAndIncrementRateLimit allows unlimited when limit is 0', async () => {
  const result = await checkAndIncrementRateLimit(db, '901', 0);
  assert.equal(result, true);
});

// ── Google OAuth tokens ─────────────────────────────────────────────────

test('saveGoogleTokens and getGoogleTokens roundtrip', async () => {
  const userId = '1000';
  const saved = await saveGoogleTokens(db, userId, {
    access_token: 'at-123',
    refresh_token: 'rt-456',
    expiry_date: 1700000000000,
    scope: 'drive calendar',
    token_type: 'Bearer',
  });
  assert.equal(saved, true);

  const tokens = await getGoogleTokens(db, userId);
  assert.ok(tokens);
  assert.equal(tokens.access_token, 'at-123');
  assert.equal(tokens.refresh_token, 'rt-456');
  assert.equal(tokens.scope, 'drive calendar');
});

test('getGoogleTokens returns null for unknown user', async () => {
  const tokens = await getGoogleTokens(db, '9999');
  assert.equal(tokens, null);
});

test('saveGoogleTokens merges partial update', async () => {
  const userId = '1001';
  await saveGoogleTokens(db, userId, {
    access_token: 'at-old',
    refresh_token: 'rt-old',
  });

  await saveGoogleTokens(db, userId, {
    access_token: 'at-new',
  });

  const tokens = await getGoogleTokens(db, userId);
  assert.equal(tokens.access_token, 'at-new');
  assert.equal(tokens.refresh_token, 'rt-old');
});

// ── Webhooks ────────────────────────────────────────────────────────────

test('createWebhook, getWebhook, listWebhooksByUser, removeWebhooks', async () => {
  const userId = '1100';
  await createWebhook(userId, 'deploy-hook', 'tok-abc', 'deploy notifications');

  const hook = await getWebhook('tok-abc');
  assert.ok(hook);
  assert.equal(hook.name, 'deploy-hook');
  assert.equal(hook.user_id, userId);

  const list = await listWebhooksByUser(userId);
  assert.equal(list.length, 1);

  const removed = await removeWebhooks(userId, 'deploy-hook');
  assert.equal(removed, true);

  const afterRemove = await listWebhooksByUser(userId);
  assert.equal(afterRemove.length, 0);
});

// ── Audit log ───────────────────────────────────────────────────────────

test('logAuditEvent and getAuditLog', async () => {
  const userId = '1200';
  await logAuditEvent(userId, 'shell_command', 'ls -la');
  await logAuditEvent(userId, 'shell_command', 'cat /etc/hostname');

  const log = await getAuditLog(userId, 10);
  assert.equal(log.length, 2);
  // Both should be shell_command actions
  assert.ok(log.every(e => e.action === 'shell_command'));
  // Should contain both details
  const details = log.map(e => e.detail);
  assert.ok(details.includes('ls -la'));
  assert.ok(details.includes('cat /etc/hostname'));
});

// ── Metrics helpers ─────────────────────────────────────────────────────

test('logAgentGuardMetric does not throw', async () => {
  await logAgentGuardMetric('test_event', { foo: 'bar' });
  // Should not throw
});

test('logGoogleToolMetric does not throw', async () => {
  await logGoogleToolMetric('1300', 'gmail', 'send', 'success');
  // Should not throw
});

// ── Cleanup ─────────────────────────────────────────────────────────────

test('cleanupOldRateLimits does not throw', async () => {
  await cleanupOldRateLimits();
  // Should not throw
});
