'use strict';

const OpenAI = require('openai');

const MODEL = process.env.LLM_MODEL || 'arcee-ai/trinity-large-preview:free';

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

async function _retryCreate(params, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const isRetryable = (status >= 500 || !status);
      if (!isRetryable || attempt === maxRetries - 1) throw err;
      const delayMs = attempt === 0 ? 1000 : 3000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function chat(messages, { signal } = {}) {
  const completion = await _retryCreate({ model: MODEL, messages, signal });
  _trackUsage(completion);
  return (completion.choices[0].message.content || '').trim();
}

/**
 * Compress a list of old conversation messages into a single summary string.
 * Used when the conversation history grows too large.
 */
async function summarizeHistory(messages) {
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const speaker = m.role === 'assistant' ? 'Rin' : 'User';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${speaker}: ${content}`;
    })
    .join('\n');

  try {
    const completion = await _retryCreate({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a memory compressor. Summarise the conversation below into a compact, factual paragraph that preserves the most important context, decisions, and preferences expressed. Write in third-person ("The user said…"). Be concise.',
        },
        { role: 'user', content: transcript },
      ],
    });
    _trackUsage(completion);
    return (completion.choices[0].message.content || '').trim();
  } catch {
    return '[Earlier conversation compressed — summary unavailable]';
  }
}

/**
 * Chat with tool access. Runs a ReAct-style loop:
 * Reason (think/plan) → Act (tool calls) → Observe (tool results) → Repeat.
 *
 * Falls back to plain chat if the model doesn't support function calling.
 *
 * @param {Array}    messages
 * @param {Array}    toolDefs   - OpenAI tool definitions
 * @param {Function} executor   - async (toolName, args) => string
 * @param {object}   [opts]
 * @param {AbortSignal} [opts.signal] - AbortSignal to cancel the request
 */
async function chatWithTools(messages, toolDefs, executor, { signal } = {}) {
  if (!toolDefs || toolDefs.length === 0) return chat(messages, { signal });

  const MAX_ROUNDS = 12;
  let current = [...messages];

  // Track the plan if Rin produces one, so we can display progress
  let activePlan = null;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await _retryCreate({
        model: MODEL,
        messages: current,
        tools: toolDefs,
        tool_choice: 'auto',
        signal,
      });
      _trackUsage(completion);

      const msg = completion.choices[0].message;

      // No more tool calls — we have a final answer
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // If Rin produced a plan but the reply is empty, summarise what was done
        const content = (msg.content || '').trim();
        if (!content && activePlan) {
          return 'Done — all planned steps completed.';
        }
        return content;
      }

      current.push(msg);

      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name;
        let result;

        try {
          const args = JSON.parse(tc.function.arguments);

          // ── Meta-cognitive tools: handled internally ──────────────────────
          if (toolName === 'think') {
            const reasoning = args.reasoning || '';
            console.log(`[Rin] 🧠 Thinking: ${reasoning.split('\\n')[0]}${reasoning.includes('\\n') ? '...' : ''}`);
            result = `Thought noted. Continue.`;
          } else if (toolName === 'plan') {
            activePlan = args.steps || [];
            const numbered = activePlan.map((s, i) => `${i + 1}. ${s}`).join('\\n');
            console.log(`[Rin] 📋 Planning:\n${numbered}`);
            result = `Plan set:\\n${numbered}\\n\\nNow execute each step in order using the available tools.`;
          } else if (toolName === 'reflect') {
            console.log(`[Rin] 🔎 Reflecting: ${args.critique}`);
            if (args.revised_answer && args.revised_answer !== 'null') {
              console.log(`[Rin] 💡 Revising answer.`);
              // Inject the improved answer as the final content and end the loop
              return args.revised_answer.trim();
            }
            result = 'Reflection complete — original answer is satisfactory.';
          } else {
            // ── Real external tools ──────────────────────────────────────────
            console.log(`[Rin] 🛠️  Executing: ${toolName}(${JSON.stringify(args)})`);
            result = String(await executor(toolName, args));
            console.log(`[Rin] ✅ Finished: ${toolName}`);
          }
        } catch (err) {
          const sanitized = (err.message || 'unknown error')
            .replace(/\/[^\s:]+/g, '<path>')
            .replace(/\n\s+at .+/g, '');
          result = `Tool error: ${sanitized}`;
        }

        current.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    // Max rounds hit — ask for a plain summary of what was accomplished
    current.push({ role: 'user', content: 'Summarise what you found or did.' });
    return await chat(current, { signal });
  } catch (err) {
    const isToolError =
      err?.status === 400 ||
      /tool|function/i.test(err?.message || '');
    if (isToolError) {
      console.warn('[llm] Tool calling not supported, falling back to plain chat.');
      return await chat(messages, { signal });
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
    const raw = (completion.choices[0].message.content || '').trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.key === 'string' && item.key && typeof item.value === 'string' && item.value
    );
  } catch {
    return [];
  }
}

module.exports = { initLlm, chat, chatWithTools, summarizeHistory, extractFacts };
