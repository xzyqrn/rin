import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get('state');

    if (!state) {
        return new NextResponse('Missing user state', { status: 400 });
    }

    try {
        const url = getAuthUrl(state);
        return NextResponse.redirect(url);
    } catch (error: any) {
        return new NextResponse(`Setup incomplete: ${error.message}`, { status: 500 });
    }
}
