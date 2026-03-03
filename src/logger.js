'use strict';

const pino = require('pino');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const logger = pino({
  level: LOG_LEVEL,
  ...(process.env.NODE_ENV !== 'production' ? {
    transport: {
      target: 'pino/file',
      options: { destination: 1 },
    },
  } : {}),
});

module.exports = {
  info:  (m, msg) => logger.info({ module: m }, msg),
  warn:  (m, msg) => logger.warn({ module: m }, msg),
  error: (m, msg) => logger.error({ module: m }, msg),
  logger,
};
