'use strict';

const { google } = require('googleapis');
const { getGoogleTokens, saveGoogleTokens } = require('../database');

function getOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.WEBHOOK_BASE_URL}/auth/google/callback`;

    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env');
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuthUrl(state) {
    const oauth2Client = getOAuth2Client();
    const scopes = [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/classroom.courses.readonly',
        'https://www.googleapis.com/auth/classroom.coursework.me',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/keep'
    ];

    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: state // We can pass the userId here
    });
}

async function handleCallback(db, code, userId) {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    const saved = await saveGoogleTokens(db, userId, tokens);
    
    if (!saved) {
        console.error(`[google] Failed to save tokens for user ${userId} to database`);
        throw new Error('Failed to save Google tokens to database');
    }
    return tokens;
}

async function getAuthenticatedClient(db, userId) {
    const tokens = await getGoogleTokens(db, userId);
    if (!tokens || !tokens.access_token) {
        throw new Error('User not authenticated with Google. Run /linkgoogle first.');
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);

    // Handle automatic refreshing
    oauth2Client.on('tokens', (newTokens) => {
        saveGoogleTokens(db, userId, newTokens).catch(console.error);
    });

    return oauth2Client;
}

// ── Drive ────────────────────────────────────────────────────────────────────
async function listDriveFiles(db, userId, maxResults = 10) {
    const auth = await getAuthenticatedClient(db, userId);
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
        pageSize: maxResults,
        fields: 'nextPageToken, files(id, name)',
    });
    return res.data.files;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function listEvents(db, userId, maxResults = 10) {
    const auth = await getAuthenticatedClient(db, userId);
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date().toISOString(),
        maxResults: maxResults,
        singleEvents: true,
        orderBy: 'startTime',
    });
    return res.data.items;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
async function listUnreadEmails(db, userId, maxResults = 10) {
    const auth = await getAuthenticatedClient(db, userId);
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: maxResults
    });
    const messages = res.data.messages || [];
    const emails = [];
    for (const msg of messages) {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
        emails.push(detail.data);
    }
    return emails;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
async function listTasks(db, userId) {
    const auth = await getAuthenticatedClient(db, userId);
    const tasksService = google.tasks({ version: 'v1', auth });
    const res = await tasksService.tasks.list({
        tasklist: '@default'
    });
    return res.data.items || [];
}

// ── Classroom ───────────────────────────────────────────────────────────────────
async function listCourses(db, userId) {
    const auth = await getAuthenticatedClient(db, userId);
    const classroom = google.classroom({ version: 'v1', auth });
    const res = await classroom.courses.list({
        pageSize: 10
    });
    return res.data.courses || [];
}

async function listCoursework(db, userId, courseId) {
    const auth = await getAuthenticatedClient(db, userId);
    const classroom = google.classroom({ version: 'v1', auth });
    const res = await classroom.courses.courseWork.list({
        courseId: courseId,
        pageSize: 10
    });
    return res.data.courseWork || [];
}

// ── Keep ─────────────────────────────────────────────────────────────────────
// NOTE: Google Keep API is typically only available for Enterprise users.
// We'll define a placeholder that tries to call the API but will likely fail for consumer users.
async function listKeepNotes(db, userId) {
    const auth = await getAuthenticatedClient(db, userId);
    const keep = google.keep({ version: 'v1', auth });
    const res = await keep.notes.list();
    return res.data.notes || [];
}

module.exports = {
    getAuthUrl,
    handleCallback,
    getAuthenticatedClient,
    listDriveFiles,
    listEvents,
    listUnreadEmails,
    listTasks,
    listCourses,
    listCoursework,
    listKeepNotes
};
