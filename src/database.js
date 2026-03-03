'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'rin.db');

let sqliteDB = null;

function _ensureDir(filePath) {
  const fs = require('fs');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_ts ON memory(user_id, timestamp);

    CREATE TABLE IF NOT EXISTS facts (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fire_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);

    CREATE TABLE IF NOT EXISTS notes (
      user_id TEXT NOT NULL,
      title_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, title_slug)
    );

    CREATE TABLE IF NOT EXISTS storage (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cron_user ON cron_jobs(user_id);

    CREATE TABLE IF NOT EXISTS health_checks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked INTEGER,
      last_status INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_health_user ON health_checks(user_id);

    CREATE TABLE IF NOT EXISTS api_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_ts ON api_metrics(timestamp);

    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, window_start)
    );

    CREATE TABLE IF NOT EXISTS google_auth (
      user_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      token_type TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);

    CREATE TABLE IF NOT EXISTS agent_guard_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS google_tool_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_category TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

function initDb() {
  if (sqliteDB) return sqliteDB;
  try {
    _ensureDir(DB_PATH);
    sqliteDB = new Database(DB_PATH);
    _initSchema(sqliteDB);
    console.log(`[db] SQLite initialized at ${DB_PATH}`);
    return sqliteDB;
  } catch (error) {
    console.error('[db] Failed to initialize SQLite:', error.message);
    return null;
  }
}

// ── Conversation memory ────────────────────────────────────────────────────────

async function saveMemory(db, userId, content) {
  if (!sqliteDB) return;
  const stmt = sqliteDB.prepare('INSERT INTO memory (user_id, content, timestamp) VALUES (?, ?, ?)');
  stmt.run(String(userId), content, Math.floor(Date.now() / 1000));
}

async function getRecentMemories(db, userId, limit) {
  if (!sqliteDB) return [];
  const count = limit || parseInt(process.env.MEMORY_TURNS || '20', 10);
  const stmt = sqliteDB.prepare(
    'SELECT content FROM memory WHERE user_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?'
  );
  const rows = stmt.all(String(userId), count);
  return rows.reverse().map(r => ({ content: r.content }));
}

// ── User facts ─────────────────────────────────────────────────────────────────

async function upsertFact(db, userId, key, value) {
  if (!sqliteDB) return;
  const factKey = key.trim().toLowerCase();
  const stmt = sqliteDB.prepare(
    'INSERT INTO facts (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
  );
  stmt.run(String(userId), factKey, String(value).trim());
}

async function getAllFacts(db, userId) {
  if (!sqliteDB) return {};
  const stmt = sqliteDB.prepare('SELECT key, value FROM facts WHERE user_id = ?');
  const rows = stmt.all(String(userId));
  const facts = {};
  for (const row of rows) facts[row.key] = row.value;
  return facts;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

async function addReminder(db, userId, message, fireAt) {
  if (!sqliteDB) return 0;
  const stmt = sqliteDB.prepare(
    'INSERT INTO reminders (user_id, message, fire_at, created_at) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(String(userId), message, fireAt, Math.floor(Date.now() / 1000));
  return String(info.lastInsertRowid);
}

async function getPendingReminders(db, userId) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare(
    'SELECT id, user_id, message, fire_at, created_at FROM reminders WHERE user_id = ? ORDER BY fire_at ASC'
  );
  return stmt.all(String(userId)).map(r => ({ ...r, id: String(r.id) }));
}

async function deleteReminder(db, userId, id) {
  if (!sqliteDB) return false;
  const stmt = sqliteDB.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');
  const info = stmt.run(String(id), String(userId));
  return info.changes > 0;
}

async function getDueReminders(db) {
  if (!sqliteDB) return [];
  const now = Math.floor(Date.now() / 1000);
  const stmt = sqliteDB.prepare(
    'SELECT id, user_id, message, fire_at, created_at FROM reminders WHERE fire_at <= ? ORDER BY fire_at ASC'
  );
  return stmt.all(now).map(r => ({ ...r, id: String(r.id), userId: r.user_id }));
}

async function deleteFiredReminder(db, id) {
  if (!sqliteDB) return;
  sqliteDB.prepare('DELETE FROM reminders WHERE id = ?').run(String(id));
}

// ── Notes ─────────────────────────────────────────────────────────────────────

async function upsertNote(db, userId, title, content) {
  if (!sqliteDB) return;
  const titleSlug = Buffer.from(title).toString('base64');
  const stmt = sqliteDB.prepare(
    `INSERT INTO notes (user_id, title_slug, title, content, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, title_slug) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at`
  );
  stmt.run(String(userId), titleSlug, title, content, Math.floor(Date.now() / 1000));
}

async function getNotes(db, userId, search = null) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare(
    'SELECT title_slug AS id, title, content, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC'
  );
  const rows = stmt.all(String(userId));
  if (!search) return rows;
  const lower = search.toLowerCase();
  return rows.filter(r => r.title.toLowerCase().includes(lower) || r.content.toLowerCase().includes(lower));
}

