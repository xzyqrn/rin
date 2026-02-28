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
async function listDriveFiles(db, userId, maxResults = 10, query = '') {
    const auth = await getAuthenticatedClient(db, userId);
    const drive = google.drive({ version: 'v3', auth });
    const params = {
        pageSize: maxResults,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
    };
    if (query) params.q = `name contains '${query.replace(/'/g, "\\'")}'`;
    const res = await drive.files.list(params);
    return res.data.files;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function listEvents(db, userId, maxResults = 10, days = 7) {
    const auth = await getAuthenticatedClient(db, userId);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const timeMax = new Date(now.getTime() + Math.min(days, 90) * 24 * 60 * 60 * 1000).toISOString();
    const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax,
        maxResults: maxResults,
        singleEvents: true,
        orderBy: 'startTime',
    });
    return res.data.items;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
async function listUnreadEmails(db, userId, maxResults = 10, query = '') {
    const auth = await getAuthenticatedClient(db, userId);
    const gmail = google.gmail({ version: 'v1', auth });
    const q = ['is:unread', query].filter(Boolean).join(' ');
    const res = await gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: maxResults
    });
    const messages = res.data.messages || [];
    // Fetch all message metadata in parallel instead of sequentially
    const emails = await Promise.all(
        messages.map(msg =>
            gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'Date'],
            }).then(r => r.data)
        )
    );
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

// ── Classroom (combined) ───────────────────────────────────────────────────────
// Fetches all courses + their upcoming published assignments in a single call.
async function listUpcomingAssignments(db, userId) {
    const auth = await getAuthenticatedClient(db, userId);
    const classroom = google.classroom({ version: 'v1', auth });

    const coursesRes = await classroom.courses.list({ pageSize: 20 });
    const courses = coursesRes.data.courses || [];
    if (!courses.length) return [];

    const now = new Date();

    // Fetch coursework for all courses in parallel
    const courseworkResults = await Promise.all(
        courses.map(course =>
            classroom.courses.courseWork.list({
                courseId: course.id,
                courseWorkStates: ['PUBLISHED'],
                pageSize: 20,
            }).then(res => ({ course, work: res.data.courseWork || [] }))
              .catch(() => ({ course, work: [] })) // Skip courses with access errors
        )
    );

    const assignments = [];
    for (const { course, work } of courseworkResults) {
        for (const item of work) {
            // Build due date if present
            let dueDate = null;
            if (item.dueDate) {
                const { year, month, day } = item.dueDate;
                dueDate = new Date(year, month - 1, day);
            }
            // Only include upcoming or undated assignments
            if (!dueDate || dueDate >= now) {
                assignments.push({
                    courseName: course.name,
                    courseId: course.id,
                    title: item.title,
                    id: item.id,
                    dueDate: item.dueDate ? `${item.dueDate.year}-${String(item.dueDate.month).padStart(2,'0')}-${String(item.dueDate.day).padStart(2,'0')}` : null,
                });
            }
        }
    }

    // Sort by due date ascending (undated last)
    assignments.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
    });

    return assignments;
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
    listUpcomingAssignments,
};
