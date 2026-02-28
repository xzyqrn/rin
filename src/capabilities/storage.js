'use strict';

const { storageSet, storageGet, storageDelete, storageList } = require('../database');

async function set(db, userId, key, value) {
  await storageSet(db, userId, key, value);
  return `Stored: ${key} = ${value}`;
}

async function get(db, userId, key) {
  const val = await storageGet(db, userId, key);
  return val !== null ? val : `No value found for key "${key}".`;
}

async function del(db, userId, key) {
  const ok = await storageDelete(db, userId, key);
  return ok ? `Deleted key "${key}".` : `Key "${key}" not found.`;
}

async function list(db, userId) {
  const rows = await storageList(db, userId);
  if (rows.length === 0) return 'Storage is empty.';
  return rows.map((r) => `${r.key}: ${r.value}`).join('\n');
}

module.exports = { set, get, del, list };