async function deleteNote(db, userId, title) {
  if (!sqliteDB) return false;
  const titleSlug = Buffer.from(title).toString('base64');
  const stmt = sqliteDB.prepare('DELETE FROM notes WHERE user_id = ? AND title_slug = ?');
  const info = stmt.run(String(userId), titleSlug);
  return info.changes > 0;
}

// ── Local storage ─────────────────────────────────────────────────────────────

async function storageSet(db, userId, key, value) {
  if (!sqliteDB) return;
  const stmt = sqliteDB.prepare(
    `INSERT INTO storage (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  stmt.run(String(userId), key, String(value), Math.floor(Date.now() / 1000));
}

async function storageGet(db, userId, key) {
  if (!sqliteDB) return null;
  const stmt = sqliteDB.prepare('SELECT value FROM storage WHERE user_id = ? AND key = ?');
  const row = stmt.get(String(userId), key);
  return row ? row.value : null;
}

async function storageDelete(db, userId, key) {
  if (!sqliteDB) return false;
  const stmt = sqliteDB.prepare('DELETE FROM storage WHERE user_id = ? AND key = ?');
  const info = stmt.run(String(userId), key);
  return info.changes > 0;
}

async function storageList(db, userId) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare('SELECT key, value FROM storage WHERE user_id = ? ORDER BY key ASC');
  return stmt.all(String(userId));
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

async function addCronJob(db, userId, name, schedule, action, payload) {
  if (!sqliteDB) return null;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const stmt = sqliteDB.prepare(
    `INSERT INTO cron_jobs (id, user_id, name, schedule, action, payload, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, schedule = excluded.schedule, action = excluded.action, payload = excluded.payload, enabled = excluded.enabled, created_at = excluded.created_at`
  );
  stmt.run(idStr, String(userId), name, schedule, action, JSON.stringify(payload), Math.floor(Date.now() / 1000));
  return idStr;
}

async function listCronJobs(db, userId) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare('SELECT * FROM cron_jobs WHERE user_id = ?');
  return stmt.all(String(userId));
}

async function deleteCronJob(db, userId, name) {
  if (!sqliteDB) return false;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const stmt = sqliteDB.prepare('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?');
  const info = stmt.run(idStr, String(userId));
  return info.changes > 0;
}

async function getAllEnabledCrons(db) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare('SELECT * FROM cron_jobs WHERE enabled = 1');
  return stmt.all();
}

// ── Health checks ─────────────────────────────────────────────────────────────

async function addHealthCheck(db, userId, name, url, intervalMinutes = 5) {
  if (!sqliteDB) return;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const stmt = sqliteDB.prepare(
    `INSERT INTO health_checks (id, user_id, name, url, interval_minutes, enabled) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, interval_minutes = excluded.interval_minutes, enabled = excluded.enabled`
  );
  stmt.run(idStr, String(userId), name, url, intervalMinutes);
}

async function listHealthChecks(db, userId) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare('SELECT * FROM health_checks WHERE user_id = ?');
  return stmt.all(String(userId));
}

async function deleteHealthCheck(db, userId, name) {
  if (!sqliteDB) return false;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const stmt = sqliteDB.prepare('DELETE FROM health_checks WHERE id = ? AND user_id = ?');
  const info = stmt.run(idStr, String(userId));
  return info.changes > 0;
}

async function getHealthChecksToRun(db) {
  if (!sqliteDB) return [];
  const now = Math.floor(Date.now() / 1000);
  const stmt = sqliteDB.prepare(
    'SELECT * FROM health_checks WHERE enabled = 1 AND (last_checked IS NULL OR last_checked + interval_minutes * 60 <= ?)'
  );
  return stmt.all(now);
}

async function updateHealthCheckStatus(db, id, status) {
  if (!sqliteDB) return;
  const stmt = sqliteDB.prepare(
    'UPDATE health_checks SET last_checked = ?, last_status = ? WHERE id = ?'
  );
  stmt.run(Math.floor(Date.now() / 1000), status, String(id));
}

// ── API metrics ────────────────────────────────────────────────────────────────

async function logApiCall(db, model, tokensIn, tokensOut) {
  if (!sqliteDB) return;
  const stmt = sqliteDB.prepare(
    'INSERT INTO api_metrics (model, tokens_in, tokens_out, timestamp) VALUES (?, ?, ?, ?)'
  );
  stmt.run(model, tokensIn || 0, tokensOut || 0, Math.floor(Date.now() / 1000));
}

async function getApiUsageSummary(db, days = 7) {
  if (!sqliteDB) return [];
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const stmt = sqliteDB.prepare(
    `SELECT model, COUNT(*) as calls, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out
     FROM api_metrics WHERE timestamp >= ? GROUP BY model`
  );
  return stmt.all(since);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkAndIncrementRateLimit(db, userId, limitPerHour) {
  if (!sqliteDB) return true; // Fail open if no DB
  if (limitPerHour === 0) return true; // Unlimited

  const windowStart = String(Math.floor(Date.now() / 3600000) * 3600);

  try {
    const result = sqliteDB.transaction(() => {
      const row = sqliteDB.prepare(
        'SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?'
      ).get(String(userId), windowStart);

      if (!row) {
        sqliteDB.prepare(
          'INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1)'
        ).run(String(userId), windowStart);
        return true;
      }
      if (row.count < limitPerHour) {
        sqliteDB.prepare(
          'UPDATE rate_limits SET count = count + 1 WHERE user_id = ? AND window_start = ?'
        ).run(String(userId), windowStart);
        return true;
      }
      return false;
    })();
    return result;
  } catch (e) {
    console.error('[db] Rate limit transaction failed', e);
    return true; // Fail open
  }
}

// ── Google OAuth Tokens ─────────────────────────────────────────────────────────

async function saveGoogleTokens(db, userId, tokens) {
  if (!sqliteDB) {
    console.error(`[db] SQLite not initialized - cannot save tokens for user ${userId}`);
    return false;
  }

  try {
    const existing = sqliteDB.prepare('SELECT user_id FROM google_auth WHERE user_id = ?').get(String(userId));

    if (existing) {
      const sets = ['updated_at = ?'];
      const values = [Math.floor(Date.now() / 1000)];
      if (tokens.access_token) { sets.push('access_token = ?'); values.push(tokens.access_token); }
      if (typeof tokens.expiry_date === 'number') { sets.push('expiry_date = ?'); values.push(tokens.expiry_date); }
      if (tokens.refresh_token) { sets.push('refresh_token = ?'); values.push(tokens.refresh_token); }
      if (tokens.scope) { sets.push('scope = ?'); values.push(String(tokens.scope)); }
      if (tokens.token_type) { sets.push('token_type = ?'); values.push(String(tokens.token_type)); }
      values.push(String(userId));
      sqliteDB.prepare(`UPDATE google_auth SET ${sets.join(', ')} WHERE user_id = ?`).run(...values);
    } else {
      sqliteDB.prepare(
        `INSERT INTO google_auth (user_id, access_token, refresh_token, expiry_date, scope, token_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(userId),
        tokens.access_token || null,
        tokens.refresh_token || null,
        typeof tokens.expiry_date === 'number' ? tokens.expiry_date : null,
        tokens.scope ? String(tokens.scope) : null,
        tokens.token_type ? String(tokens.token_type) : null,
        Math.floor(Date.now() / 1000)
      );
    }
    return true;
  } catch (error) {
    console.error(`[db] Error saving tokens for user ${userId}:`, error);
    return false;
  }
}

