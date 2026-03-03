const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/logger');

test('logger exports info, warn, error functions', () => {
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
});

test('logger exports pino instance', () => {
  assert.ok(logger.logger);
  assert.equal(typeof logger.logger.info, 'function');
  assert.equal(typeof logger.logger.warn, 'function');
  assert.equal(typeof logger.logger.error, 'function');
  assert.equal(typeof logger.logger.debug, 'function');
});

test('logger.info does not throw', () => {
  assert.doesNotThrow(() => logger.info('test-module', 'info message'));
});

test('logger.warn does not throw', () => {
  assert.doesNotThrow(() => logger.warn('test-module', 'warning message'));
});

test('logger.error does not throw', () => {
  assert.doesNotThrow(() => logger.error('test-module', 'error message'));
});
