const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../src/capabilities/web');

test('isPrivateIp blocks private and loopback ranges', () => {
  assert.equal(_internals.isPrivateIp('127.0.0.1'), true);
  assert.equal(_internals.isPrivateIp('10.20.30.40'), true);
  assert.equal(_internals.isPrivateIp('192.168.1.10'), true);
  assert.equal(_internals.isPrivateIp('8.8.8.8'), false);
});

test('isDisallowedHostname blocks localhost-style names', () => {
  assert.equal(_internals.isDisallowedHostname('localhost'), true);
  assert.equal(_internals.isDisallowedHostname('api.localhost'), true);
  assert.equal(_internals.isDisallowedHostname('printer.local'), true);
  assert.equal(_internals.isDisallowedHostname('example.com'), false);
});

test('validateOutgoingUrl rejects local hosts and unsupported protocols', async () => {
  const localResult = await _internals.validateOutgoingUrl('http://localhost:8080/status');
  assert.equal(localResult.ok, false);

  const fileResult = await _internals.validateOutgoingUrl('file:///etc/passwd');
  assert.equal(fileResult.ok, false);
  assert.match(fileResult.error, /unsupported protocol/i);
});