async function getGoogleTokens(db, userId) {
  if (!sqliteDB) {
    console.error(`[db] SQLite not initialized - cannot get tokens for user ${userId}`);
    return null;
  }

  try {
    const row = sqliteDB.prepare('SELECT * FROM google_auth WHERE user_id = ?').get(String(userId));
    if (!row) return null;
    if (!row.access_token && !row.refresh_token) return null;
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: row.expiry_date,
      scope: row.scope,
      token_type: row.token_type,
    };
  } catch (error) {
    console.error(`[db] Error getting tokens for user ${userId}:`, error);
    return null;
  }
}

// ── Webhooks (used by webhook.js) ──────────────────────────────────────────────

async function getWebhook(token) {
  if (!sqliteDB) return null;
  return sqliteDB.prepare('SELECT * FROM webhooks WHERE token = ?').get(token) || null;
}

async function createWebhook(userId, name, token, description = '') {
  if (!sqliteDB) return;
  sqliteDB.prepare(
    'INSERT INTO webhooks (token, user_id, name, description, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(token, String(userId), name, description, Math.floor(Date.now() / 1000));
}

async function removeWebhooks(userId, name) {
  if (!sqliteDB) return false;
  const info = sqliteDB.prepare('DELETE FROM webhooks WHERE user_id = ? AND name = ?').run(String(userId), name);
  return info.changes > 0;
}

async function listWebhooksByUser(userId) {
  if (!sqliteDB) return [];
  return sqliteDB.prepare('SELECT * FROM webhooks WHERE user_id = ? AND enabled = 1').all(String(userId));
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function logAuditEvent(userId, action, detail = '') {
  if (!sqliteDB) return;
  sqliteDB.prepare(
    'INSERT INTO audit_log (user_id, action, detail, timestamp) VALUES (?, ?, ?, ?)'
  ).run(String(userId), action, detail, Math.floor(Date.now() / 1000));
}

async function getAuditLog(userId, limit = 50) {
  if (!sqliteDB) return [];
  const stmt = sqliteDB.prepare(
    'SELECT * FROM audit_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?'
  );
  return stmt.all(String(userId), limit);
}

// ── Metrics insert helpers (used by llm.js and tools.js instead of raw db.collection) ──

async function logAgentGuardMetric(eventType, payload = {}) {
  if (!sqliteDB) return;
  try {
    sqliteDB.prepare(
      'INSERT INTO agent_guard_metrics (event_type, payload, created_at) VALUES (?, ?, ?)'
    ).run(eventType, JSON.stringify(payload), Math.floor(Date.now() / 1000));
  } catch { /* best-effort */ }
}

async function logGoogleToolMetric(userId, service, action, status, errorCategory = '') {
  if (!sqliteDB) return;
  try {
    sqliteDB.prepare(
      'INSERT INTO google_tool_metrics (user_id, service, action, status, error_category, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(String(userId), service, action, status, errorCategory || null, Math.floor(Date.now() / 1000));
  } catch { /* best-effort */ }
}

// ── Rate limit cleanup ───────────────────────────────────────────────────────

async function cleanupOldRateLimits() {
  if (!sqliteDB) return;
  const cutoff = String(Math.floor(Date.now() / 1000) - 86400 * 7);
  sqliteDB.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(cutoff);
}

// ── Close database ───────────────────────────────────────────────────────────

function closeDb() {
  if (sqliteDB) {
    sqliteDB.close();
    sqliteDB = null;
  }
}

module.exports = {
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
};
