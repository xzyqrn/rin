import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_MAX_AGE_SECONDS = Math.max(
  60,
  Number(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS || 900)
);

type OAuthStatePayload = {
  uid: string;
  iat: number;
  exp: number;
  nonce: string;
};

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getSecret(): string {
  const secret = process.env.GOOGLE_OAUTH_STATE_SECRET || '';
  if (!secret) {
    throw new Error('GOOGLE_OAUTH_STATE_SECRET is not configured.');
  }
  return secret;
}

function signPayload(payloadEncoded: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(payloadEncoded)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifySignedOAuthState(stateToken: string, nowMs = Date.now()) {
  try {
    const secret = getSecret();
    const token = String(stateToken || '').trim();
    if (!token || !token.includes('.')) {
      return { ok: false as const, error: 'Malformed OAuth state.' };
    }

    const [payloadEncoded, signature, ...rest] = token.split('.');
    if (!payloadEncoded || !signature || rest.length > 0) {
      return { ok: false as const, error: 'Malformed OAuth state.' };
    }

    const expectedSignature = signPayload(payloadEncoded, secret);
    if (!safeEqual(signature, expectedSignature)) {
      return { ok: false as const, error: 'Invalid OAuth state signature.' };
    }

    const payload = JSON.parse(base64UrlDecode(payloadEncoded)) as OAuthStatePayload;
    const userId = String(payload.uid || '').trim();
    if (!/^\d{5,20}$/.test(userId)) {
      return { ok: false as const, error: 'Invalid OAuth state payload.' };
    }

    const nowSec = Math.floor(nowMs / 1000);
    const iat = Number(payload.iat || 0);
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) {
      return { ok: false as const, error: 'Invalid OAuth state timestamps.' };
    }
    if (exp - iat > DEFAULT_MAX_AGE_SECONDS + 60) {
      return { ok: false as const, error: 'OAuth state TTL is invalid.' };
    }
    if (iat > nowSec + 300) {
      return { ok: false as const, error: 'OAuth state issued_at is invalid.' };
    }
    if (nowSec > exp) {
      return { ok: false as const, error: 'OAuth state has expired.' };
    }

    return { ok: true as const, userId };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'Failed to verify OAuth state.' };
  }
}
