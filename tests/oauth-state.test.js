const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSignedOAuthState,
  verifySignedOAuthState,
} = require('../src/oauth-state');

test('oauth state roundtrip validates and returns user id', () => {
  const secret = 'test-secret-value';
  const token = createSignedOAuthState('123456789', { secret, nowMs: 1_700_000_000_000, maxAgeSeconds: 900 });
  const verified = verifySignedOAuthState(token, { secret, nowMs: 1_700_000_100_000 });

  assert.equal(verified.ok, true);
  assert.equal(verified.userId, '123456789');
});

test('oauth state rejects tampered token', () => {
  const secret = 'test-secret-value';
  const token = createSignedOAuthState('123456789', { secret });
  const parts = token.split('.');
  const tampered = `${parts[0]}.invalidsignature`;
  const verified = verifySignedOAuthState(tampered, { secret });

  assert.equal(verified.ok, false);
  assert.match(verified.error, /signature/i);
});

test('oauth state rejects expired token', () => {
  const secret = 'test-secret-value';
  const issuedAtMs = 1_700_000_000_000;
  const token = createSignedOAuthState('123456789', { secret, nowMs: issuedAtMs, maxAgeSeconds: 60 });
  const verified = verifySignedOAuthState(token, { secret, nowMs: issuedAtMs + 120_000 });

  assert.equal(verified.ok, false);
  assert.match(verified.error, /expired/i);
});
