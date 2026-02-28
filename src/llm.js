'use strict';

const OpenAI = require('openai');

const MODEL = process.env.LLM_MODEL || 'arcee-ai/trinity-large-preview:free';

const useGeminiNative = !!process.env.GEMINI_API_KEY;

const openai = new OpenAI({
  baseURL: useGeminiNative ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : 'https://openrouter.ai/api/v1',
  apiKey: useGeminiNative ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY,
  defaultHeaders: useGeminiNative ? undefined : {
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
    logApiCall(_db, completion.model || MODEL, completion.usage.prompt_tokens, completion.usage.completion_tokens)
      .catch(err => console.error('[llm] Usage track error:', err.message));
  } catch { /* non-critical */ }
}

async function _retryCreate(params, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await openai.chat.completions.create(params, options);
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
  const completion = await _retryCreate({ model: MODEL, messages }, { signal });
  _trackUsage(completion);
  return (completion.choices[0].message.content || '').trim();
}

/**
 * Some models (or misconfigured tool-calling setups) will emit internal
 * "tool_code" blocks like:
 *   tool_code
 *   print(default_api.think(...))
 * These are not meant for end-users. Detect them so we can fall back to a
 * plain, tool-less chat instead of leaking the raw tool code into Telegram.
 */
function _looksLikeToolCodeLeak(text) {
  if (!text) return false;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('tool_code')) return true;
  if (/^print\s*\(\s*default_api\./i.test(trimmed)) return true;
  return false;
}

/**
 * Compress a list of old conversation messages into a single summary string.
 * Used when the conversation history grows too large.
 * @param {AbortSignal} [signal] - optional abort signal for /cancel
 */
async function summarizeHistory(messages, signal) {
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
    }, { signal });
    _trackUsage(completion);
    const out = (completion.choices[0].message.content || '').trim();
    return out;
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
      // DEBUG LOGGING
      try {
        require('fs').writeFileSync('/tmp/llm_payload.json', JSON.stringify({ model: MODEL, messages: current, tools: (toolDefs || []).length }));
      } catch (e) { }

      const completion = await _retryCreate({
        model: MODEL,
        messages: current,
        tools: toolDefs,
        tool_choice: 'auto',
      }, { signal });
      _trackUsage(completion);

      const msg = completion.choices[0].message;

      // No more tool calls — we have a final answer
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // If Rin produced a plan but the reply is empty, summarise what was done
        const content = (msg.content || '').trim();

        // Guard against models that emit raw "tool_code" blocks instead of
        // using structured tool_calls. In that case, fall back to a plain
        // chat without tools so the user never sees the internal code.
        if (_looksLikeToolCodeLeak(content)) {
          console.warn('[llm] Detected raw tool_code block; falling back to plain chat without tools.');
          return await chat(messages, { signal });
        }

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
    // Sanitize facts: enforce snake_case keys, cap value length, and reject
    // values that look like prompt-injection attempts.
    const INJECTION_RE = /\b(ignore|override|system:|you are now|new instructions|forget|disregard|jailbreak)\b/i;
    return parsed.filter((item) => {
      if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') return false;
      if (!item.key || !item.value) return false;
      if (!/^[a-z_][a-z0-9_]*$/.test(item.key)) return false;  // snake_case keys only
      if (item.value.length > 200) return false;                 // cap value length
      if (INJECTION_RE.test(item.value)) return false;           // reject injection patterns
      return true;
    });
  } catch {
    return [];
  }
}

module.exports = { initLlm, chat, chatWithTools, summarizeHistory, extractFacts };
