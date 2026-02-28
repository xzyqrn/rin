'use strict';

const path = require('path');
const fs = require('fs');
const { runCommand } = require('./shell');
const { browseUrl } = require('./capabilities/web');
const { readFile, writeFile, listDirectory,
  deleteFile, convertFile } = require('./capabilities/files');
const { addJob, removeJob } = require('./capabilities/cron');
const { getSystemHealth, getPm2Status,
  getApiUsage } = require('./capabilities/monitoring');
const { set: storeSet, get: storeGet,
  del: storeDel, list: storeList } = require('./capabilities/storage');
const { sendTelegramFile,
  UPLOADS_DIR } = require('./capabilities/uploads');
const {
  addReminder, getPendingReminders, deleteReminder,
  upsertNote, getNotes, deleteNote,
  listCronJobs, addHealthCheck, listHealthChecks, deleteHealthCheck,
} = require('./database');

// ─────────────────────────────────────────────────────────────────────────────
// Tool schema definitions
// ─────────────────────────────────────────────────────────────────────────────

const DEF = {

  // ── Available to ALL users ─────────────────────────────────────────────────

  browse_url: {
    type: 'function',
    function: {
      name: 'browse_url',
      description: 'Fetch a web page and return its readable text content. Use to read articles, docs, or any public URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch (https://...)' },
        },
        required: ['url'],
      },
    },
  },

  set_reminder: {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Schedule a reminder. Provide delay_minutes (e.g. 30) OR datetime (ISO 8601). Not both.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to remind the user about' },
          delay_minutes: { type: 'number', description: 'Minutes from now' },
          datetime: { type: 'string', description: 'Absolute time, e.g. "2026-03-01T15:00:00"' },
        },
        required: ['message'],
      },
    },
  },

  list_reminders: {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List all pending reminders.',
      parameters: { type: 'object', properties: {} },
    },
  },

  delete_reminder: {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Cancel a reminder by its ID.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },

  save_note: {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save or overwrite a note by title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
  },

  get_notes: {
    type: 'function',
    function: {
      name: 'get_notes',
      description: 'Retrieve notes, optionally filtering by keyword.',
      parameters: {
        type: 'object',
        properties: { search: { type: 'string' } },
      },
    },
  },

  delete_note: {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Delete a note by its exact title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },

  storage_set: {
    type: 'function',
    function: {
      name: 'storage_set',
      description: 'Persist a key-value pair in local storage. Good for settings, counters, flags.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
  },

  storage_get: {
    type: 'function',
    function: {
      name: 'storage_get',
      description: 'Retrieve a value from local storage by key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
  },

  storage_delete: {
    type: 'function',
    function: {
      name: 'storage_delete',
      description: 'Remove a key from local storage.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
  },

  storage_list: {
    type: 'function',
    function: {
      name: 'storage_list',
      description: 'List all keys and values in local storage.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ── Meta-cognitive (available to ALL users) ────────────────────────────────

  think: {
    type: 'function',
    function: {
      name: 'think',
      description:
        'Private reasoning scratchpad. Use this to think through a complex or ambiguous request ' +
        'BEFORE acting. Write your current understanding, any unknowns, and your intended next step. ' +
        'The user does NOT see this — it is only for your own reasoning. ' +
        'Do not use this for simple or clearly-defined requests.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string', description: 'Your step-by-step internal reasoning' },
        },
        required: ['reasoning'],
      },
    },
  },

  plan: {
    type: 'function',
    function: {
      name: 'plan',
      description:
        'Decompose a multi-step goal into an ordered list of concrete actions. ' +
        'Call this when the user wants something that requires more than one distinct tool call. ' +
        'Return the plan, then execute each step using the appropriate tools.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the user ultimately wants to achieve' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of concrete actions to take, each referencing a specific tool or action',
          },
        },
        required: ['goal', 'steps'],
      },
    },
  },

  reflect: {
    type: 'function',
    function: {
      name: 'reflect',
      description:
        'Review your most recent answer and decide if it fully satisfies the user\'s request. ' +
        'Use after completing a complex or multi-step task. ' +
        'If the answer is incomplete or could be improved, provide a revised_answer. ' +
        'If the answer is already good, set revised_answer to null.',
      parameters: {
        type: 'object',
        properties: {
          critique: { type: 'string', description: 'A brief evaluation of the answer\'s completeness and accuracy' },
          revised_answer: {
            type: 'string',
            description: 'An improved version of the answer, or null if no revision is needed',
          },
        },
        required: ['critique'],
      },
    },
  },

  // ── Admin only ─────────────────────────────────────────────────────────────

  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a bash command on the VPS. Use for system admin tasks: processes, services, logs, disk, etc.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'bash -c command' } },
        required: ['command'],
      },
    },
  },

  update_bot: {
    type: 'function',
    function: {
      name: 'update_bot',
      description: 'Update the bot by pulling the latest code from git, installing npm dependencies, and restarting the service. Use this whenever the user asks you to update yourself.',
      parameters: { type: 'object', properties: {} },
    },
  },

  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute or relative file path' } },
        required: ['path'],
      },
    },
  },

  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file with given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },

  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default: current dir)' } },
      },
    },
  },

  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file at the given path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },

  convert_file: {
    type: 'function',
    function: {
      name: 'convert_file',
      description: 'Convert a file between formats. Supported: csv↔json.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          format: { type: 'string', description: 'Target format, e.g. "json" or "csv"' },
        },
        required: ['path', 'format'],
      },
    },
  },

  system_health: {
    type: 'function',
    function: {
      name: 'system_health',
      description: 'Get a summary of CPU, memory, disk usage, load averages, and uptime.',
      parameters: { type: 'object', properties: {} },
    },
  },

  pm2_status: {
    type: 'function',
    function: {
      name: 'pm2_status',
      description: 'Get the status of all PM2-managed processes.',
      parameters: { type: 'object', properties: {} },
    },
  },

  api_usage: {
    type: 'function',
    function: {
      name: 'api_usage',
      description: 'Show API token usage and call count for the last N days.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Number of days to look back (default 7)' } },
      },
    },
  },

  create_cron: {
    type: 'function',
    function: {
      name: 'create_cron',
      description: 'Schedule a recurring cron job. Actions: "message" (send text), "command" (run shell cmd), "health_check" (check URL).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for this job' },
          schedule: { type: 'string', description: 'Cron expression, e.g. "0 9 * * *" for 9am UTC daily' },
          action: { type: 'string', enum: ['message', 'command', 'health_check'] },
          payload: { type: 'object', description: 'For message: {message}. For command: {command}. For health_check: {url}.' },
        },
        required: ['name', 'schedule', 'action', 'payload'],
      },
    },
  },

  list_crons: {
    type: 'function',
    function: {
      name: 'list_crons',
      description: 'List all scheduled cron jobs.',
      parameters: { type: 'object', properties: {} },
    },
  },

  delete_cron: {
    type: 'function',
    function: {
      name: 'delete_cron',
      description: 'Delete a cron job by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },

  add_health_check: {
    type: 'function',
    function: {
      name: 'add_health_check',
      description: 'Register a URL to monitor. Alerts you if it goes down.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          interval_minutes: { type: 'number', description: 'Check frequency in minutes (default 5)' },
        },
        required: ['name', 'url'],
      },
    },
  },

  list_health_checks: {
    type: 'function',
    function: {
      name: 'list_health_checks',
      description: 'List all registered health checks and their last known status.',
      parameters: { type: 'object', properties: {} },
    },
  },

  remove_health_check: {
    type: 'function',
    function: {
      name: 'remove_health_check',
      description: 'Remove a health check by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },

  create_webhook: {
    type: 'function',
    function: {
      name: 'create_webhook',
      description: 'Create a webhook endpoint. Returns a secret URL that, when POSTed to, forwards the payload here.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },

  list_webhooks: {
    type: 'function',
    function: {
      name: 'list_webhooks',
      description: 'List all webhook endpoints and their URLs.',
      parameters: { type: 'object', properties: {} },
    },
  },

  delete_webhook: {
    type: 'function',
    function: {
      name: 'delete_webhook',
      description: 'Delete a webhook endpoint by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },

  send_file: {
    type: 'function',
    function: {
      name: 'send_file',
      description:
        'Send a file from the VPS directly to the user in this Telegram chat. ' +
        'Use the filename as it appears in the uploads folder or a full absolute path. ' +
        'If you only have a filename, it will be looked up in the user\'s uploads directory automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Filename (e.g. report.pdf) or full absolute path to the file on the VPS' },
          caption: { type: 'string', description: 'Optional caption to include with the file' },
        },
        required: ['path'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Executor factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {number} userId
 * @param {object} opts
 * @param {boolean} opts.admin - include admin-only tools (shell, files, cron, monitoring)
 * @param {object}  opts.webhookService - { addWebhook, removeWebhook, listWebhooks } from webhook.js
 */
function buildTools(db, userId, { admin = false, webhookService = null } = {}) {
  const ALL_USER_KEYS = [
    // Meta-cognitive tools — always available
    'think', 'plan', 'reflect',
    // External tools
    'browse_url',
    'set_reminder', 'list_reminders', 'delete_reminder',
    'save_note', 'get_notes', 'delete_note',
    'storage_set', 'storage_get', 'storage_delete', 'storage_list',
    // File operations, restricted to user's folder for non-admins
    'read_file', 'write_file', 'list_directory', 'delete_file', 'send_file',
  ];

  const ADMIN_KEYS = [
    'run_command', 'update_bot',
    'convert_file',
    'system_health', 'pm2_status', 'api_usage',
    'create_cron', 'list_crons', 'delete_cron',
    'add_health_check', 'list_health_checks', 'remove_health_check',
    'create_webhook', 'list_webhooks', 'delete_webhook',
  ];

  function getSafePath(inputPath, fileOp = '') {
    const userDir = path.resolve(UPLOADS_DIR, String(userId));

    if (admin) {
      if (fileOp === 'send_file' && inputPath && !path.isAbsolute(inputPath)) {
        return path.join(userDir, inputPath);
      }
      return inputPath || '.';
    }

    // Non-admin logic
    const safeInput = String(inputPath || '');
    const relativeInput = safeInput.replace(/^[\/\\]+/, '');
    const resolvedPath = path.resolve(userDir, relativeInput);

    const relativeFromUserDir = path.relative(userDir, resolvedPath);
    if (relativeFromUserDir && (relativeFromUserDir.startsWith('..') || path.isAbsolute(relativeFromUserDir))) {
      throw new Error('Access denied: Path is outside your designated folder.');
    }

    // Resolve symlinks to prevent escaping the sandbox via a symlink planted
    // inside the user directory. Skip for new paths that don't exist yet (writes).
    try {
      const realResolved = fs.realpathSync(resolvedPath);
      const realUserDir = fs.realpathSync(userDir);
      const realRelative = path.relative(realUserDir, realResolved);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error('Access denied: Path is outside your designated folder.');
      }
    } catch (e) {
      if (e.message.startsWith('Access denied')) throw e;
      // ENOENT = path doesn't exist yet (write ops) — allow it
    }

    return resolvedPath;
  }

  const keys = admin ? [...ADMIN_KEYS, ...ALL_USER_KEYS] : ALL_USER_KEYS;
  const definitions = keys.map((k) => DEF[k]);

  async function executor(toolName, args) {
    switch (toolName) {

      // ── Web ───────────────────────────────────────────────────────────────
      case 'browse_url': {
        const r = await browseUrl(args.url);
        if (r.error) return `Error: ${r.error}`;
        return `Title: ${r.title}\n\n${r.text}`;
      }

      // ── Reminders ─────────────────────────────────────────────────────────
      case 'set_reminder': {
        let fireAt;
        if (args.datetime) {
          fireAt = Math.floor(new Date(args.datetime).getTime() / 1000);
        } else {
          fireAt = Math.floor(Date.now() / 1000) + Math.max(1, Number(args.delay_minutes) || 1) * 60;
        }
        if (!fireAt || isNaN(fireAt)) return 'Could not parse the time — please try again.';
        if (fireAt <= Math.floor(Date.now() / 1000)) return 'That time is in the past.';
        const id = addReminder(db, userId, args.message, fireAt);
        return `Reminder #${id} set for ${new Date(fireAt * 1000).toLocaleString()}: "${args.message}"`;
      }

      case 'list_reminders': {
        const rows = getPendingReminders(db, userId);
        if (!rows.length) return 'No pending reminders.';
        return rows.map((r) => `#${r.id} — "${r.message}" at ${new Date(r.fire_at * 1000).toLocaleString()}`).join('\n');
      }

      case 'delete_reminder': {
        const ok = deleteReminder(db, userId, Number(args.id));
        return ok ? `Reminder #${args.id} cancelled.` : `No reminder with ID ${args.id}.`;
      }

      // ── Notes ──────────────────────────────────────────────────────────────
      case 'save_note': {
        upsertNote(db, userId, args.title, args.content);
        return `Note "${args.title}" saved.`;
      }

      case 'get_notes': {
        const rows = getNotes(db, userId, args.search || null);
        if (!rows.length) return args.search ? `No notes matching "${args.search}".` : 'No notes yet.';
        return rows.map((n) => `[${n.title}]\n${n.content}`).join('\n\n---\n\n');
      }

      case 'delete_note': {
        const ok = deleteNote(db, userId, args.title);
        return ok ? `Note "${args.title}" deleted.` : `No note titled "${args.title}".`;
      }

      // ── Storage ───────────────────────────────────────────────────────────
      case 'storage_set': return storeSet(db, userId, args.key, args.value);
      case 'storage_get': return storeGet(db, userId, args.key);
      case 'storage_delete': return storeDel(db, userId, args.key);
      case 'storage_list': return storeList(db, userId);


      // ── Shell ─────────────────────────────────────────────────────────────
      case 'run_command': {
        const lowerCmd = args.command.toLowerCase();
        if (lowerCmd.includes('update.sh') || lowerCmd.includes('pm2 restart')) {
          return 'Command blocked. To update the bot or restart it, please use the `update_bot` tool instead.';
        }
        const r = await runCommand(args.command);
        return r.output;
      }

      case 'update_bot': {
        const { execFile } = require('child_process');
        // Use npm ci (lockfile-exact) instead of npm install to prevent supply-chain drift.
        // Detach the restart so the LLM replies before the process dies.
        execFile('bash', ['-c', 'git pull 2>&1 && npm ci 2>&1 && (sleep 3; pm2 restart rin) &'],
          (err, stdout) => {
            if (err) console.error('[update_bot] Error:', err.message);
            else console.log('[update_bot] Output:', stdout);
          }
        );
        return 'Update started: pulling latest code, installing dependencies (lockfile-exact), and restarting in 3 seconds.';
      }

      // ── File system ───────────────────────────────────────────────────────
      case 'read_file':
        try { return readFile(getSafePath(args.path)); } catch (e) { return e.message; }
      case 'write_file':
        try { return writeFile(getSafePath(args.path), args.content); } catch (e) { return e.message; }
      case 'list_directory':
        try { return listDirectory(getSafePath(args.path)); } catch (e) { return e.message; }
      case 'delete_file':
        try { return deleteFile(getSafePath(args.path)); } catch (e) { return e.message; }
      case 'convert_file':
        try { return convertFile(getSafePath(args.path), args.format); } catch (e) { return e.message; }

      // ── Monitoring ────────────────────────────────────────────────────────
      case 'system_health': return await getSystemHealth();
      case 'pm2_status': return await getPm2Status();
      case 'api_usage': return getApiUsage(db, args.days || 7);

      // ── Cron ──────────────────────────────────────────────────────────────
      case 'create_cron': {
        const r = addJob(db, userId, args.name, args.schedule, args.action, args.payload);
        return r.ok ? `Cron job "${args.name}" created (ID ${r.id}).` : `Error: ${r.error}`;
      }

      case 'list_crons': {
        const jobs = listCronJobs(db, userId);
        if (!jobs.length) return 'No cron jobs.';
        return jobs.map((j) =>
          `[${j.id}] ${j.name} — ${j.schedule} | action: ${j.action} | ${j.enabled ? 'enabled' : 'disabled'}`
        ).join('\n');
      }

      case 'delete_cron': {
        const ok = removeJob(db, userId, args.name);
        return ok ? `Cron job "${args.name}" deleted.` : `No cron job named "${args.name}".`;
      }

      // ── Health checks ──────────────────────────────────────────────────────
      case 'add_health_check': {
        addHealthCheck(db, userId, args.name, args.url, args.interval_minutes || 5);
        return `Health check "${args.name}" added for ${args.url} (every ${args.interval_minutes || 5} min).`;
      }

      case 'list_health_checks': {
        const rows = listHealthChecks(db, userId);
        if (!rows.length) return 'No health checks configured.';
        return rows.map((h) => {
          const last = h.last_status ? `last: HTTP ${h.last_status}` : 'never checked';
          return `[${h.name}] ${h.url} — every ${h.interval_minutes}m — ${last}`;
        }).join('\n');
      }

      case 'remove_health_check': {
        const ok = deleteHealthCheck(db, userId, args.name);
        return ok ? `Health check "${args.name}" removed.` : `No health check named "${args.name}".`;
      }

      // ── Webhooks ──────────────────────────────────────────────────────────
      case 'create_webhook': {
        if (!webhookService) return 'Webhook server not running.';
        const { url, token } = webhookService.addWebhook(userId, args.name, args.description || '');
        return `Webhook "${args.name}" created.\nURL: ${url}\nPOST JSON to that URL and it will appear here.`;
      }

      case 'list_webhooks': {
        if (!webhookService) return 'Webhook server not running.';
        const hooks = webhookService.listWebhooks(userId);
        if (!hooks.length) return 'No webhooks configured.';
        return hooks.map((h) => `[${h.name}] ${h.url}${h.description ? ' — ' + h.description : ''}`).join('\n');
      }

      case 'delete_webhook': {
        if (!webhookService) return 'Webhook server not running.';
        const ok = webhookService.removeWebhook(userId, args.name);
        return ok ? `Webhook "${args.name}" deleted.` : `No webhook named "${args.name}".`;
      }

      // ── Send file to Telegram ──────────────────────────────────────────────
      case 'send_file': {
        try {
          const filePath = getSafePath(args.path, 'send_file');
          const chatId = userId; // send back to the same user
          await sendTelegramFile(
            process.env.TELEGRAM_BOT_TOKEN,
            chatId,
            filePath,
            args.caption || undefined
          );
          return `File sent successfully: ${path.basename(filePath)}`;
        } catch (err) {
          return `Failed to send file: ${err.message}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  return { definitions, executor };
}

module.exports = { buildTools };
