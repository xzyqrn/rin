import { google } from 'googleapis';

function resolveOAuthBaseUrl(baseUrlOverride?: string) {
    if (baseUrlOverride) return baseUrlOverride.replace(/\/+$/, '');

    // Canonical OAuth owner base URL in production.
    let baseUrl = process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
        if (process.env.NODE_ENV === 'development') {
            baseUrl = 'http://localhost:3000';
        }
    }
    if (!baseUrl) {
        throw new Error('GOOGLE_OAUTH_BASE_URL or NEXT_PUBLIC_BASE_URL must be set');
    }
    return baseUrl.replace(/\/+$/, '');
}

export function getOAuth2Client(baseUrlOverride?: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const baseUrl = resolveOAuthBaseUrl(baseUrlOverride);

    const redirectUri = `${baseUrl}/api/auth/google/callback`;

    if (!clientId || !clientSecret) {
        console.error('[Google OAuth] Missing credentials:', { 
            hasClientId: !!clientId, 
            hasClientSecret: !!clientSecret,
            availableEnvVars: Object.keys(process.env).filter(k => k.includes('GOOGLE'))
        });
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in environment variables');
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    return oauth2Client;
}

export function getAuthUrl(state: string, baseUrlOverride?: string) {
    const oauth2Client = getOAuth2Client(baseUrlOverride);
    const scopes = [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/classroom.courses.readonly',
        'https://www.googleapis.com/auth/classroom.coursework.me',
        'https://www.googleapis.com/auth/tasks'
    ];

    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: state // We can pass the userId here
    });
}
