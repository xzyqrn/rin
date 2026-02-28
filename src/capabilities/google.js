'use strict';

const { google } = require('googleapis');
const { getGoogleTokens, saveGoogleTokens } = require('../database');

function _resolveRedirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const oauthBase = (process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (oauthBase) return `${oauthBase}/api/auth/google/callback`;
  return undefined;
}

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = _resolveRedirectUri();

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthenticatedClient(db, userId) {
  const tokens = await getGoogleTokens(db, userId);
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    throw new Error('User not authenticated with Google. Run /linkgoogle first.');
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    saveGoogleTokens(db, userId, newTokens).catch(console.error);
  });

  return oauth2Client;
}

function _decodeBase64Url(input) {
  if (!input) return '';
  const base64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _extractPartData(part, mimeType) {
  if (!part) return '';
  if (part.mimeType === mimeType && part.body?.data) return _decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const out = _extractPartData(child, mimeType);
      if (out) return out;
    }
  }
  return '';
}

function _extractEmailBody(payload) {
  if (!payload) return '';
  const plain = _extractPartData(payload, 'text/plain');
  if (plain) return plain.trim();
  const html = _extractPartData(payload, 'text/html');
  if (html) return _stripHtml(html);
  if (payload.body?.data) {
    const decoded = _decodeBase64Url(payload.body.data);
    if (decoded) return decoded.trim();
  }
  return '';
}

function _getHeader(headers, name) {
  const match = (headers || []).find((h) => String(h.name || '').toLowerCase() === name.toLowerCase());
  return match?.value || '';
}

function _buildEventDateInput(value, timeZone) {
  if (!value) return undefined;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  return { dateTime: s, ...(timeZone ? { timeZone } : {}) };
}

