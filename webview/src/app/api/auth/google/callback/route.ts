import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import * as admin from 'firebase-admin';
import { htmlResponse } from '@/lib/html-response';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveTokensToDatabase(userId: string, tokens: any) {
    if (!db) {
        throw new Error('Database not configured');
    }

    const docRef = db.collection('users').doc(userId).collection('google_auth').doc('tokens');

    // Construct the update object cleanly without multiple if statements
    const updateData = {
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        ...(tokens.access_token && { access_token: tokens.access_token }),
        ...(typeof tokens.expiry_date === 'number' && { expiry_date: tokens.expiry_date }),
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        ...(tokens.scope && { scope: tokens.scope }),
        ...(tokens.token_type && { token_type: tokens.token_type })
    };

    await docRef.set(updateData, { merge: true });
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return htmlResponse('Auth Error', `Authentication Error`, error, 400);
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return htmlResponse('Missing Parameters', 'Missing required parameters', 'Missing code or state', 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        return htmlResponse(
            'Invalid State',
            isConfigError ? 'OAuth Verification Not Configured' : 'Invalid or Expired OAuth State',
            isConfigError ? 'OAuth state verification is not configured on the server.' : 'Please run /linkgoogle again in the bot.',
            isConfigError ? 500 : 400
        );
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        try {
            await saveTokensToDatabase(stateCheck.userId, tokens);
        } catch (dbError) {
            console.error('[Google Callback] Firebase DB Error:', dbError);
            return htmlResponse('Database Error', 'Database Not Configured', 'Could not save tokens.', 500);
        }

        // After success, we show a styled success page with a Close button
        return htmlResponse(
            'Success',
            'Google Account successfully linked!',
            'Your tokens have been saved to the database. This window will close automatically.',
            200
        );
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return htmlResponse('Server Error', 'Internal Server Error', 'An error occurred during authorization.', 500);
    }
}
