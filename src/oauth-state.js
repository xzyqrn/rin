'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_AGE_SECONDS = Math.max(
  60,
  Number(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS || 900)
);

function _base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function _base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _getSecret(explicitSecret) {
  const secret = explicitSecret || process.env.GOOGLE_OAUTH_STATE_SECRET || '';
  if (!secret) {
    throw new Error('GOOGLE_OAUTH_STATE_SECRET is not configured.');
  }
  return secret;
}

function _signPayload(payloadEncoded, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payloadEncoded)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function _safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createSignedOAuthState(userId, opts = {}) {
  const secret = _getSecret(opts.secret);
  const nowSec = Math.floor((opts.nowMs || Date.now()) / 1000);
  const maxAgeSeconds = Math.max(60, Number(opts.maxAgeSeconds || DEFAULT_MAX_AGE_SECONDS));

  const normalizedUserId = String(userId || '').trim();
  if (!/^\d{5,20}$/.test(normalizedUserId)) {
    throw new Error('Invalid user id for OAuth state.');
  }

  const payload = {
    uid: normalizedUserId,
    iat: nowSec,
    exp: nowSec + maxAgeSeconds,
    nonce: crypto.randomBytes(12).toString('hex'),
  };

  const payloadEncoded = _base64UrlEncode(JSON.stringify(payload));
  const sigEncoded = _signPayload(payloadEncoded, secret);
  return `${payloadEncoded}.${sigEncoded}`;
}

function verifySignedOAuthState(stateToken, opts = {}) {
  try {
    const secret = _getSecret(opts.secret);
    const token = String(stateToken || '').trim();
    if (!token || !token.includes('.')) {
      return { ok: false, error: 'Malformed OAuth state.' };
    }

    const [payloadEncoded, sigEncoded, ...rest] = token.split('.');
    if (!payloadEncoded || !sigEncoded || rest.length > 0) {
      return { ok: false, error: 'Malformed OAuth state.' };
    }

    const expectedSig = _signPayload(payloadEncoded, secret);
    if (!_safeEqual(sigEncoded, expectedSig)) {
      return { ok: false, error: 'Invalid OAuth state signature.' };
    }

    const payloadRaw = _base64UrlDecode(payloadEncoded);
    const payload = JSON.parse(payloadRaw);

    const uid = String(payload.uid || '').trim();
    if (!/^\d{5,20}$/.test(uid)) {
      return { ok: false, error: 'Invalid OAuth state payload.' };
    }

    const nowSec = Math.floor((opts.nowMs || Date.now()) / 1000);
    const exp = Number(payload.exp || 0);
    const iat = Number(payload.iat || 0);
    if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp <= iat) {
      return { ok: false, error: 'Invalid OAuth state timestamps.' };
    }

    if (nowSec > exp) {
      return { ok: false, error: 'OAuth state has expired.' };
    }

    // Reject far-future tokens if the clock is skewed or payload is forged.
    if (iat > nowSec + 300) {
      return { ok: false, error: 'OAuth state issued_at is invalid.' };
    }

    return { ok: true, userId: uid, payload };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to verify OAuth state.' };
  }
}

module.exports = {
  createSignedOAuthState,
  verifySignedOAuthState,
};
