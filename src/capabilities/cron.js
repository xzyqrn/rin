'use strict';

const nodeCron = require('node-cron');
const { getAllEnabledCrons } = require('../database');

// Module-level state — initialised once via initCron()
let _db = null;
let _telegram = null;

// Map of cronJob.id → node-cron task
const _activeTasks = new Map();

function initCron(db, telegram) {
  _db = db;
  _telegram = telegram;
  loadAll();
}

function loadAll() {
  if (!_db) return;
  const jobs = getAllEnabledCrons(_db);
  let loaded = 0;
  for (const job of jobs) {
    if (_schedule(job)) loaded++;
  }
  console.log(`[cron] ${loaded} job(s) loaded.`);
}

function _schedule(job) {
  if (!nodeCron.validate(job.schedule)) {
    console.warn(`[cron] Invalid schedule for job "${job.name}": ${job.schedule}`);
    return false;
  }
  _stop(job.id); // replace if already running

  const { storageGet } = require('../database');
  const userTz = storageGet(_db, job.user_id, 'timezone');
  const tz = userTz || process.env.TIMEZONE || process.env.TZ || 'System Default';
  const cronTz = tz === 'System Default' ? undefined : tz;

  const task = nodeCron.schedule(job.schedule, () => _run(job), { timezone: cronTz });
  _activeTasks.set(job.id, task);
  return true;
}

function _stop(id) {
  const task = _activeTasks.get(id);
  if (task) { task.stop(); _activeTasks.delete(id); }
}

async function _run(job) {
  try {
    const payload = JSON.parse(job.payload);
    let text;

    if (job.action === 'message') {
      text = payload.message;
    } else if (job.action === 'command') {
      const { runCommand } = require('../shell');
      const result = await runCommand(payload.command);
      text = `[cron: ${job.name}]\n${result.output}`;
    } else if (job.action === 'health_check') {
      const { checkUrl } = require('./web');
      const result = await checkUrl(payload.url);
      if (result.ok) return; // only alert on failure
      text = `Alert [${job.name}]: ${payload.url} returned ${result.status || result.error}`;
    } else {
      return;
    }

    await _telegram.sendMessage(job.user_id, text);
  } catch (err) {
    console.error(`[cron] Job "${job.name}" failed:`, err.message);
  }
}

// Public API used by tools.js
function addJob(db, userId, name, schedule, action, payload) {
  if (!nodeCron.validate(schedule)) return { ok: false, error: `Invalid cron schedule: "${schedule}"` };
  const { addCronJob } = require('../database');
  const id = addCronJob(db, userId, name, schedule, action, payload);
  // Schedule immediately if cron is initialised
  if (_telegram) {
    const newJob = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
    if (newJob) _schedule(newJob);
  }
  return { ok: true, id };
}

function removeJob(db, userId, name) {
  const { listCronJobs, deleteCronJob } = require('../database');
  const jobs = listCronJobs(db, userId);
  const job = jobs.find((j) => j.name === name);
  if (!job) return false;
  _stop(job.id);
  return deleteCronJob(db, userId, name);
}

function getActiveCount() { return _activeTasks.size; }

module.exports = { initCron, addJob, removeJob, getActiveCount };
