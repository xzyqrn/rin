import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import { renderHtml } from '@/lib/html-template';
import * as admin from 'firebase-admin';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return new NextResponse(
            renderHtml(true, 'Authentication Error', `Auth error: ${error}`),
            { status: 400, headers: { 'Content-Type': 'text/html' } }
        );
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return new NextResponse(
            renderHtml(true, 'Missing Parameters', 'Missing code or state in the callback.'),
            { status: 400, headers: { 'Content-Type': 'text/html' } }
        );
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        const errorMessage = isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.';
        return new NextResponse(
            renderHtml(true, 'Invalid State', errorMessage),
            { status: isConfigError ? 500 : 400, headers: { 'Content-Type': 'text/html' } }
        );
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        if (!db) {
            console.error('[Google Callback] Firebase DB is not initialized! Could not save tokens.');
            return new NextResponse(
                renderHtml(true, 'Database Error', 'Database not configured. Could not save tokens.'),
                { status: 500, headers: { 'Content-Type': 'text/html' } }
            );
        }

        const docRef = db.collection('users').doc(stateCheck.userId).collection('google_auth').doc('tokens');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updateData: any = {
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        };

        if (tokens.access_token) {
            updateData.access_token = tokens.access_token;
        }
        if (typeof tokens.expiry_date === 'number') {
            updateData.expiry_date = tokens.expiry_date;
        }
        if (tokens.refresh_token) {
            updateData.refresh_token = tokens.refresh_token;
        }
        if (tokens.scope) {
            updateData.scope = tokens.scope;
        }
        if (tokens.token_type) {
            updateData.token_type = tokens.token_type;
        }

        await docRef.set(updateData, { merge: true });

        // Verify the save worked
        const savedDoc = await docRef.get();
        if (savedDoc.exists) {
            const savedData = savedDoc.data();
            if (savedData && typeof savedData === 'object') {
            } else {
                console.error('[Google Callback] Verification - Document data is undefined or not an object');
            }
        } else {
            console.error('[Google Callback] Verification - Document not found after save!');
        }

        // After success, we can redirect back to Telegram or show a success page
        // Using a telegram deep link to close the web app:
        return new NextResponse(
            renderHtml(false, 'Google Account Linked', 'Your Google account has been successfully linked and your tokens have been saved.'),
            { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return new NextResponse(
            renderHtml(true, 'Internal Error', 'Internal Server Error during authorization.'),
            { status: 500, headers: { 'Content-Type': 'text/html' } }
        );
    }
}
