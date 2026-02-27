'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), 'uploads');

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);
const MAX_USER_QUOTA_MB = parseInt(process.env.MAX_USER_QUOTA_MB || '500', 10);

/**
 * Ensures the per-user upload directory exists and returns its path.
 * @param {number|string} userId
 * @returns {string}
 */
function getUserDir(userId) {
  const dir = path.join(UPLOADS_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fetches file metadata from Telegram, then streams it to disk.
 *
 * @param {string} botToken
 * @param {string} fileId
 * @param {number|string} userId
 * @param {string} [originalName]  - Suggested filename (e.g. document.file_name)
 * @returns {Promise<{savePath: string, saveName: string, fileSize: number}>}
 */
async function downloadTelegramFile(botToken, fileId, userId, originalName) {
  // ── 1. Resolve file path via getFile API ──────────────────────────────────
  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;

  const fileInfo = await new Promise((resolve, reject) => {
    https.get(infoUrl, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Failed to parse Telegram getFile response')); }
      });
    }).on('error', reject);
  });

  if (!fileInfo.ok) {
    throw new Error(fileInfo.description || 'Telegram getFile returned not-ok');
  }

  const remotePath = fileInfo.result.file_path;            // e.g. "photos/file_123.jpg"
  const fileSize   = fileInfo.result.file_size || 0;

  // ── Size cap check ──────────────────────────────────────────────────────
  if (fileSize > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`File too large (${fmtSize(fileSize)}). Maximum allowed: ${MAX_UPLOAD_MB} MB.`);
  }

  // ── Per-user disk quota check ─────────────────────────────────────────
  const quotaCheckDir = path.join(UPLOADS_DIR, String(userId));
  if (fs.existsSync(quotaCheckDir)) {
    let totalSize = 0;
    for (const name of fs.readdirSync(quotaCheckDir)) {
      try { totalSize += fs.statSync(path.join(quotaCheckDir, name)).size; } catch { /* skip */ }
    }
    if (totalSize + fileSize > MAX_USER_QUOTA_MB * 1024 * 1024) {
      throw new Error(`Upload would exceed your storage quota (${MAX_USER_QUOTA_MB} MB). Use /myfiles to see your uploads.`);
    }
  }

  // ── 2. Build a safe local filename ────────────────────────────────────────
  const remoteExt  = path.extname(remotePath);
  const userExt    = originalName ? path.extname(originalName) : '';
  const ext        = userExt || remoteExt || '';

  let baseName;
  if (originalName) {
    // Strip extension and sanitise
    baseName = path.basename(originalName, path.extname(originalName))
      .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
      .slice(0, 120);
  } else {
    baseName = path.basename(remotePath, remoteExt) || 'file';
  }

  const timestamp = Date.now();
  const saveName  = `${baseName}_${timestamp}${ext}`;
  const userDir   = getUserDir(userId);
  const savePath  = path.join(userDir, saveName);

  // ── 3. Stream file to disk ────────────────────────────────────────────────
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(savePath);
    https.get(downloadUrl, (res) => {
      if (res.statusCode !== 200) {
        out.close();
        fs.unlink(savePath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} while downloading file`));
      }
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', (err) => { fs.unlink(savePath, () => {}); reject(err); });
      res.on('error',  (err) => { fs.unlink(savePath, () => {}); reject(err); });
    }).on('error', (err) => { fs.unlink(savePath, () => {}); reject(err); });
  });

  return { savePath, saveName, fileSize };
}

/**
 * Lists uploaded files for a user, newest first.
 * @param {number|string} userId
 * @returns {Array<{name: string, size: number, mtime: Date}>}
 */
function listUserUploads(userId) {
  const userDir = path.join(UPLOADS_DIR, String(userId));
  if (!fs.existsSync(userDir)) return [];
  return fs.readdirSync(userDir)
    .map((name) => {
      const full = path.join(userDir, name);
      const stat = fs.statSync(full);
      return { name, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Human-readable file size string.
 * @param {number} bytes
 * @returns {string}
 */
function fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = { downloadTelegramFile, listUserUploads, getUserDir, fmtSize, UPLOADS_DIR };
