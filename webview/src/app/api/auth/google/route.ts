import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import { errorResponse } from '@/lib/html-response';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const state = searchParams.get('state');

    if (!state) {
        console.error('[Google Auth] Missing user state');
        return errorResponse('Missing user state', 'Please try linking your account again from the bot.', 400);
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Auth] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        return errorResponse(
            isConfigError ? 'Server Configuration Error' : 'Invalid Request',
            isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.',
            isConfigError ? 500 : 400
        );
    }

    try {
        const authUrl = getAuthUrl(state, url.origin);
        return NextResponse.redirect(authUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Google Auth] Setup incomplete:', message);
        console.error('[Google Auth] Error details:', error);
        return errorResponse('Setup Incomplete', `Could not initialize Google Auth: ${message}`, 500);
    }
}
