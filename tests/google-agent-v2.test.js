const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_AGENT_V2 = '1';

const {
  normalizeGoogleScopes,
  getGoogleScopeStatusFromTokens,
  categorizeGoogleError,
} = require('../src/capabilities/google');
const { buildTools } = require('../src/tools');

test('normalizeGoogleScopes deduplicates and sorts', () => {
  const scopes = normalizeGoogleScopes('b a a c');
  assert.deepEqual(scopes, ['a', 'b', 'c']);
});

test('getGoogleScopeStatusFromTokens marks missing scopes', () => {
  const scopeStatus = getGoogleScopeStatusFromTokens({
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive',
  });

  assert.equal(scopeStatus.checks.gmail_inbox_read.granted, true);
  assert.equal(scopeStatus.checks.gmail_send.granted, false);
  assert(scopeStatus.checks.gmail_send.missing.includes('https://www.googleapis.com/auth/gmail.send'));
});

test('categorizeGoogleError classifies insufficient scope', () => {
  const details = categorizeGoogleError({
    response: { status: 403 },
    message: 'Request had insufficient authentication scopes.',
  });
  assert.equal(details.category, 'insufficient_scope');
});

test('buildTools exposes google scope diagnostics and Gmail action tools when linked', async () => {
  const unlinked = buildTools(null, 42, { admin: false, hasGoogleAuth: false });
  const unlinkedNames = unlinked.definitions.map((d) => d.function.name);
  assert(unlinkedNames.includes('google_capabilities'));
  assert(unlinkedNames.includes('google_auth_status'));
  assert(unlinkedNames.includes('google_scope_status'));
  assert(!unlinkedNames.includes('gmail_send'));

  const linked = buildTools(null, 42, { admin: false, hasGoogleAuth: true });
  const linkedNames = linked.definitions.map((d) => d.function.name);
  assert(linkedNames.includes('gmail_send'));
  assert(linkedNames.includes('gmail_reply'));
  assert(linkedNames.includes('gmail_draft_create'));
  assert(linkedNames.includes('gmail_label_add'));
  assert(linkedNames.includes('gmail_mark_read'));

  const capabilitiesJson = await linked.executor('google_capabilities', {});
  const parsed = JSON.parse(capabilitiesJson);
  assert.equal(parsed.schema_version, 'google_capabilities.v1');
  assert.equal(parsed.services.drive.create_folder, true);
  assert.deepEqual(parsed.out_of_scope, ['docs_api', 'sheets_api']);
});
