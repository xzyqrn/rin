'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const FIREBASE_SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'firebase-service-account.json');
const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

let firestoreDB = null;

if (envJson) {
  try {
    // If the JSON is multi-line in .env, some loaders only get the first line.
    // We check if it looks incomplete and try to find where it might be in the full env.
    let fullJson = envJson;
    if (fullJson.trim().startsWith('{') && !fullJson.trim().endsWith('}')) {
      // Deep search for the closing brace if the env loader truncated it
      const rawEnv = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
      const match = rawEnv.match(/FIREBASE_SERVICE_ACCOUNT_JSON=({[\s\S]*?\n})/);
      if (match) fullJson = match[1];
    }

    const serviceAccount = JSON.parse(fullJson);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firestoreDB = admin.firestore();
    console.log('[firebase] Initialized Firebase Admin SDK from environment');
  } catch (error) {
    console.error('[firebase] Failed to initialize Firebase from environment:', error.message);
  }
} else if (fs.existsSync(FIREBASE_SERVICE_ACCOUNT_PATH)) {
  try {
    const serviceAccount = require(FIREBASE_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firestoreDB = admin.firestore();
    console.log('[firebase] Initialized Firebase Admin SDK from file');
  } catch (error) {
    console.error('[firebase] Failed to initialize Firebase from file:', error);
  }
} else {
  console.warn('[firebase] No FIREBASE_SERVICE_ACCOUNT_JSON in .env or firebase-service-account.json file found. Firebase features will be disabled.');
}

function initDb() {
  return firestoreDB;
}

function getUserRef(userId) {
  return firestoreDB.collection('users').doc(String(userId));
}

// ── Conversation memory ────────────────────────────────────────────────────────

async function saveMemory(db, userId, content) {
  if (!firestoreDB) return;
  const memRef = getUserRef(userId).collection('memory');
  await memRef.add({
    content,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function getRecentMemories(db, userId, limit) {
  if (!firestoreDB) return [];
  const count = limit || parseInt(process.env.MEMORY_TURNS || '20', 10);
  const memRef = getUserRef(userId).collection('memory');
  const snapshot = await memRef.orderBy('timestamp', 'desc').limit(count).get();
  const memories = [];
  snapshot.forEach(doc => memories.push({ content: doc.data().content }));
  return memories.reverse();
}

// ── User facts ─────────────────────────────────────────────────────────────────

async function upsertFact(db, userId, key, value) {
  if (!firestoreDB) return;
  const factKey = key.trim().toLowerCase();
  await getUserRef(userId).collection('facts').doc(factKey).set({ value: String(value).trim() });
}

async function getAllFacts(db, userId) {
  if (!firestoreDB) return {};
  const snapshot = await getUserRef(userId).collection('facts').get();
  const facts = {};
  snapshot.forEach(doc => { facts[doc.id] = doc.data().value; });
  return facts;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

async function addReminder(db, userId, message, fireAt) {
  if (!firestoreDB) return 0;
  const ref = await firestoreDB.collection('reminders').add({
    user_id: userId,
    message,
    fire_at: fireAt,
    created_at: Math.floor(Date.now() / 1000)
  });
  return ref.id;
}

async function getPendingReminders(db, userId) {
  if (!firestoreDB) return [];
  const snapshot = await firestoreDB.collection('reminders').where('user_id', '==', userId).get();
  const reminders = [];
  snapshot.forEach(doc => reminders.push({ id: doc.id, ...doc.data() }));
  reminders.sort((a, b) => a.fire_at - b.fire_at);
  return reminders;
}

async function deleteReminder(db, userId, id) {
  if (!firestoreDB) return false;
  const docRef = firestoreDB.collection('reminders').doc(String(id));
  const doc = await docRef.get();
  if (doc.exists && doc.data().user_id === userId) {
    await docRef.delete();
    return true;
  }
  return false;
}

async function getDueReminders(db) {
  if (!firestoreDB) return [];
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await firestoreDB.collection('reminders').where('fire_at', '<=', now).orderBy('fire_at', 'asc').get();
  const due = [];
  snapshot.forEach(doc => due.push({ id: doc.id, userId: doc.data().user_id, ...doc.data() }));
  return due;
}

async function deleteFiredReminder(db, id) {
  if (!firestoreDB) return;
  await firestoreDB.collection('reminders').doc(String(id)).delete();
}

// ── Notes ─────────────────────────────────────────────────────────────────────

async function upsertNote(db, userId, title, content) {
  if (!firestoreDB) return;
  const titleSlug = Buffer.from(title).toString('base64'); // Avoid invalid doc IDs
  await getUserRef(userId).collection('notes').doc(titleSlug).set({
    title,
    content,
    updated_at: Math.floor(Date.now() / 1000)
  }, { merge: true });
}

async function getNotes(db, userId, search = null) {
  if (!firestoreDB) return [];
  const snapshot = await getUserRef(userId).collection('notes').orderBy('updated_at', 'desc').get();
  const notes = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!search || data.title.toLowerCase().includes(search.toLowerCase()) || data.content.toLowerCase().includes(search.toLowerCase())) {
      notes.push({ id: doc.id, ...data });
    }
  });
  return notes;
}

async function deleteNote(db, userId, title) {
  if (!firestoreDB) return false;
  const titleSlug = Buffer.from(title).toString('base64');
  const docRef = getUserRef(userId).collection('notes').doc(titleSlug);
  const doc = await docRef.get();
  if (doc.exists) {
    await docRef.delete();
    return true;
  }
  return false;
}

// ── Local storage ─────────────────────────────────────────────────────────────

async function storageSet(db, userId, key, value) {
  if (!firestoreDB) return;
  await getUserRef(userId).collection('storage').doc(key).set({
    value: String(value),
    updated_at: Math.floor(Date.now() / 1000)
  }, { merge: true });
}

async function storageGet(db, userId, key) {
  if (!firestoreDB) return null;
  const doc = await getUserRef(userId).collection('storage').doc(key).get();
  return doc.exists ? doc.data().value : null;
}

async function storageDelete(db, userId, key) {
  if (!firestoreDB) return false;
  const docRef = getUserRef(userId).collection('storage').doc(key);
  const doc = await docRef.get();
  if (doc.exists) {
    await docRef.delete();
    return true;
  }
  return false;
}

async function storageList(db, userId) {
  if (!firestoreDB) return [];
  const snapshot = await getUserRef(userId).collection('storage').orderBy(admin.firestore.FieldPath.documentId()).get();
  const items = [];
  snapshot.forEach(doc => items.push({ key: doc.id, value: doc.data().value }));
  return items;
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

async function addCronJob(db, userId, name, schedule, action, payload) {
  if (!firestoreDB) return null;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  await firestoreDB.collection('cron_jobs').doc(idStr).set({
    user_id: userId,
    name,
    schedule,
    action,
    payload: JSON.stringify(payload),
    enabled: 1,
    created_at: Math.floor(Date.now() / 1000)
  }, { merge: true });
  return idStr;
}

async function listCronJobs(db, userId) {
  if (!firestoreDB) return [];
  const snapshot = await firestoreDB.collection('cron_jobs').where('user_id', '==', userId).get();
  const jobs = [];
  snapshot.forEach(doc => jobs.push({ id: doc.id, ...doc.data() }));
  return jobs;
}

async function deleteCronJob(db, userId, name) {
  if (!firestoreDB) return false;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const docRef = firestoreDB.collection('cron_jobs').doc(idStr);
  const doc = await docRef.get();
  if (doc.exists && doc.data().user_id === userId) {
    await docRef.delete();
    return true;
  }
  return false;
}

async function getAllEnabledCrons(db) {
  if (!firestoreDB) return [];
  const snapshot = await firestoreDB.collection('cron_jobs').where('enabled', '==', 1).get();
  const jobs = [];
  snapshot.forEach(doc => jobs.push({ id: doc.id, ...doc.data() }));
  return jobs;
}

// ── Health checks ─────────────────────────────────────────────────────────────

async function addHealthCheck(db, userId, name, url, intervalMinutes = 5) {
  if (!firestoreDB) return;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  await firestoreDB.collection('health_checks').doc(idStr).set({
    user_id: userId,
    name,
    url,
    interval_minutes: intervalMinutes,
    enabled: 1
  }, { merge: true });
}

async function listHealthChecks(db, userId) {
  if (!firestoreDB) return [];
  const snapshot = await firestoreDB.collection('health_checks').where('user_id', '==', userId).get();
  const checks = [];
  snapshot.forEach(doc => checks.push({ id: doc.id, ...doc.data() }));
  return checks;
}

async function deleteHealthCheck(db, userId, name) {
  if (!firestoreDB) return false;
  const nameSlug = Buffer.from(name).toString('base64');
  const idStr = `${userId}_${nameSlug}`;
  const docRef = firestoreDB.collection('health_checks').doc(idStr);
  const doc = await docRef.get();
  if (doc.exists && doc.data().user_id === userId) {
    await docRef.delete();
    return true;
  }
  return false;
}

async function getHealthChecksToRun(db) {
  if (!firestoreDB) return [];
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await firestoreDB.collection('health_checks').where('enabled', '==', 1).get();
  const checks = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!data.last_checked || data.last_checked + data.interval_minutes * 60 <= now) {
      checks.push({ id: doc.id, ...data });
    }
  });
  return checks;
}

