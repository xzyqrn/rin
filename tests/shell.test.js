const test = require('node:test');
const assert = require('node:assert/strict');

const { runCommand } = require('../src/shell');

test('runCommand blocks denied commands', async () => {
  const result = await runCommand('rm -rf /var/data');
  assert.equal(result.success, false);
  assert.match(result.output, /blocked by security policy/i);
});

test('runCommand blocks mkfs', async () => {
  const result = await runCommand('mkfs /dev/sda');
  assert.equal(result.success, false);
  assert.match(result.output, /blocked by security policy/i);
});

test('runCommand blocks dd if=', async () => {
  const result = await runCommand('dd if=/dev/zero of=/dev/sda');
  assert.equal(result.success, false);
  assert.match(result.output, /blocked by security policy/i);
});

test('runCommand executes safe commands', async () => {
  const result = await runCommand('echo hello');
  assert.equal(result.success, true);
  assert.match(result.output, /hello/);
});

test('runCommand truncates long output with TRUNCATED marker', async () => {
  // Generate output longer than 3500 chars
  const result = await runCommand('python3 -c "print(\'A\' * 5000)"');
  assert.equal(result.success, true);
  assert.ok(result.output.length <= 3600); // truncated + marker
  assert.match(result.output, /TRUNCATED/);
});

test('runCommand handles command timeout', async () => {
  const result = await runCommand('sleep 10', 500);
  assert.equal(result.success, false);
  assert.match(result.output, /timed out/i);
});

test('runCommand reports exit code on failure', async () => {
  const result = await runCommand('exit 42');
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 42);
});
