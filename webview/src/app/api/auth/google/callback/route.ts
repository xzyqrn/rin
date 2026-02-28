import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';
import { db } from '@/lib/firebase';
import * as admin from 'firebase-admin';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        return new NextResponse(`Auth error: ${error}`, { status: 400 });
    }
    if (!code || !state) {
        return new NextResponse('Missing code or state', { status: 400 });
    }

    try {
        const oauth2Client = getOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);

        // Save to Firebase
        if (db) {
            const docRef = db.collection('google_auth').doc(String(state));
            const updateData: any = {
                access_token: tokens.access_token || '',
                expiry_date: tokens.expiry_date || 0,
                updated_at: admin.firestore.FieldValue.serverTimestamp()
            };

            if (tokens.refresh_token) {
                updateData.refresh_token = tokens.refresh_token;
            }

            await docRef.set(updateData, { merge: true });
        } else {
            console.error('Firebase DB is not initialized! Could not save tokens.');
        }

        // After success, we can redirect back to Telegram or show a success page
        // Using a telegram deep link to close the web app:
        return new NextResponse(`
      <html>
        <head>
          <title>Success</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #p6f8fa; flex-direction: column;">
          <h2 style="color: #4caf50;">✅ Google Account successfully linked!</h2>
          <p>You can close this window and return to the bot.</p>
          <button onclick="Telegram.WebApp.close()" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px;">Close App</button>
        </body>
      </html>
    `, {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
        });
    } catch (err) {
        console.error('[webhook] Error in google callback:', err);
        return new NextResponse('Internal Server Error during authorization.', { status: 500 });
    }
}
