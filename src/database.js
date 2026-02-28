'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'rin.db');

function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);

  _createTables(db);
  _runMigrations(db);

  return db;
}

// ── Table Creation ─────────────────────────────────────────────────────────
function _createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL DEFAULT 0,
      content   TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memory (user_id, id DESC);

    CREATE TABLE IF NOT EXISTS user_facts (
      user_id INTEGER NOT NULL DEFAULT 0,
      key     TEXT NOT NULL,
      value   TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      message    TEXT NOT NULL,
      fire_at    INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders (fire_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user_fire ON reminders (user_id, fire_at ASC);

    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, title)
    );
    CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS storage (
      user_id    INTEGER NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      schedule   TEXT NOT NULL,
      action     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS health_checks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      name             TEXT NOT NULL,
      url              TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 5,
      last_checked     INTEGER,
      last_status      INTEGER,
      enabled          INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS api_metrics (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      model      TEXT NOT NULL,
      tokens_in  INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_metrics_timestamp ON api_metrics (timestamp, model);

    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id      INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, window_start)
    );
  `);
}

// ── Migrations ─────────────────────────────────────────────────────────────
function _runMigrations(db) {
  const memCols = db.prepare('PRAGMA table_info(memory)').all().map((c) => c.name);
  if (!memCols.includes('user_id')) {
    db.exec('ALTER TABLE memory ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memory_user ON memory (user_id)');
  }

  const factCols = db.prepare('PRAGMA table_info(user_facts)').all().map((c) => c.name);
  if (!factCols.includes('user_id')) {
    db.exec('DROP TABLE IF EXISTS user_facts');
    db.exec('CREATE TABLE user_facts (user_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))');
  }

  // ── Performance Indexes Migration ───────────────────────────────────────────
  db.exec('DROP INDEX IF EXISTS idx_memory_user');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memory (user_id, id DESC)');

  db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_user_fire ON reminders (user_id, fire_at ASC)');

  db.exec('DROP INDEX IF EXISTS idx_notes_user');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes (user_id, updated_at DESC)');

  db.exec('CREATE INDEX IF NOT EXISTS idx_api_metrics_timestamp ON api_metrics (timestamp, model)');
}

// ── Conversation memory ────────────────────────────────────────────────────────

function saveMemory(db, userId, content) {
  db.prepare('INSERT INTO memory (user_id, content) VALUES (?, ?)').run(userId, content);
}

function getRecentMemories(db, userId, limit) {
  const count = limit || parseInt(process.env.MEMORY_TURNS || '20', 10);
  return db
    .prepare('SELECT content FROM memory WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, count)
    .reverse();
}

// ── User facts ─────────────────────────────────────────────────────────────────

function upsertFact(db, userId, key, value) {
  db.prepare('INSERT OR REPLACE INTO user_facts (user_id, key, value) VALUES (?, ?, ?)')
    .run(userId, key.trim().toLowerCase(), String(value).trim());
}

function getAllFacts(db, userId) {
  return db.prepare('SELECT key, value FROM user_facts WHERE user_id = ?').all(userId)
    .reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
}

// ── Reminders ─────────────────────────────────────────────────────────────────

function addReminder(db, userId, message, fireAt) {
  return db.prepare('INSERT INTO reminders (user_id, message, fire_at) VALUES (?, ?, ?)')
    .run(userId, message, fireAt).lastInsertRowid;
}

function getPendingReminders(db, userId) {
  return db.prepare('SELECT id, message, fire_at FROM reminders WHERE user_id = ? ORDER BY fire_at ASC')
    .all(userId);
}

function deleteReminder(db, userId, id) {
  return db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?')
    .run(id, userId).changes > 0;
}

function getDueReminders(db) {
  return db.prepare('SELECT * FROM reminders WHERE fire_at <= ? ORDER BY fire_at ASC')
    .all(Math.floor(Date.now() / 1000));
}

function deleteFiredReminder(db, id) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

// ── Notes ─────────────────────────────────────────────────────────────────────

function upsertNote(db, userId, title, content) {
  db.prepare(`
    INSERT INTO notes (user_id, title, content)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, title) DO UPDATE SET
      content = excluded.content, updated_at = strftime('%s', 'now')
  `).run(userId, title, content);
}

function getNotes(db, userId, search = null) {
  if (search) {
    const q = `%${search}%`;
    return db.prepare('SELECT id, title, content FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC')
      .all(userId, q, q);
  }
  return db.prepare('SELECT id, title, content FROM notes WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId);
}

function deleteNote(db, userId, title) {
  return db.prepare('DELETE FROM notes WHERE user_id = ? AND title = ?')
    .run(userId, title).changes > 0;
}

// ── Local storage ─────────────────────────────────────────────────────────────

function storageSet(db, userId, key, value) {
  db.prepare(`
    INSERT INTO storage (user_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')
  `).run(userId, key, String(value));
}

function storageGet(db, userId, key) {
  return db.prepare('SELECT value FROM storage WHERE user_id = ? AND key = ?').get(userId, key)?.value ?? null;
}

function storageDelete(db, userId, key) {
  return db.prepare('DELETE FROM storage WHERE user_id = ? AND key = ?').run(userId, key).changes > 0;
}

function storageList(db, userId) {
  return db.prepare('SELECT key, value FROM storage WHERE user_id = ? ORDER BY key').all(userId);
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

function addCronJob(db, userId, name, schedule, action, payload) {
  return db.prepare(`
    INSERT INTO cron_jobs (user_id, name, schedule, action, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      schedule = excluded.schedule,
      action   = excluded.action,
      payload  = excluded.payload,
      enabled  = 1
  `).run(userId, name, schedule, action, JSON.stringify(payload)).lastInsertRowid;
}

function listCronJobs(db, userId) {
  return db.prepare('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY id').all(userId);
}

function deleteCronJob(db, userId, name) {
  return db.prepare('DELETE FROM cron_jobs WHERE user_id = ? AND name = ?').run(userId, name).changes > 0;
}

function getAllEnabledCrons(db) {
  return db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1').all();
}

// ── Health checks ─────────────────────────────────────────────────────────────

function addHealthCheck(db, userId, name, url, intervalMinutes = 5) {
  db.prepare(`
    INSERT INTO health_checks (user_id, name, url, interval_minutes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      url = excluded.url, interval_minutes = excluded.interval_minutes, enabled = 1
  `).run(userId, name, url, intervalMinutes);
}

function listHealthChecks(db, userId) {
  return db.prepare('SELECT * FROM health_checks WHERE user_id = ? ORDER BY id').all(userId);
}

function deleteHealthCheck(db, userId, name) {
  return db.prepare('DELETE FROM health_checks WHERE user_id = ? AND name = ?').run(userId, name).changes > 0;
}

function getHealthChecksToRun(db) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT * FROM health_checks WHERE enabled = 1
    AND (last_checked IS NULL OR last_checked + interval_minutes * 60 <= ?)
  `).all(now);
}

function updateHealthCheckStatus(db, id, status) {
  db.prepare('UPDATE health_checks SET last_checked = ?, last_status = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), status, id);
}

// ── API metrics ────────────────────────────────────────────────────────────────

function logApiCall(db, model, tokensIn, tokensOut) {
  db.prepare('INSERT INTO api_metrics (model, tokens_in, tokens_out) VALUES (?, ?, ?)')
    .run(model, tokensIn || 0, tokensOut || 0);
}

function getApiUsageSummary(db, days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare(`
    SELECT model,
           COUNT(*) as calls,
           SUM(tokens_in) as tokens_in,
           SUM(tokens_out) as tokens_out
    FROM api_metrics WHERE timestamp >= ?
    GROUP BY model
  `).all(since);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function checkAndIncrementRateLimit(db, userId, limitPerHour) {
  const windowStart = Math.floor(Date.now() / 3600000) * 3600;
  const row = db.prepare('SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?')
    .get(userId, windowStart);
  if (row && row.count >= limitPerHour) return false;
  db.prepare(`
    INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(user_id, window_start) DO UPDATE SET count = count + 1
  `).run(userId, windowStart);
  return true;
}

module.exports = {
  initDb,
  saveMemory, getRecentMemories,
  upsertFact, getAllFacts,
  addReminder, getPendingReminders, deleteReminder, getDueReminders, deleteFiredReminder,
  upsertNote, getNotes, deleteNote,
  storageSet, storageGet, storageDelete, storageList,
  addCronJob, listCronJobs, deleteCronJob, getAllEnabledCrons,
  addHealthCheck, listHealthChecks, deleteHealthCheck, getHealthChecksToRun, updateHealthCheckStatus,
  logApiCall, getApiUsageSummary,
  checkAndIncrementRateLimit,
};
