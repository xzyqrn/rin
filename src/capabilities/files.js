'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_READ_BYTES = 512 * 1024; // 512 KB read cap

function readFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    const stats = fs.statSync(resolved);
    if (stats.size > MAX_READ_BYTES) {
      return `File is ${Math.round(stats.size / 1024)} KB — too large to read inline. Use /shell head/tail/grep instead.`;
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function writeFile(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    return `Written ${Buffer.byteLength(content)} bytes to ${resolved}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function listDirectory(dirPath) {
  try {
    const resolved = path.resolve(dirPath || '.');
    const entries  = fs.readdirSync(resolved, { withFileTypes: true });
    if (entries.length === 0) return '(empty directory)';
    return entries.map((e) => {
      const icon = e.isDirectory() ? 'd' : '-';
      const size = e.isFile()
        ? ` ${fs.statSync(path.join(resolved, e.name)).size}B`
        : '';
      return `${icon} ${e.name}${size}`;
    }).join('\n');
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function deleteFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    fs.unlinkSync(resolved);
    return `Deleted: ${resolved}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function convertFile(filePath, targetFormat) {
  try {
    const resolved = path.resolve(filePath);
    const content  = fs.readFileSync(resolved, 'utf8');
    const srcExt   = path.extname(filePath).toLowerCase().replace('.', '');
    const tgtFmt   = targetFormat.toLowerCase().replace('.', '');

    if (srcExt === 'csv' && tgtFmt === 'json') {
      const lines   = content.trim().split('\n');
      const headers = parseCSVLine(lines[0]);
      const rows    = lines.slice(1)
        .filter(Boolean)
        .map((line) => {
          const vals = parseCSVLine(line);
          return headers.reduce((obj, h, i) => { obj[h] = vals[i] ?? ''; return obj; }, {});
        });
      const out = resolved.replace(/\.csv$/i, '.json');
      fs.writeFileSync(out, JSON.stringify(rows, null, 2));
      return `Converted to ${out} (${rows.length} rows)`;
    }

    if (srcExt === 'json' && tgtFmt === 'csv') {
      const data = JSON.parse(content);
      if (!Array.isArray(data)) return 'JSON must be an array of objects.';
      const headers = Object.keys(data[0] || {});
      const csv = [
        headers.map(csvEscape).join(','),
        ...data.map((row) => headers.map((h) => csvEscape(String(row[h] ?? ''))).join(','))
      ].join('\n');
      const out = resolved.replace(/\.json$/i, '.csv');
      fs.writeFileSync(out, csv);
      return `Converted to ${out} (${data.length} rows)`;
    }

    return `Unsupported: ${srcExt} → ${tgtFmt}. Supported conversions: csv→json, json→csv`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function csvEscape(val) {
  return val.includes(',') || val.includes('"') || val.includes('\n')
    ? `"${val.replace(/"/g, '""')}"` : val;
}

module.exports = { readFile, writeFile, listDirectory, deleteFile, convertFile };
