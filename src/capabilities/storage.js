'use strict';

const { storageSet, storageGet, storageDelete, storageList } = require('../database');

function set(db, userId, key, value) {
  storageSet(db, userId, key, value);
  return `Stored: ${key} = ${value}`;
}

function get(db, userId, key) {
  const val = storageGet(db, userId, key);
  return val !== null ? val : `No value found for key "${key}".`;
}

function del(db, userId, key) {
  const ok = storageDelete(db, userId, key);
  return ok ? `Deleted key "${key}".` : `Key "${key}" not found.`;
}

function list(db, userId) {
  const rows = storageList(db, userId);
  if (rows.length === 0) return 'Storage is empty.';
  return rows.map((r) => `${r.key}: ${r.value}`).join('\n');
}

module.exports = { set, get, del, list };