function _formatDueDate(dueDate, dueTime) {
  if (!dueDate) return null;
  const y = dueDate.year;
  const m = String(dueDate.month).padStart(2, '0');
  const d = String(dueDate.day).padStart(2, '0');
  const hh = String(dueTime?.hours ?? 0).padStart(2, '0');
  const mm = String(dueTime?.minutes ?? 0).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function _toDueTimestamp(dueDate, dueTime) {
  if (!dueDate) return Number.POSITIVE_INFINITY;
  return Date.UTC(
    dueDate.year,
    dueDate.month - 1,
    dueDate.day,
    dueTime?.hours || 0,
    dueTime?.minutes || 0,
    dueTime?.seconds || 0
  );
}

// ── Drive ────────────────────────────────────────────────────────────────────
async function listDriveFiles(db, userId, maxResults = 10, query = '') {
  const auth = await getAuthenticatedClient(db, userId);
  const drive = google.drive({ version: 'v3', auth });
  const params = {
    pageSize: Math.min(Math.max(Number(maxResults) || 10, 1), 50),
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };
  if (query) params.q = `name contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list(params);
  return res.data.files || [];
}

async function createDriveFile(db, userId, name, content, mimeType = 'text/plain') {
  const auth = await getAuthenticatedClient(db, userId);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: { name, mimeType },
    media: { mimeType, body: content || '' },
    fields: 'id, name, mimeType, modifiedTime, webViewLink',
    supportsAllDrives: true,
  });
  return res.data;
}

async function createDriveFolder(db, userId, name, parentFolderId = '') {
  const auth = await getAuthenticatedClient(db, userId);
  const drive = google.drive({ version: 'v3', auth });
  const requestBody = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  };
  const res = await drive.files.create({
    requestBody,
    fields: 'id, name, mimeType, modifiedTime, webViewLink',
    supportsAllDrives: true,
  });
  return res.data;
}

async function updateDriveFile(db, userId, fileId, { name, content, mimeType } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const drive = google.drive({ version: 'v3', auth });
  const req = {
    fileId,
    fields: 'id, name, mimeType, modifiedTime, webViewLink',
    supportsAllDrives: true,
  };
  if (name) req.requestBody = { name };
  if (content !== undefined) {
    req.media = { mimeType: mimeType || 'text/plain', body: content };
  }
  const res = await drive.files.update(req);
  return res.data;
}

async function deleteDriveFile(db, userId, fileId) {
  const auth = await getAuthenticatedClient(db, userId);
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.delete({ fileId, supportsAllDrives: true });
  return true;
}

// ── Calendar ─────────────────────────────────────────────────────────────────
async function listEvents(db, userId, maxResults = 10, days = 7) {
  const auth = await getAuthenticatedClient(db, userId);
  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const dayCount = Math.min(Math.max(Number(days) || 7, 1), 365);
  const timeMax = new Date(now.getTime() + dayCount * 24 * 60 * 60 * 1000).toISOString();
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax,
    maxResults: Math.min(Math.max(Number(maxResults) || 10, 1), 50),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

async function createCalendarEvent(db, userId, { summary, description, location, start, end, timeZone } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {
    summary,
    description,
    location,
    start: _buildEventDateInput(start, timeZone),
    end: _buildEventDateInput(end, timeZone),
  };
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody,
  });
  return res.data;
}

async function updateCalendarEvent(db, userId, eventId, { summary, description, location, start, end, timeZone } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {};
  if (summary !== undefined) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (location !== undefined) requestBody.location = location;
  if (start !== undefined) requestBody.start = _buildEventDateInput(start, timeZone);
  if (end !== undefined) requestBody.end = _buildEventDateInput(end, timeZone);

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody,
  });
  return res.data;
}

async function deleteCalendarEvent(db, userId, eventId) {
  const auth = await getAuthenticatedClient(db, userId);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
  });
  return true;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
async function _listGmailEmails(db, userId, { maxResults = 10, query = '', unreadOnly = false, includeBody = true } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const q = [unreadOnly ? 'is:unread' : '', query].filter(Boolean).join(' ');

  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: Math.min(Math.max(Number(maxResults) || 10, 1), 20),
  });

  const messages = res.data.messages || [];
  if (!messages.length) return [];

  const format = includeBody ? 'full' : 'metadata';
  const emails = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages
        .get({
          userId: 'me',
          id: msg.id,
          format,
          metadataHeaders: ['From', 'Subject', 'Date'],
        })
        .then((r) => r.data)
    )
  );

  return emails.map((m) => {
    const headers = m.payload?.headers || [];
    const bodyText = includeBody ? _extractEmailBody(m.payload) : '';
    return {
      id: m.id,
      threadId: m.threadId,
      from: _getHeader(headers, 'From') || 'Unknown',
      subject: _getHeader(headers, 'Subject') || 'No Subject',
      date: _getHeader(headers, 'Date') || '',
      snippet: m.snippet || '',
      bodyText,
      unread: Array.isArray(m.labelIds) ? m.labelIds.includes('UNREAD') : false,
    };
  });
}

async function listUnreadEmails(db, userId, maxResults = 10, query = '') {
  return _listGmailEmails(db, userId, { maxResults, query, unreadOnly: true, includeBody: true });
}

async function listInboxEmails(db, userId, maxResults = 10, query = '', includeBody = true, unreadOnly = false) {
  return _listGmailEmails(db, userId, { maxResults, query, includeBody, unreadOnly });
}

// ── Tasks ────────────────────────────────────────────────────────────────────
async function listTasks(db, userId, maxResults = 20, showCompleted = false) {
  const auth = await getAuthenticatedClient(db, userId);
  const tasksService = google.tasks({ version: 'v1', auth });
  const res = await tasksService.tasks.list({
    tasklist: '@default',
    maxResults: Math.min(Math.max(Number(maxResults) || 20, 1), 100),
    showCompleted: Boolean(showCompleted),
    showHidden: false,
  });
  return res.data.items || [];
}

async function createTask(db, userId, { title, notes, due } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const tasksService = google.tasks({ version: 'v1', auth });
  const res = await tasksService.tasks.insert({
    tasklist: '@default',
    requestBody: {
      title,
      notes,
      due: due || undefined,
    },
  });
  return res.data;
}

async function updateTask(db, userId, taskId, { title, notes, due, status } = {}) {
  const auth = await getAuthenticatedClient(db, userId);
  const tasksService = google.tasks({ version: 'v1', auth });
  const requestBody = {};
  if (title !== undefined) requestBody.title = title;
  if (notes !== undefined) requestBody.notes = notes;
  if (due !== undefined) requestBody.due = due || null;
  if (status !== undefined) requestBody.status = status;

  const res = await tasksService.tasks.patch({
    tasklist: '@default',
    task: taskId,
    requestBody,
  });
  return res.data;
}

async function deleteTask(db, userId, taskId) {
  const auth = await getAuthenticatedClient(db, userId);
  const tasksService = google.tasks({ version: 'v1', auth });
  await tasksService.tasks.delete({
    tasklist: '@default',
    task: taskId,
  });
  return true;
}

// ── Classroom ────────────────────────────────────────────────────────────────
async function listCourses(db, userId) {
  const auth = await getAuthenticatedClient(db, userId);
  const classroom = google.classroom({ version: 'v1', auth });
  const courses = [];
  let pageToken = undefined;
  let pages = 0;

  do {
    const res = await classroom.courses.list({
      pageSize: 100,
      pageToken,
      courseStates: ['ACTIVE', 'PROVISIONED'],
    });
    courses.push(...(res.data.courses || []));
    pageToken = res.data.nextPageToken || undefined;
    pages++;
  } while (pageToken && pages < 10);

  return courses;
}

async function listCoursework(db, userId, courseId) {
  const auth = await getAuthenticatedClient(db, userId);
  const classroom = google.classroom({ version: 'v1', auth });
  const work = [];
  let pageToken = undefined;
  let pages = 0;

  do {
    const res = await classroom.courses.courseWork.list({
      courseId,
      courseWorkStates: ['PUBLISHED'],
      pageSize: 100,
      pageToken,
    });
    work.push(...(res.data.courseWork || []));
    pageToken = res.data.nextPageToken || undefined;
    pages++;
  } while (pageToken && pages < 10);

  return work;
}

// Fetch all courses + upcoming assignments.
async function listUpcomingAssignments(db, userId) {
  const courses = await listCourses(db, userId);
  if (!courses.length) return [];

  const now = Date.now();
  const courseworkResults = await Promise.all(
    courses.map(async (course) => {
      try {
        const work = await listCoursework(db, userId, course.id);
        return { course, work };
      } catch {
        return { course, work: [] };
      }
    })
  );

  const assignments = [];
  for (const { course, work } of courseworkResults) {
    for (const item of work) {
      const dueTs = _toDueTimestamp(item.dueDate, item.dueTime);
      if (dueTs === Number.POSITIVE_INFINITY || dueTs >= now) {
        assignments.push({
          courseName: course.name,
          courseId: course.id,
          title: item.title,
          id: item.id,
          dueDate: _formatDueDate(item.dueDate, item.dueTime),
          dueTimestamp: dueTs,
          alternateLink: item.alternateLink || '',
        });
      }
    }
  }

  assignments.sort((a, b) => a.dueTimestamp - b.dueTimestamp);
  return assignments;
}

module.exports = {
  getAuthenticatedClient,
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
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listCourses,
  listCoursework,
  listUpcomingAssignments,
};
