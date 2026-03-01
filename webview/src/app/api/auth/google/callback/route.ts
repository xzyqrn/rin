import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import * as admin from 'firebase-admin';

// Simple HTML escape function to prevent XSS
function escapeHtml(unsafe: string): string {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

const HTML_TEMPLATE = `
<html>
<head>
    <title>__TITLE__</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: __BG_COLOR__; flex-direction: column; text-align: center; padding: 20px;">
    <h2 style="color: __COLOR__;">__ICON__ __TITLE__</h2>
    <p>__MESSAGE__</p>
    <p>You can close this window and return to the bot.</p>
    <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
    __AUTO_CLOSE_SCRIPT__
</body>
</html>
`;

function renderHtml(title: string, message: string, isError: boolean, status: number) {
    const color = isError ? '#f44336' : '#4caf50';
    const bgColor = isError ? '#ffebee' : '#e6f8fa';
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const icon = isError ? '❌' : '✅';

    // Auto-close only on success
    const autoCloseScript = isError ? '' : `
          <script>
            setTimeout(() => {
              window.close();
              window.Telegram?.WebApp?.close?.();
            }, 3000);
          </script>
    `;

    const html = HTML_TEMPLATE
        .replace(/__TITLE__/g, safeTitle)
        .replace(/__BG_COLOR__/g, bgColor)
        .replace(/__COLOR__/g, color)
        .replace(/__ICON__/g, icon)
        .replace(/__MESSAGE__/g, safeMessage)
        .replace(/__AUTO_CLOSE_SCRIPT__/g, autoCloseScript);

    return new NextResponse(html, {
        status,
        headers: { 'Content-Type': 'text/html' }
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveTokensToDb(userId: string, tokens: any) {
    const docRef = db!.collection('users').doc(userId).collection('google_auth').doc('tokens');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    };

    if (tokens.access_token) updateData.access_token = tokens.access_token;
    if (typeof tokens.expiry_date === 'number') updateData.expiry_date = tokens.expiry_date;
    if (tokens.refresh_token) updateData.refresh_token = tokens.refresh_token;
    if (tokens.scope) updateData.scope = tokens.scope;
    if (tokens.token_type) updateData.token_type = tokens.token_type;

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
        return renderHtml('Authentication Failed', `Auth error: ${error}`, true, 400);
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return renderHtml('Authentication Failed', 'Missing code or state', true, 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Callback] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        return renderHtml(
            isConfigError ? 'Configuration Error' : 'Invalid Request',
            isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.',
            true,
            isConfigError ? 500 : 400
        );
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        if (!db) {
            console.error('[Google Callback] Firebase DB is not initialized! Could not save tokens.');
            return renderHtml('Database Error', 'Database not configured', true, 500);
        }

        await saveTokensToDb(stateCheck.userId, tokens);

        // Verify the save worked
        const savedDoc = await db.collection('users').doc(stateCheck.userId).collection('google_auth').doc('tokens').get();
        if (savedDoc.exists) {
            const savedData = savedDoc.data();
            if (!savedData || typeof savedData !== 'object') {
                console.error('[Google Callback] Verification - Document data is undefined or not an object');
            }
        } else {
            console.error('[Google Callback] Verification - Document not found after save!');
        }

        // After success, we can redirect back to Telegram or show a success page
        return renderHtml('Google Account successfully linked!', 'Your tokens have been saved to the database. This window will close automatically.', false, 200);
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return renderHtml('Server Error', 'Internal Server Error during authorization.', true, 500);
    }
}
