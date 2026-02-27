'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 3500;
const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_DENYLIST = ['rm -rf /', 'mkfs', 'dd if='];
const SHELL_DENYLIST = (process.env.SHELL_DENYLIST || DEFAULT_DENYLIST.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

async function runCommand(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // Check denylist
  const lower = command.toLowerCase();
  for (const denied of SHELL_DENYLIST) {
    if (lower.includes(denied.toLowerCase())) {
      console.warn('[shell] Blocked denied command:', command);
      return {
        success: false,
        exitCode: null,
        output: 'Command blocked by security policy.',
      };
    }
  }

  console.log(`[shell] Executing: ${command}`);
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024, // 2 MB
      env: { ...process.env, TERM: 'dumb' },
    });

    const out = truncate(stdout.trim());
    const err = truncate(stderr.trim());

    return {
      success: true,
      exitCode: 0,
      output: formatOutput(out, err, 0),
    };
  } catch (e) {
    if (e.killed || e.signal) {
      return {
        success: false,
        exitCode: null,
        output: `Command timed out after ${timeoutMs / 1000}s`,
      };
    }

    const out = truncate((e.stdout || '').trim());
    const err = truncate((e.stderr || e.message || '').trim());

    return {
      success: false,
      exitCode: typeof e.code === 'number' ? e.code : null,
      output: formatOutput(out, err, e.code),
    };
  }
}

function truncate(str) {
  if (str.length <= MAX_OUTPUT_CHARS) return str;
  const cut = str.length - MAX_OUTPUT_CHARS;
  return str.slice(0, MAX_OUTPUT_CHARS) + `\n... [${cut} chars truncated]`;
}

function formatOutput(stdout, stderr, exitCode) {
  const parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`stderr: ${stderr}`);
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    parts.push(`exit code: ${exitCode}`);
  }
  return parts.join('\n') || '(no output)';
}

module.exports = { runCommand };
