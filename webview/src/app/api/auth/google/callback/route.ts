import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import * as admin from 'firebase-admin';

function renderHtml(title: string, messageHtml: string, isError: boolean = false, status: number = 200) {
    const bgColor = isError ? '#ffebee' : '#e6f8fa';
    const html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${title}</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: ${bgColor}; flex-direction: column; text-align: center; padding: 20px;">
          ${messageHtml}
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
          ${!isError ? `
          <script>
            setTimeout(() => {
              window.close();
              window.Telegram?.WebApp?.close?.();
            }, 3000);
          </script>` : ''}
        </body>
      </html>
    `;
    return new NextResponse(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return renderHtml('Auth Error', `
            <h2 style="color: #d32f2f;">❌ Authentication Error</h2>
            <p>We couldn't link your account.</p>
            <p style="color: #555; font-size: 14px;">Reason: ${escapeHtml(error)}</p>
        `, true, 400);
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return renderHtml('Missing Parameters', `
            <h2 style="color: #d32f2f;">❌ Missing Parameters</h2>
            <p>The authorization request is missing required parameters.</p>
            <p>Please try linking your account again using /linkgoogle.</p>
        `, true, 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        const message = isConfigError
            ? 'OAuth state verification is not configured on the server.'
            : 'Invalid or expired OAuth state. Please run /linkgoogle again.';
        return renderHtml('Verification Failed', `
            <h2 style="color: #d32f2f;">❌ Verification Failed</h2>
            <p>${escapeHtml(message)}</p>
        `, true, isConfigError ? 500 : 400);
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        if (!db) {
            console.error('[Google Callback] Firebase DB is not initialized! Could not save tokens.');
            return renderHtml('Database Error', `
                <h2 style="color: #d32f2f;">❌ Database Error</h2>
                <p>Database not configured. Could not save your tokens.</p>
                <p>Please contact the administrator.</p>
            `, true, 500);
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
        return renderHtml('Success', `
            <h2 style="color: #4caf50;">✅ Google Account successfully linked!</h2>
            <p>Your tokens have been saved to the database.</p>
            <p>You can close this window and return to the bot. This window will close automatically.</p>
        `);
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return renderHtml('Internal Server Error', `
            <h2 style="color: #d32f2f;">❌ Internal Server Error</h2>
            <p>An error occurred during authorization.</p>
            <p>Please try again later or contact support if the issue persists.</p>
        `, true, 500);
    }
}
