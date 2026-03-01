import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import * as admin from 'firebase-admin';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        console.error('[Google Callback] Auth error:', error);
        return new NextResponse(`Auth error: ${error}`, { status: 400 });
    }
    if (!code || !state) {
        console.error('[Google Callback] Missing parameters:', { hasCode: !!code, hasState: !!state });
        return new NextResponse('Missing code or state', { status: 400 });
    }

    try {
        const oauth2Client = getOAuth2Client(url.origin);
        const { tokens } = await oauth2Client.getToken(code);

        if (!db) {
            console.error('[Google Callback] Firebase DB is not initialized! Could not save tokens.');
            return new NextResponse('Database not configured', { status: 500 });
        }

        const docRef = db.collection('users').doc(String(state)).collection('google_auth').doc('tokens');
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
        return new NextResponse(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Success</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
          <style>
            :root {
              --bg-color: #e6f8fa;
              --text-color: #333;
              --success-color: #4caf50;
              --btn-bg: #0088cc;
              --btn-hover: #0077b3;
              --btn-text: #ffffff;
            }
            @media (prefers-color-scheme: dark) {
              :root {
                --bg-color: #121212;
                --text-color: #e0e0e0;
                --success-color: #81c784;
                --btn-bg: #0277bd;
                --btn-hover: #01579b;
              }
            }
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background-color: var(--bg-color);
              color: var(--text-color);
              flex-direction: column;
              text-align: center;
              padding: 20px;
              box-sizing: border-box;
            }
            main {
              display: flex;
              flex-direction: column;
              align-items: center;
              max-width: 400px;
            }
            h2 {
              color: var(--success-color);
              margin-bottom: 10px;
            }
            p {
              margin: 5px 0;
              line-height: 1.5;
            }
            button {
              padding: 10px 20px;
              font-size: 16px;
              background-color: var(--btn-bg);
              color: var(--btn-text);
              border: none;
              border-radius: 5px;
              cursor: pointer;
              margin-top: 20px;
              transition: background-color 0.2s, outline 0.2s;
            }
            button:hover {
              background-color: var(--btn-hover);
            }
            button:focus-visible {
              outline: 3px solid var(--btn-bg);
              outline-offset: 3px;
            }
          </style>
        </head>
        <body>
          <main>
            <h2>✅ Google Account successfully linked!</h2>
            <p>Your tokens have been saved to the database.</p>
            <p>You can close this window and return to the bot. This window will close automatically.</p>
            <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window">Close App</button>
          </main>
          <script>
            setTimeout(() => {
              window.close();
              window.Telegram?.WebApp?.close?.();
            }, 3000);
          </script>
        </body>
      </html>
    `, {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
        });
    } catch (err) {
        console.error('[Google Callback] Error in google callback:', err);
        console.error('[Google Callback] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        return new NextResponse('Internal Server Error during authorization.', { status: 500 });
    }
}
