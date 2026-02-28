'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const exec = promisify(execFile);

async function getSystemHealth() {
  const lines = [];

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  lines.push(`Memory : ${fmtMB(usedMem)} / ${fmtMB(totalMem)} used (${pct(usedMem, totalMem)}%)`);

  // CPU
  const cpus = os.cpus();
  lines.push(`CPU    : ${cpus.length}x ${cpus[0]?.model?.trim() || 'unknown'}`);
  lines.push(`Load   : ${os.loadavg().map((l) => l.toFixed(2)).join(' / ')} (1/5/15 min)`);

  // Uptime
  lines.push(`Uptime : ${fmtUptime(os.uptime())}`);

  // Disk
  try {
    const { stdout } = await exec('df', ['-h', '/'], { timeout: 5000 });
    const row = stdout.trim().split('\n')[1]?.split(/\s+/);
    if (row) lines.push(`Disk   : ${row[2]} used / ${row[1]} total (${row[4]})`);
  } catch { /* df unavailable */ }

  return lines.join('\n');
}

async function getPm2Status() {
  try {
    const { stdout } = await exec('pm2', ['jlist'], { timeout: 10_000 });
    const procs = JSON.parse(stdout);
    if (procs.length === 0) return 'No PM2 processes.';
    return procs.map((p) => {
      const s = p.pm2_env.status;
      const cpu = p.monit?.cpu ?? '?';
      const mem = p.monit?.memory ? fmtMB(p.monit.memory) : '?';
      const rst = p.pm2_env.restart_time;
      return `[${p.name}] ${s} | CPU ${cpu}% | Mem ${mem} | Restarts: ${rst}`;
    }).join('\n');
  } catch (err) {
    return `PM2 unavailable: ${err.message}`;
  }
}

async function getApiUsage(db, days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { getApiUsageSummary } = require('../database');
  const rows = await getApiUsageSummary(db, days);
  if (rows.length === 0) return `No API calls recorded in the last ${days} days.`;
  return [`API usage — last ${days} days:`,
  ...rows.map((r) =>
    `  ${r.model}: ${r.calls} calls | in: ${r.tokens_in} | out: ${r.tokens_out} tokens`
  )
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMB(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function pct(a, b) { return Math.round((a / b) * 100); }
function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

module.exports = { getSystemHealth, getPm2Status, getApiUsage };
