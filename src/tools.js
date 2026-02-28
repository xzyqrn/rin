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
  storageGet, getGoogleTokens
} = require('./database');
const {
  GOOGLE_SCOPE_REQUIREMENTS,
  categorizeGoogleError,
  getGoogleScopeStatusFromTokens,
  listDriveFiles,
  createDriveFile,
  createDriveFolder,
  updateDriveFile,
  deleteDriveFile,
  listEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listUnreadEmails,
  listInboxEmails,
  sendEmail,
  replyToMessage,
  createDraft,
  modifyMessageLabels,
  markMessageRead,
  markMessageUnread,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listCourses,
  listCoursework,
  listUpcomingAssignments,
} = require('./capabilities/google');

const GOOGLE_AGENT_V2_ENABLED = process.env.GOOGLE_AGENT_V2 !== '0';

function getGoogleOAuthBaseUrl() {
  return (process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

function buildGoogleRelinkUrl(userId) {
  const base = getGoogleOAuthBaseUrl();
  if (!base) return '';
  return `${base}/api/auth/google?state=${encodeURIComponent(String(userId))}`;
}

function formatGoogleAuthStatus(tokens) {
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    return 'not linked';
  }

  const hasRefresh = Boolean(tokens.refresh_token);
  const expiry = Number(tokens.expiry_date || 0);
  if (!expiry) {
    return hasRefresh ? 'linked (token expiry unknown, refresh token present)' : 'linked (token expiry unknown, refresh token missing)';
  }

  const msLeft = expiry - Date.now();
  const minsLeft = Math.floor(msLeft / 60000);
  if (msLeft <= 0) {
    return hasRefresh ? 'linked (access token expired, refresh token present)' : 'linked (access token expired, refresh token missing)';
  }
  if (minsLeft < 60) {
    return hasRefresh ? `linked (token expires in ~${minsLeft}m, refresh token present)` : `linked (token expires in ~${minsLeft}m, refresh token missing)`;
  }
  const hoursLeft = Math.floor(minsLeft / 60);
  return hasRefresh ? `linked (token expires in ~${hoursLeft}h, refresh token present)` : `linked (token expires in ~${hoursLeft}h, refresh token missing)`;
}

function normalizeGoogleError(err, userId) {
  const details = categorizeGoogleError(err);
  const relinkUrl = buildGoogleRelinkUrl(userId);
  const relinkHint = relinkUrl
    ? `Relink: ${relinkUrl}`
    : 'Relink: use /linkgoogle after GOOGLE_OAUTH_BASE_URL is configured.';

  if (details.category === 'not_linked') {
    return `Google account is not linked for this user.\n${relinkHint}`;
  }

  if (details.category === 'auth_expired') {
    return `Google authentication expired or was revoked.\nPlease relink your Google account.\n${relinkHint}`;
  }

  if (details.category === 'insufficient_scope') {
    return `Google denied this request due to missing permissions/scopes.\nRun google_scope_status for exact missing scopes, then relink and accept all requested permissions.\n${relinkHint}`;
  }

  if (details.category === 'not_found') {
    return `Google could not find the requested resource (status ${details.status || 'unknown'}).\nVerify the ID and try again.`;
  }

  if (details.category === 'rate_limited') {
    return 'Google API rate limit reached. Please retry shortly.';
  }

  return `[Google Error] ${details.message}`;
}

async function logGoogleToolMetric(db, userId, service, action, status, errorCategory = '') {
  try {
    if (!db || typeof db.collection !== 'function') return;
    await db.collection('google_tool_metrics').add({
      user_id: userId,
      service,
      action,
      status,
      error_category: errorCategory || null,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch {
    // Best-effort metrics only.
  }
}

function _minutesUntilExpiry(expiryDate) {
  const expiry = Number(expiryDate || 0);
  if (!expiry) return null;
  return Math.floor((expiry - Date.now()) / 60000);
}

function buildGoogleCapabilitiesPayload({ hasGoogleAuth, keys, userId }) {
  const has = (name) => keys.includes(name);
  return {
    schema_version: 'google_capabilities.v1',
    source_of_truth: 'runtime_tool_registry',
    linked: Boolean(hasGoogleAuth),
    relink_url: buildGoogleRelinkUrl(userId) || null,
    services: {
      drive: {
        list: has('google_drive_list'),
        create_file: has('google_drive_create_file'),
        create_folder: has('google_drive_create_folder'),
        update: has('google_drive_update_file'),
        delete: has('google_drive_delete_file'),
      },
      gmail: {
        read_unread: has('gmail_read_unread'),
        inbox_read: has('gmail_inbox_read'),
        send: has('gmail_send'),
        reply: has('gmail_reply'),
        draft_create: has('gmail_draft_create'),
        label_add: has('gmail_label_add'),
        label_remove: has('gmail_label_remove'),
        mark_read: has('gmail_mark_read'),
        mark_unread: has('gmail_mark_unread'),
      },
      calendar: {
        list: has('google_calendar_list'),
        create: has('google_calendar_create_event'),
        update: has('google_calendar_update_event'),
        delete: has('google_calendar_delete_event'),
      },
      tasks: {
        list: has('google_tasks_list'),
        create: has('google_tasks_create'),
        update: has('google_tasks_update'),
        delete: has('google_tasks_delete'),
      },
      classroom: {
        list_assignments: has('google_classroom_get_assignments'),
        list_courses: has('google_classroom_list_courses'),
        list_coursework: has('google_classroom_list_coursework'),
        write_actions: false,
      },
    },
    out_of_scope: ['docs_api', 'sheets_api'],
  };
}

function buildGoogleScopeStatusPayload({ tokens, userId }) {
  const linked = Boolean(tokens && (tokens.access_token || tokens.refresh_token));
  const relinkUrl = buildGoogleRelinkUrl(userId) || null;
  const expiresInMinutes = _minutesUntilExpiry(tokens?.expiry_date);
  const scopeStatus = getGoogleScopeStatusFromTokens(tokens || {});
  const grantedSet = new Set(scopeStatus.grantedScopes || []);
  const requiredScopesByService = {
    drive: GOOGLE_SCOPE_REQUIREMENTS.drive,
    calendar: GOOGLE_SCOPE_REQUIREMENTS.calendar,
    gmail: Array.from(
      new Set([
        ...GOOGLE_SCOPE_REQUIREMENTS.gmail_read,
        ...GOOGLE_SCOPE_REQUIREMENTS.gmail_send,
        ...GOOGLE_SCOPE_REQUIREMENTS.gmail_compose,
      ])
    ),
    tasks: GOOGLE_SCOPE_REQUIREMENTS.tasks,
    classroom: Array.from(
      new Set([
        ...GOOGLE_SCOPE_REQUIREMENTS.classroom_courses,
        ...GOOGLE_SCOPE_REQUIREMENTS.classroom_coursework,
      ])
    ),
  };
  const missingScopesByService = Object.fromEntries(
    Object.entries(requiredScopesByService).map(([service, scopes]) => [
      service,
      scopes.filter((scope) => !grantedSet.has(scope)),
    ])
  );

  return {
    schema_version: 'google_scope_status.v1',
    linked,
    relink_url: relinkUrl,
    token: {
      has_access_token: Boolean(tokens?.access_token),
      has_refresh_token: Boolean(tokens?.refresh_token),
      expiry_date: Number(tokens?.expiry_date || 0) || null,
      expires_in_minutes: expiresInMinutes,
      expired: expiresInMinutes !== null ? expiresInMinutes <= 0 : null,
    },
    granted_scopes: scopeStatus.grantedScopes,
    required_scopes_by_service: requiredScopesByService,
    missing_scopes_by_service: missingScopesByService,
    tool_scope_checks: scopeStatus.checks,
    relink_instructions: relinkUrl
      ? `Relink at ${relinkUrl} and approve all requested scopes.`
      : 'Relink URL unavailable. Configure GOOGLE_OAUTH_BASE_URL and retry.',
  };
}

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

  // ── Google Integrations ────────────────────────────────────────────────────
  google_capabilities: {
    type: 'function',
    function: {
      name: 'google_capabilities',
      description: 'Return machine-readable JSON with currently available Google capabilities based on linked auth and enabled tools. Use when the user asks what Google actions you can do.',
      parameters: { type: 'object', properties: {} },
    },
  },
  google_auth_status: {
    type: 'function',
    function: {
      name: 'google_auth_status',
      description: 'Check whether the user has a linked Google account, token freshness, and the exact relink URL. Use this before saying you cannot access Google services.',
      parameters: { type: 'object', properties: {} },
    },
  },
  google_scope_status: {
    type: 'function',
    function: {
      name: 'google_scope_status',
      description: 'Return machine-readable Google scope diagnostics, including granted scopes, missing scopes by service, and relink guidance.',
      parameters: { type: 'object', properties: {} },
    },
  },
  google_drive_list: {
    type: 'function',
    function: {
      name: 'google_drive_list',
      description: 'List files in the user\'s connected Google Drive. Use when the user asks about their files, documents, or wants to find something they saved. Pass a query to filter by filename.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional filename search term to filter results (e.g. "resume", "budget 2024")' },
          maxResults: { type: 'number', description: 'Max files to return (default: 10, max: 50)' },
        },
      },
    },
  },
  google_drive_create_file: {
    type: 'function',
    function: {
      name: 'google_drive_create_file',
      description: 'Create a new text-based file in Google Drive. Use for add/create requests.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name, e.g. notes.txt' },
          content: { type: 'string', description: 'File content' },
          mimeType: { type: 'string', description: 'MIME type (default text/plain)' },
        },
        required: ['name', 'content'],
      },
    },
  },
  google_drive_create_folder: {
    type: 'function',
    function: {
      name: 'google_drive_create_folder',
      description: 'Create a new folder in Google Drive. Optionally place it inside a parent folder.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name' },
          parentFolderId: { type: 'string', description: 'Optional parent folder ID. Omit to create in root.' },
        },
        required: ['name'],
      },
    },
  },
  google_drive_update_file: {
    type: 'function',
    function: {
      name: 'google_drive_update_file',
      description: 'Update an existing Google Drive file by ID (rename and/or replace content).',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Drive file ID' },
          name: { type: 'string', description: 'Optional new file name' },
          content: { type: 'string', description: 'Optional replacement content' },
          mimeType: { type: 'string', description: 'MIME type for content updates (default text/plain)' },
        },
        required: ['fileId'],
      },
    },
  },
  google_drive_delete_file: {
    type: 'function',
    function: {
      name: 'google_drive_delete_file',
      description: 'Delete a Google Drive file by ID.',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Drive file ID' },
        },
        required: ['fileId'],
      },
    },
  },
  google_calendar_list: {
    type: 'function',
    function: {
      name: 'google_calendar_list',
      description: 'List upcoming events from the user\'s Google Calendar. Use when the user asks about their schedule, meetings, appointments, or what\'s coming up. Adjust days to match the timeframe they mention.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'How many days ahead to look (default: 7, max: 90). Use 1 for today, 7 for this week, 30 for this month.' },
        },
      },
    },
  },
  google_calendar_create_event: {
    type: 'function',
    function: {
      name: 'google_calendar_create_event',
      description: 'Create a Google Calendar event.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start date/time in ISO (e.g. 2026-03-02T09:00:00+08:00 or 2026-03-02)' },
          end: { type: 'string', description: 'End date/time in ISO (e.g. 2026-03-02T10:00:00+08:00 or 2026-03-03)' },
          description: { type: 'string', description: 'Optional event description' },
          location: { type: 'string', description: 'Optional location' },
          timeZone: { type: 'string', description: 'Optional IANA timezone, e.g. Asia/Manila' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
  },
  google_calendar_update_event: {
    type: 'function',
    function: {
      name: 'google_calendar_update_event',
      description: 'Update a Google Calendar event by event ID.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Calendar event ID' },
          summary: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          timeZone: { type: 'string' },
        },
        required: ['eventId'],
      },
    },
  },
  google_calendar_delete_event: {
    type: 'function',
    function: {
      name: 'google_calendar_delete_event',
      description: 'Delete a Google Calendar event by event ID.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Calendar event ID' },
        },
        required: ['eventId'],
      },
    },
  },
  gmail_read_unread: {
    type: 'function',
    function: {
      name: 'gmail_read_unread',
      description: 'Read unread emails in the user\'s Gmail inbox including content preview/body. Use query to filter by sender, subject, or keyword.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max emails to return (default: 10)' },
          query: { type: 'string', description: 'Gmail search filter (e.g. "from:boss@work.com", "subject:invoice"). Combined with is:unread automatically.' },
        },
      },
    },
  },
  gmail_inbox_read: {
    type: 'function',
    function: {
      name: 'gmail_inbox_read',
      description: 'Read Gmail inbox messages (not just unread), including content preview/body.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max emails to return (default: 10)' },
          query: { type: 'string', description: 'Optional Gmail query (e.g. "from:school.edu", "subject:invoice")' },
          unreadOnly: { type: 'boolean', description: 'Set true to only return unread emails' },
          includeBody: { type: 'boolean', description: 'Set false to return headers/snippet only' },
        },
      },
    },
  },
  gmail_send: {
    type: 'function',
    function: {
      name: 'gmail_send',
      description: 'Send an email from the connected Gmail account.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address(es), comma-separated if multiple' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Plain-text email body' },
          cc: { type: 'string', description: 'Optional CC recipient(s), comma-separated' },
          bcc: { type: 'string', description: 'Optional BCC recipient(s), comma-separated' },
          threadId: { type: 'string', description: 'Optional Gmail thread ID to append the message to an existing thread' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  gmail_reply: {
    type: 'function',
    function: {
      name: 'gmail_reply',
      description: 'Reply to a Gmail message by message ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID to reply to' },
          body: { type: 'string', description: 'Reply body (plain text)' },
          to: { type: 'string', description: 'Optional explicit recipient override' },
          subject: { type: 'string', description: 'Optional explicit subject override' },
        },
        required: ['messageId', 'body'],
      },
    },
  },
  gmail_draft_create: {
    type: 'function',
    function: {
      name: 'gmail_draft_create',
      description: 'Create a Gmail draft message.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address(es), comma-separated if multiple' },
          subject: { type: 'string', description: 'Draft subject line' },
          body: { type: 'string', description: 'Draft body (plain text)' },
          cc: { type: 'string', description: 'Optional CC recipient(s)' },
          bcc: { type: 'string', description: 'Optional BCC recipient(s)' },
          threadId: { type: 'string', description: 'Optional Gmail thread ID' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  gmail_label_add: {
    type: 'function',
    function: {
      name: 'gmail_label_add',
      description: 'Add one or more labels to a Gmail message by message ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label names or IDs to add (e.g. "IMPORTANT", "STARRED", "School")',
          },
        },
        required: ['messageId', 'labels'],
      },
    },
  },
  gmail_label_remove: {
    type: 'function',
    function: {
      name: 'gmail_label_remove',
      description: 'Remove one or more labels from a Gmail message by message ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label names or IDs to remove',
          },
        },
        required: ['messageId', 'labels'],
      },
    },
  },
  gmail_mark_read: {
    type: 'function',
    function: {
      name: 'gmail_mark_read',
      description: 'Mark a Gmail message as read by removing the UNREAD label.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID' },
        },
        required: ['messageId'],
      },
    },
  },
  gmail_mark_unread: {
    type: 'function',
    function: {
      name: 'gmail_mark_unread',
      description: 'Mark a Gmail message as unread by adding the UNREAD label.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID' },
        },
        required: ['messageId'],
      },
    },
  },
  google_tasks_list: {
    type: 'function',
    function: {
      name: 'google_tasks_list',
      description: 'List tasks from the user\'s Google Tasks. Use when the user mentions to-do items, pending tasks, or things they need to do.',
      parameters: {
        type: 'object',
        properties: {
          showCompleted: { type: 'boolean', description: 'Include completed tasks (default false)' },
          maxResults: { type: 'number', description: 'Max tasks to return (default 20)' },
        },
      },
    },
  },
  google_tasks_create: {
    type: 'function',
    function: {
      name: 'google_tasks_create',
      description: 'Create a new task in Google Tasks.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          notes: { type: 'string', description: 'Optional task notes' },
          due: { type: 'string', description: 'Optional due datetime in ISO format' },
        },
        required: ['title'],
      },
    },
  },
  google_tasks_update: {
    type: 'function',
    function: {
      name: 'google_tasks_update',
      description: 'Update a Google Task by task ID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          title: { type: 'string' },
          notes: { type: 'string' },
          due: { type: 'string', description: 'Due datetime in ISO format' },
          status: { type: 'string', enum: ['needsAction', 'completed'] },
        },
        required: ['taskId'],
      },
    },
  },
  google_tasks_delete: {
    type: 'function',
    function: {
      name: 'google_tasks_delete',
      description: 'Delete a task from Google Tasks by task ID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
        },
        required: ['taskId'],
      },
    },
  },
  google_classroom_get_assignments: {
    type: 'function',
    function: {
      name: 'google_classroom_get_assignments',
      description: 'Get all upcoming assignments across ALL of the user\'s Google Classroom courses in one call. Use this whenever the user asks about homework, assignments, deadlines, or what\'s due. Results are sorted by due date.',
      parameters: { type: 'object', properties: {} },
    },
  },
  google_classroom_list_courses: {
    type: 'function',
    function: {
      name: 'google_classroom_list_courses',
      description: 'List the user\'s Google Classroom courses with their IDs. Use when the user asks which classes/courses they are enrolled in. To see assignments, prefer google_classroom_get_assignments instead.',
      parameters: { type: 'object', properties: {} },
    },
  },
  google_classroom_list_coursework: {
    type: 'function',
    function: {
      name: 'google_classroom_list_coursework',
      description: 'List all coursework for a specific course by its ID. Use when the user asks about assignments in a particular class. First call google_classroom_list_courses to get the course ID.',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', description: 'The unique ID of the course (get this from google_classroom_list_courses)' },
        },
        required: ['courseId'],
      },
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
 * @param {boolean} opts.hasGoogleAuth - include Google integration tools
 * @param {object}  opts.webhookService - { addWebhook, removeWebhook, listWebhooks } from webhook.js
 */
