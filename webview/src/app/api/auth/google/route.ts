import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const { searchParams } = url;
    const state = searchParams.get('state');

    if (!state) {
        console.error('[Google Auth] Missing user state');
        return new NextResponse('Missing user state', { status: 400 });
    }

    try {
        const authUrl = getAuthUrl(state, url.origin);
        return NextResponse.redirect(authUrl);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error('[Google Auth] Setup incomplete:', error.message);
        console.error('[Google Auth] Error details:', error);
        return new NextResponse(`Setup incomplete: ${error.message}`, { status: 500 });
    }
}
