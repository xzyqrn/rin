const test = require('node:test');
const assert = require('node:assert/strict');

const { splitAssistantReply } = require('../src/reply-splitter');

test('splitAssistantReply splits on paragraph breaks', () => {
  const chunks = splitAssistantReply('First paragraph.\n\nSecond paragraph.\nLine two.\n\nThird paragraph.');
  assert.deepEqual(chunks, [
    'First paragraph.',
    'Second paragraph.\nLine two.',
    'Third paragraph.',
  ]);
});

test('splitAssistantReply does not split inside fenced code blocks', () => {
  const chunks = splitAssistantReply(
    'Before code.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter code.'
  );

  assert.deepEqual(chunks, [
    'Before code.',
    '```js\nconst a = 1;\n\nconst b = 2;\n```',
    'After code.',
  ]);
});

test('splitAssistantReply chunks long paragraphs to Telegram limit boundaries', () => {
  const chunks = splitAssistantReply('A '.repeat(5000));
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 4096));
});
