'use strict';

const OpenAI = require('openai');

const MODEL = 'arcee-ai/trinity-large-preview:free';

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/rin-bot',
    'X-Title': 'Rin',
  },
});

// Optional db reference for usage tracking — set via initLlm(db)
let _db = null;
function initLlm(db) { _db = db; }

function _trackUsage(completion) {
  if (!_db || !completion.usage) return;
  try {
    const { logApiCall } = require('./database');
    logApiCall(_db, completion.model || MODEL, completion.usage.prompt_tokens, completion.usage.completion_tokens);
  } catch { /* non-critical */ }
}

async function chat(messages) {
  const completion = await openai.chat.completions.create({ model: MODEL, messages });
  _trackUsage(completion);
  return (completion.choices[0].message.content || '').trim();
}

/**
 * Chat with tool access. Runs the tool-call loop.
 * Falls back to plain chat if the model doesn't support function calling.
 *
 * @param {Array}    messages
 * @param {Array}    toolDefs   - OpenAI tool definitions
 * @param {Function} executor   - async (toolName, args) => string
 */
async function chatWithTools(messages, toolDefs, executor) {
  if (!toolDefs || toolDefs.length === 0) return chat(messages);

  const MAX_ROUNDS = 6;
  let current = [...messages];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: current,
        tools: toolDefs,
        tool_choice: 'auto',
      });
      _trackUsage(completion);

      const msg = completion.choices[0].message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return (msg.content || '').trim();
      }

      current.push(msg);

      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = JSON.parse(tc.function.arguments);
          result = String(await executor(tc.function.name, args));
        } catch (err) {
          result = `Tool error: ${err.message}`;
        }
        current.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    // Max rounds hit — ask for plain summary
    current.push({ role: 'user', content: 'Please summarize what you found.' });
    return await chat(current);
  } catch (err) {
    const isToolError =
      err?.status === 400 ||
      /tool|function/i.test(err?.message || '');
    if (isToolError) {
      console.warn('[llm] Tool calling not supported, falling back to plain chat.');
      return await chat(messages);
    }
    throw err;
  }
}

async function extractFacts(userMessage, assistantReply) {
  const snippet = `User said: "${userMessage}"\nRin replied: "${assistantReply}"`;
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Extract durable facts about the user from the snippet.
Output ONLY valid JSON — an array of {key, value} objects with snake_case keys.
If none, output exactly: []
No explanation, no markdown — just the JSON array.`,
        },
        { role: 'user', content: snippet },
      ],
    });
    _trackUsage(completion);
    const raw     = (completion.choices[0].message.content || '').trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.key === 'string' && item.key && typeof item.value === 'string' && item.value
    );
  } catch {
    return [];
  }
}

module.exports = { initLlm, chat, chatWithTools, extractFacts };
