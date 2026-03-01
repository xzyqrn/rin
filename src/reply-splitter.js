'use strict';

function splitParagraphsOutsideCodeFences(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let current = [];
  let inFence = false;

  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) parts.push(joined);
    current = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return parts;
}

function chunkTextForTelegram(text, limit = 4096) {
  const chunks = [];
  let remaining = String(text || '');

  while (remaining.length > limit) {
    let cut = limit;
    const newlineCut = remaining.lastIndexOf('\n', limit);
    const spaceCut = remaining.lastIndexOf(' ', limit);

    if (newlineCut > 0) cut = newlineCut;
    else if (spaceCut > 0) cut = spaceCut;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.trim().length) chunks.push(remaining.trimEnd());
  return chunks;
}

function splitAssistantReply(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const paragraphs = splitParagraphsOutsideCodeFences(normalized);
  const chunks = [];

  for (const paragraph of paragraphs) {
    chunks.push(...chunkTextForTelegram(paragraph));
  }

  return chunks;
}

module.exports = {
  splitAssistantReply,
};
