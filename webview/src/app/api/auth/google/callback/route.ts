import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import * as admin from 'firebase-admin';

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderHtmlError(message: string, statusCode: number): NextResponse {
    const safeMessage = escapeHtml(message);
    const html = `
      <html>
        <head>
          <title>Error</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff0f0; flex-direction: column;">
          <h2 style="color: #d32f2f;">❌ Authentication Error</h2>
          <p style="color: #333; font-weight: bold; text-align: center; max-width: 80%;">${safeMessage}</p>
          <p>You can close this window and try again. This window will close automatically.</p>
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
          <script>
            setTimeout(() => {
              window.close();
              window.Telegram?.WebApp?.close?.();
            }, 5000);
          </script>
        </body>
      </html>
    `;
    return new NextResponse(html, {
        status: statusCode,
        headers: { 'Content-Type': 'text/html' }
    });
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return renderHtmlError(`Auth error: ${error}`, 400);
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return renderHtmlError('Missing code or state', 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error || '');
        return renderHtmlError(
            isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.',
            isConfigError ? 500 : 400
        );
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        if (!db) {
            console.error('[Google Callback] Firebase DB is not initialized! Could not save tokens.');
            return renderHtmlError('Database not configured', 500);
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
        return new NextResponse(SUCCESS_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
        });
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return renderHtmlError('Internal Server Error during authorization.', 500);
    }
}