function buildTools(db, userId, { admin = false, hasGoogleAuth = false, webhookService = null } = {}) {
  const ALL_USER_KEYS = [
    // Meta-cognitive tools — always available
    'think', 'plan', 'reflect',
    // External tools
    'browse_url',
    'set_reminder', 'list_reminders', 'delete_reminder',
    'save_note', 'get_notes', 'delete_note',
    'storage_set', 'storage_get', 'storage_delete', 'storage_list',
    // Google capability map — always available
    'google_capabilities',
    // Google auth status — always available (even before linking)
    'google_auth_status',
    // Google scope diagnostics — always available (even before linking)
    'google_scope_status',
    // Google data tools — only when user has linked their Google account
    ...(hasGoogleAuth ? [
      'google_drive_list', 'google_drive_create_file', 'google_drive_create_folder', 'google_drive_update_file', 'google_drive_delete_file',
      'google_calendar_list', 'google_calendar_create_event', 'google_calendar_update_event', 'google_calendar_delete_event',
      'gmail_read_unread', 'gmail_inbox_read',
      ...(GOOGLE_AGENT_V2_ENABLED ? [
        'gmail_send', 'gmail_reply', 'gmail_draft_create',
        'gmail_label_add', 'gmail_label_remove', 'gmail_mark_read', 'gmail_mark_unread',
      ] : []),
      'google_tasks_list', 'google_tasks_create', 'google_tasks_update', 'google_tasks_delete',
      'google_classroom_get_assignments',
      'google_classroom_list_courses', 'google_classroom_list_coursework',
    ] : []),
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
    async function formatTimeAsync(ms) {
      const userTz = await storageGet(db, userId, 'timezone');
      const tz = userTz || process.env.TIMEZONE || process.env.TZ || 'System Default';
      try {
        return new Date(ms).toLocaleString('en-US', { timeZone: tz === 'System Default' ? undefined : tz });
      } catch (e) {
        return new Date(ms).toLocaleString();
      }
    }

    async function runGoogleTool(service, action, fn) {
      try {
        const result = await fn();
        await logGoogleToolMetric(db, userId, service, action, 'success');
        return result;
      } catch (err) {
        const details = categorizeGoogleError(err);
        await logGoogleToolMetric(db, userId, service, action, 'error', details.category);
        return normalizeGoogleError(err, userId);
      }
    }

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
        const id = await addReminder(db, userId, args.message, fireAt);
        return `Reminder #${id} set for ${await formatTimeAsync(fireAt * 1000)}: "${args.message}"`;
      }

      case 'list_reminders': {
        const rows = await getPendingReminders(db, userId);
        if (!rows.length) return 'No pending reminders.';
        return Promise.all(rows.map(async (r) => `#${r.id} — "${r.message}" at ${await formatTimeAsync(r.fire_at * 1000)}`)).then(res => res.join('\n'));
      }

      case 'delete_reminder': {
        const ok = await deleteReminder(db, userId, Number(args.id));
        return ok ? `Reminder #${args.id} cancelled.` : `No reminder with ID ${args.id}.`;
      }

      // ── Notes ──────────────────────────────────────────────────────────────
      case 'save_note': {
        await upsertNote(db, userId, args.title, args.content);
        return `Note "${args.title}" saved.`;
      }

      case 'get_notes': {
        const rows = await getNotes(db, userId, args.search || null);
        if (!rows.length) return args.search ? `No notes matching "${args.search}".` : 'No notes yet.';
        return rows.map((n) => `[${n.title}]\n${n.content}`).join('\n\n---\n\n');
      }

      case 'delete_note': {
        const ok = await deleteNote(db, userId, args.title);
        return ok ? `Note "${args.title}" deleted.` : `No note titled "${args.title}".`;
      }

      // ── Storage ───────────────────────────────────────────────────────────
      case 'storage_set': return await storeSet(db, userId, args.key, args.value);
      case 'storage_get': return await storeGet(db, userId, args.key);
      case 'storage_delete': return await storeDel(db, userId, args.key);
      case 'storage_list': return await storeList(db, userId);

      // ── Google Integrations ───────────────────────────────────────────────
      case 'google_capabilities': {
        return JSON.stringify(
          buildGoogleCapabilitiesPayload({ hasGoogleAuth, keys, userId }),
          null,
          2
        );
      }
      case 'google_auth_status': {
        const tokens = await getGoogleTokens(db, userId);
        const relinkUrl = buildGoogleRelinkUrl(userId);
        const relinkHint = relinkUrl
          ? `Relink URL: ${relinkUrl}`
          : 'Relink URL unavailable because GOOGLE_OAUTH_BASE_URL is not configured.';
        return `Google auth status: ${formatGoogleAuthStatus(tokens)}.\n${relinkHint}`;
      }
      case 'google_scope_status': {
        const tokens = await getGoogleTokens(db, userId);
        return JSON.stringify(buildGoogleScopeStatusPayload({ tokens, userId }), null, 2);
      }
      case 'google_drive_list':
        return runGoogleTool('drive', 'list', async () => {
          const files = await listDriveFiles(db, userId, args.maxResults || 10, args.query || '');
          if (!files || !files.length) return 'No files found in Drive.';
          return files.map(f => {
            const modified = f.modifiedTime ? ` (modified: ${f.modifiedTime.slice(0, 10)})` : '';
            return `- ${f.name}${modified} [${f.mimeType || 'unknown'}] (ID: ${f.id})`;
          }).join('\n');
        });
      case 'google_drive_create_file':
        return runGoogleTool('drive', 'create_file', async () => {
          const file = await createDriveFile(db, userId, args.name, args.content, args.mimeType || 'text/plain');
          return `Created Drive file "${file.name}" (ID: ${file.id})${file.webViewLink ? `\nOpen: ${file.webViewLink}` : ''}`;
        });
      case 'google_drive_create_folder':
        return runGoogleTool('drive', 'create_folder', async () => {
          const folder = await createDriveFolder(db, userId, args.name, args.parentFolderId || '');
          return `Created Drive folder "${folder.name}" (ID: ${folder.id})${folder.webViewLink ? `\nOpen: ${folder.webViewLink}` : ''}`;
        });
      case 'google_drive_update_file':
        return runGoogleTool('drive', 'update_file', async () => {
          if (args.name === undefined && args.content === undefined) {
            return 'Please provide at least one field to update: name and/or content.';
          }
          const file = await updateDriveFile(db, userId, args.fileId, {
            name: args.name,
            content: args.content,
            mimeType: args.mimeType,
          });
          return `Updated Drive file "${file.name}" (ID: ${file.id})`;
        });
      case 'google_drive_delete_file':
        return runGoogleTool('drive', 'delete_file', async () => {
          await deleteDriveFile(db, userId, args.fileId);
          return `Deleted Drive file ID: ${args.fileId}`;
        });
      case 'google_calendar_list':
        return runGoogleTool('calendar', 'list', async () => {
          const events = await listEvents(db, userId, 10, args.days || 7);
          if (!events || !events.length) return 'No upcoming events found.';
          return events.map(e => {
            const when = e.start?.dateTime || e.start?.date || 'unknown time';
            return `- ${e.summary || '(No title)'} at ${when} (ID: ${e.id})`;
          }).join('\n');
        });
      case 'google_calendar_create_event':
        return runGoogleTool('calendar', 'create_event', async () => {
          const event = await createCalendarEvent(db, userId, {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
          });
          return `Created calendar event "${event.summary || '(No title)'}" (ID: ${event.id}) at ${event.start?.dateTime || event.start?.date || 'unknown time'}`;
        });
      case 'google_calendar_update_event':
        return runGoogleTool('calendar', 'update_event', async () => {
          if (
            args.summary === undefined &&
            args.description === undefined &&
            args.location === undefined &&
            args.start === undefined &&
            args.end === undefined
          ) {
            return 'Please provide at least one field to update: summary, description, location, start, or end.';
          }
          const event = await updateCalendarEvent(db, userId, args.eventId, {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: args.start,
            end: args.end,
            timeZone: args.timeZone,
          });
          return `Updated calendar event "${event.summary || '(No title)'}" (ID: ${event.id})`;
        });
      case 'google_calendar_delete_event':
        return runGoogleTool('calendar', 'delete_event', async () => {
          await deleteCalendarEvent(db, userId, args.eventId);
          return `Deleted calendar event ID: ${args.eventId}`;
        });
      case 'gmail_read_unread':
        return runGoogleTool('gmail', 'read_unread', async () => {
          const emails = await listUnreadEmails(db, userId, args.maxResults || 10, args.query || '');
          if (!emails.length) return 'No unread emails.';
          return emails.map((m) => {
            const body = String(m.bodyText || m.snippet || '').replace(/\s+/g, ' ').trim();
            const preview = body ? `\n  Content: ${body.slice(0, 280)}${body.length > 280 ? '...' : ''}` : '';
            return `- [${String(m.date || '').slice(0, 24)}] ${m.subject} — from ${m.from}${preview}`;
          }).join('\n');
        });
      case 'gmail_inbox_read':
        return runGoogleTool('gmail', 'inbox_read', async () => {
          const emails = await listInboxEmails(
            db,
            userId,
            args.maxResults || 10,
            args.query || '',
            args.includeBody !== false,
            Boolean(args.unreadOnly)
          );
          if (!emails.length) return args.unreadOnly ? 'No unread emails.' : 'No inbox emails found.';
          return emails.map((m) => {
            const status = m.unread ? 'UNREAD' : 'READ';
            const body = String(m.bodyText || m.snippet || '').replace(/\s+/g, ' ').trim();
            const preview = body ? `\n  Content: ${body.slice(0, 280)}${body.length > 280 ? '...' : ''}` : '';
            return `- [${status}] [${String(m.date || '').slice(0, 24)}] ${m.subject} — from ${m.from}${preview}`;
          }).join('\n');
        });
      case 'gmail_send':
        return runGoogleTool('gmail', 'send', async () => {
          const sent = await sendEmail(db, userId, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
            threadId: args.threadId,
          });
          return `Email sent successfully (Message ID: ${sent.id || 'unknown'})${sent.threadId ? `\nThread ID: ${sent.threadId}` : ''}`;
        });
      case 'gmail_reply':
        return runGoogleTool('gmail', 'reply', async () => {
          const sent = await replyToMessage(db, userId, {
            messageId: args.messageId,
            body: args.body,
            to: args.to,
            subject: args.subject,
          });
          return `Reply sent successfully (Message ID: ${sent.id || 'unknown'})${sent.threadId ? `\nThread ID: ${sent.threadId}` : ''}`;
        });
      case 'gmail_draft_create':
        return runGoogleTool('gmail', 'draft_create', async () => {
          const draft = await createDraft(db, userId, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
            threadId: args.threadId,
          });
          const messageId = draft.message?.id || 'unknown';
          return `Draft created successfully (Draft ID: ${draft.id || 'unknown'}, Message ID: ${messageId})`;
        });
      case 'gmail_label_add':
        return runGoogleTool('gmail', 'label_add', async () => {
          if (!Array.isArray(args.labels) || !args.labels.length) {
            return 'Please provide at least one label to add.';
          }
          const updated = await modifyMessageLabels(db, userId, args.messageId, { add: args.labels });
          return `Labels added to message ${updated.id}. Current labels: ${(updated.labelIds || []).join(', ') || '(none)'}`;
        });
      case 'gmail_label_remove':
        return runGoogleTool('gmail', 'label_remove', async () => {
          if (!Array.isArray(args.labels) || !args.labels.length) {
            return 'Please provide at least one label to remove.';
          }
          const updated = await modifyMessageLabels(db, userId, args.messageId, { remove: args.labels });
          return `Labels removed from message ${updated.id}. Current labels: ${(updated.labelIds || []).join(', ') || '(none)'}`;
        });
      case 'gmail_mark_read':
        return runGoogleTool('gmail', 'mark_read', async () => {
          const updated = await markMessageRead(db, userId, args.messageId);
          return `Marked message ${updated.id} as read.`;
        });
      case 'gmail_mark_unread':
        return runGoogleTool('gmail', 'mark_unread', async () => {
          const updated = await markMessageUnread(db, userId, args.messageId);
          return `Marked message ${updated.id} as unread.`;
        });
      case 'google_tasks_list':
        return runGoogleTool('tasks', 'list', async () => {
          const tasks = await listTasks(db, userId, args.maxResults || 20, Boolean(args.showCompleted));
          if (!tasks.length) return 'No tasks found.';
          return tasks.map(t => {
            const status = t.status === 'completed' ? 'completed' : 'pending';
            const due = t.due ? ` | due: ${String(t.due).slice(0, 10)}` : '';
            return `- ${t.title || '(Untitled task)'} (${status})${due} (ID: ${t.id})`;
          }).join('\n');
        });
      case 'google_tasks_create':
        return runGoogleTool('tasks', 'create', async () => {
          const task = await createTask(db, userId, {
            title: args.title,
            notes: args.notes,
            due: args.due,
          });
          return `Created task "${task.title || '(Untitled task)'}" (ID: ${task.id})`;
        });
      case 'google_tasks_update':
        return runGoogleTool('tasks', 'update', async () => {
          if (
            args.title === undefined &&
            args.notes === undefined &&
            args.due === undefined &&
            args.status === undefined
          ) {
            return 'Please provide at least one field to update: title, notes, due, or status.';
          }
          const task = await updateTask(db, userId, args.taskId, {
            title: args.title,
            notes: args.notes,
            due: args.due,
            status: args.status,
          });
          return `Updated task "${task.title || '(Untitled task)'}" (ID: ${task.id})`;
        });
      case 'google_tasks_delete':
        return runGoogleTool('tasks', 'delete', async () => {
          await deleteTask(db, userId, args.taskId);
          return `Deleted task ID: ${args.taskId}`;
        });
      case 'google_classroom_get_assignments':
        return runGoogleTool('classroom', 'get_assignments', async () => {
          const assignments = await listUpcomingAssignments(db, userId);
          if (!assignments.length) return 'No upcoming assignments found across your courses.';
          return assignments.map(a => {
            const due = a.dueDate ? `due ${a.dueDate}` : 'no due date';
            return `- [${a.courseName}] ${a.title} (${due})${a.alternateLink ? `\n  Link: ${a.alternateLink}` : ''}`;
          }).join('\n');
        });
      case 'google_classroom_list_courses':
        return runGoogleTool('classroom', 'list_courses', async () => {
          const courses = await listCourses(db, userId);
          if (!courses.length) return 'No courses found in Classroom.';
          return courses.map(c => `- ${c.name} (ID: ${c.id})`).join('\n');
        });
      case 'google_classroom_list_coursework':
        return runGoogleTool('classroom', 'list_coursework', async () => {
          const work = await listCoursework(db, userId, args.courseId);
          if (!work.length) return 'No coursework found for this course.';
          return work.map(w => {
            const due = w.dueDate ? `${w.dueDate.year}-${String(w.dueDate.month).padStart(2,'0')}-${String(w.dueDate.day).padStart(2,'0')}` : 'no date';
            return `- ${w.title} (due: ${due}) (ID: ${w.id})`;
          }).join('\n');
        });


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
      case 'api_usage': return await getApiUsage(db, args.days || 7);

      // ── Cron ──────────────────────────────────────────────────────────────
      case 'create_cron': {
        const r = await addJob(db, userId, args.name, args.schedule, args.action, args.payload);
        return r.ok ? `Cron job "${args.name}" created (ID ${r.id}).` : `Error: ${r.error}`;
      }

      case 'list_crons': {
        const jobs = await listCronJobs(db, userId);
        if (!jobs.length) return 'No cron jobs.';
        return jobs.map((j) =>
          `[${j.id}] ${j.name} — ${j.schedule} | action: ${j.action} | ${j.enabled ? 'enabled' : 'disabled'}`
        ).join('\n');
      }

      case 'delete_cron': {
        const ok = await removeJob(db, userId, args.name);
        return ok ? `Cron job "${args.name}" deleted.` : `No cron job named "${args.name}".`;
      }

      // ── Health checks ──────────────────────────────────────────────────────
      case 'add_health_check': {
        await addHealthCheck(db, userId, args.name, args.url, args.interval_minutes || 5);
        return `Health check "${args.name}" added for ${args.url} (every ${args.interval_minutes || 5} min).`;
      }

      case 'list_health_checks': {
        const rows = await listHealthChecks(db, userId);
        if (!rows.length) return 'No health checks configured.';
        return rows.map((h) => {
          const last = h.last_status ? `last: HTTP ${h.last_status}` : 'never checked';
          return `[${h.name}] ${h.url} — every ${h.interval_minutes}m — ${last}`;
        }).join('\n');
      }

      case 'remove_health_check': {
        const ok = await deleteHealthCheck(db, userId, args.name);
        return ok ? `Health check "${args.name}" removed.` : `No health check named "${args.name}".`;
      }

      // ── Webhooks ──────────────────────────────────────────────────────────
      case 'create_webhook': {
        if (!webhookService) return 'Webhook server not running.';
        const { url, token } = await webhookService.addWebhook(userId, args.name, args.description || '');
        return `Webhook "${args.name}" created.\nURL: ${url}\nPOST JSON to that URL and it will appear here.`;
      }

      case 'list_webhooks': {
        if (!webhookService) return 'Webhook server not running.';
        const hooks = await webhookService.listWebhooks(userId);
        if (!hooks.length) return 'No webhooks configured.';
        return hooks.map((h) => `[${h.name}] ${h.url}${h.description ? ' — ' + h.description : ''}`).join('\n');
      }

      case 'delete_webhook': {
        if (!webhookService) return 'Webhook server not running.';
        const ok = await webhookService.removeWebhook(userId, args.name);
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
