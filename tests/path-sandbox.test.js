const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTools } = require('../src/tools');
const { UPLOADS_DIR } = require('../src/capabilities/uploads');

function cleanupPath(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for tests.
  }
}

function createTestUserId() {
  return Number(`9${crypto.randomInt(10000000, 99999999)}`);
}

test('non-admin read_file denies directory traversal', async () => {
  const userId = createTestUserId();
  const userDir = path.join(UPLOADS_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const tools = buildTools(null, userId, { admin: false, hasGoogleAuth: false });
  const result = await tools.executor('read_file', { path: '../outside.txt' });
  assert.match(result, /access denied/i);
  cleanupPath(userDir);
});

test('non-admin read_file denies symlink escape', async (t) => {
  const userId = createTestUserId();
  const userDir = path.join(UPLOADS_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-sandbox-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'top-secret', 'utf8');

  const linkPath = path.join(userDir, 'escape-link.txt');
  fs.symlinkSync(outsideFile, linkPath);

  t.after(() => cleanupPath(outsideDir));
  t.after(() => cleanupPath(linkPath));
  t.after(() => cleanupPath(userDir));

  const tools = buildTools(null, userId, { admin: false, hasGoogleAuth: false });
  const result = await tools.executor('read_file', { path: 'escape-link.txt' });
  assert.match(result, /access denied/i);
});

test('non-admin write_file and read_file work within user directory', async (t) => {
  const userId = createTestUserId();
  const userDir = path.join(UPLOADS_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const tools = buildTools(null, userId, { admin: false, hasGoogleAuth: false });
  const fileName = 'safe-note.txt';
  const content = 'hello sandbox';

  t.after(() => cleanupPath(path.join(userDir, fileName)));
  t.after(() => cleanupPath(userDir));

  const writeResult = await tools.executor('write_file', { path: fileName, content });
  assert.match(writeResult, /written/i);

  const readResult = await tools.executor('read_file', { path: fileName });
  assert.equal(readResult, content);
});