async function updateHealthCheckStatus(db, id, status) {
  if (!firestoreDB) return;
  await firestoreDB.collection('health_checks').doc(String(id)).update({
    last_checked: Math.floor(Date.now() / 1000),
    last_status: status
  });
}

// ── API metrics ────────────────────────────────────────────────────────────────

async function logApiCall(db, model, tokensIn, tokensOut) {
  if (!firestoreDB) return;
  await firestoreDB.collection('api_metrics').add({
    model,
    tokens_in: tokensIn || 0,
    tokens_out: tokensOut || 0,
    timestamp: Math.floor(Date.now() / 1000)
  });
}

async function getApiUsageSummary(db, days = 7) {
  if (!firestoreDB) return [];
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const snapshot = await firestoreDB.collection('api_metrics').where('timestamp', '>=', since).get();
  const aggregated = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!aggregated[data.model]) {
      aggregated[data.model] = { model: data.model, calls: 0, tokens_in: 0, tokens_out: 0 };
    }
    aggregated[data.model].calls++;
    aggregated[data.model].tokens_in += data.tokens_in;
    aggregated[data.model].tokens_out += data.tokens_out;
  });
  return Object.values(aggregated);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkAndIncrementRateLimit(db, userId, limitPerHour) {
  if (!firestoreDB) return true; // Fail open if no DB
  if (limitPerHour === 0) return true; // Unlimited

  const windowStart = String(Math.floor(Date.now() / 3600000) * 3600);
  const rateLimitRef = getUserRef(userId).collection('rate_limits').doc(windowStart);

  try {
    return await firestoreDB.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitRef);
      if (!doc.exists) {
        transaction.set(rateLimitRef, { count: 1 });
        return true;
      }
      const count = doc.data().count;
      if (count < limitPerHour) {
        transaction.update(rateLimitRef, { count: count + 1 });
        return true;
      }
      return false;
    });
  } catch (e) {
    console.error('[firebase] Rate limit transaction failed', e);
    return true; // Fail open
  }
}

