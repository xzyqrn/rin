import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import { successResponse, errorResponse } from '@/lib/html-response';
import * as admin from 'firebase-admin';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveTokensToDatabase(userId: string, tokens: any) {
    if (!db) {
        throw new Error('Firebase DB is not initialized! Could not save tokens.');
    }

    const docRef = db.collection('users').doc(userId).collection('google_auth').doc('tokens');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        ...(tokens.access_token && { access_token: tokens.access_token }),
        ...(typeof tokens.expiry_date === 'number' && { expiry_date: tokens.expiry_date }),
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        ...(tokens.scope && { scope: tokens.scope }),
        ...(tokens.token_type && { token_type: tokens.token_type }),
    };

    await docRef.set(updateData, { merge: true });

    // Verify the save worked
    const savedDoc = await docRef.get();
    if (!savedDoc.exists) {
        console.error('[Google Callback] Verification - Document not found after save!');
    } else if (!savedDoc.data() || typeof savedDoc.data() !== 'object') {
        console.error('[Google Callback] Verification - Document data is undefined or not an object');
    }
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return errorResponse('Authentication Error', `Google returned an error: ${error}`, 400);
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return errorResponse('Missing Parameters', 'Missing code or state from Google.', 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        return errorResponse(
            isConfigError ? 'Server Configuration Error' : 'Invalid Request',
            isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.',
            isConfigError ? 500 : 400
        );
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        await saveTokensToDatabase(stateCheck.userId, tokens);

        // After success, we can redirect back to Telegram or show a success page
        // Using a telegram deep link to close the web app:
        return successResponse('✅ Google Account successfully linked!', 'Your tokens have been saved to the database.');
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');

        if (err instanceof Error && err.message.includes('Firebase DB is not initialized')) {
            return errorResponse('Database Error', 'Database is not configured to save tokens.', 500);
        }

        return errorResponse('Authorization Failed', 'Internal Server Error during authorization.', 500);
    }
}
