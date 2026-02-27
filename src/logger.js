'use strict';

const log = (level, module, msg) =>
  console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}] [${module}] ${msg}`);

module.exports = {
  info:  (m, msg) => log('log',   m, msg),
  warn:  (m, msg) => log('warn',  m, msg),
  error: (m, msg) => log('error', m, msg),
};