// ── Google OAuth Tokens (Firebase) ─────────────────────────────────────────────

async function saveGoogleTokens(db, userId, tokens) {
  if (!firestoreDB) {
    console.error(`[firebase] Firestore not initialized - cannot save tokens for user ${userId}`);
    return false;
  }

  try {
    const updateData = {
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    };
    if (tokens.access_token) updateData.access_token = tokens.access_token;
    if (typeof tokens.expiry_date === 'number') updateData.expiry_date = tokens.expiry_date;
    if (tokens.refresh_token) {
      updateData.refresh_token = tokens.refresh_token;
    }
    if (tokens.scope) {
      updateData.scope = String(tokens.scope);
    }
    if (tokens.token_type) {
      updateData.token_type = String(tokens.token_type);
    }

    // Save as subcollection under users collection: users/{userId}/google_auth/{docId}
    await getUserRef(userId).collection('google_auth').doc('tokens').set(updateData, { merge: true });
    return true;
  } catch (error) {
    console.error(`[firebase] Error saving tokens for user ${userId}:`, error);
    return false;
  }
}

async function getGoogleTokens(db, userId) {
  if (!firestoreDB) {
    console.error(`[firebase] Firestore not initialized - cannot get tokens for user ${userId}`);
    return null;
  }

  try {
    // Read from users/{userId}/google_auth/tokens subcollection
    const docRef = getUserRef(userId).collection('google_auth').doc('tokens');
    const doc = await docRef.get();

    if (doc.exists) {
      const tokenData = doc.data();

      if (tokenData.access_token || tokenData.refresh_token) {
        return {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expiry_date: tokenData.expiry_date,
          scope: tokenData.scope,
          token_type: tokenData.token_type,
        };
      }
      return null;
    }
    return null;
  } catch (error) {
    console.error(`[firebase] Error getting tokens for user ${userId}:`, error);
    return null;
  }
}

module.exports = {
  initDb,
  saveMemory, getRecentMemories,
  upsertFact, getAllFacts,
  addReminder, getPendingReminders, deleteReminder, getDueReminders, deleteFiredReminder,
  upsertNote, getNotes, deleteNote,
  storageSet, storageGet, storageDelete, storageList,
  addCronJob, listCronJobs, deleteCronJob, getAllEnabledCrons,
  addHealthCheck, listHealthChecks, deleteHealthCheck, getHealthChecksToRun, updateHealthCheckStatus,
  logApiCall, getApiUsageSummary,
  checkAndIncrementRateLimit,
  saveGoogleTokens, getGoogleTokens,
};
