'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 3500;
const DEFAULT_TIMEOUT_MS = 30_000;

// Built-in regex deny patterns — harder to bypass than string matching.
// These block the most destructive commands regardless of SHELL_DENYLIST env.
const BUILTIN_DENY_PATTERNS = [
  /\brm\s+.*-[a-z]*r[a-z]*\s*\/\b/i,      // rm -rf / and variants (rm -r /, rm -Rf /, etc.)
  /\brm\s+.*--recursive.*\s*\/\b/i,        // rm --recursive / variants
  /\bmkfs\b/i,                              // format filesystems
  /\bdd\s+if=/i,                            // disk destroy
  /\bcrontab\s+-r\b/i,                      // wipe all cron jobs
  /\bshred\b.*\/dev\//i,                    // shred raw disk device
  /\bwipefs\b/i,                            // wipe filesystem signatures
  />\s*\/dev\/(sd[a-z]|nvme[0-9]|hd[a-z])\b/, // redirect into raw disk
];

const EXTRA_DENYLIST = (process.env.SHELL_DENYLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isDenied(command) {
  for (const pattern of BUILTIN_DENY_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  const lower = command.toLowerCase();
  for (const denied of EXTRA_DENYLIST) {
    if (lower.includes(denied.toLowerCase())) return true;
  }
  return false;
}

async function runCommand(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // Check deny patterns
  if (isDenied(command)) {
    console.warn('[shell] Blocked denied command:', command);
    return {
      success: false,
      exitCode: null,
      output: 'Command blocked by security policy.',
    };
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
