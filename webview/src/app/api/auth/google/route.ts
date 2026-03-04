import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google';
import { verifySignedOAuthState } from '@/lib/oauth-state';
import { renderHtml } from '@/lib/html-template';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const state = searchParams.get('state');

    if (!state) {
        console.error('[Google Auth] Missing user state');
        return new NextResponse(
            renderHtml(true, 'Missing State', 'Missing user state parameter. Please run /linkgoogle in Telegram to get a valid link.'),
            { status: 400, headers: { 'Content-Type': 'text/html' } }
        );
    }

    const stateCheck = verifySignedOAuthState(state);
    if (!stateCheck.ok) {
        console.error('[Google Auth] Invalid OAuth state:', stateCheck.error);
        const isConfigError = /not configured/i.test(stateCheck.error);
        const errorMessage = isConfigError ? 'OAuth state verification is not configured on the server.' : 'Invalid or expired OAuth state. Please run /linkgoogle again.';
        return new NextResponse(
            renderHtml(true, 'Invalid State', errorMessage),
            { status: isConfigError ? 500 : 400, headers: { 'Content-Type': 'text/html' } }
        );
    }

    try {
        const authUrl = getAuthUrl(state, url.origin);
        return NextResponse.redirect(authUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Google Auth] Setup incomplete:', message);
        console.error('[Google Auth] Error details:', error);
        return new NextResponse(
            renderHtml(true, 'Setup Incomplete', `Setup incomplete: ${message}`),
            { status: 500, headers: { 'Content-Type': 'text/html' } }
        );
    }
}
