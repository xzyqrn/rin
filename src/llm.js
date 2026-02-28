'use strict';

const OpenAI = require('openai');

const MODEL = process.env.LLM_MODEL || 'gemini-2.5-flash-lite';
const COMPLEX_MODEL = process.env.LLM_MODEL_COMPLEX || MODEL;
const MODEL_ROUTER_ENABLED = /^(1|true|yes)$/i.test(String(process.env.MODEL_ROUTER_ENABLED || ''));

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

function _logGuardEvent(eventType, payload = {}) {
  try {
    if (!_db || typeof _db.collection !== 'function') return;
    _db.collection('agent_guard_metrics').add({
      event_type: eventType,
      payload,
      created_at: Math.floor(Date.now() / 1000),
    }).catch(() => {});
  } catch {
    // Best-effort metrics only.
  }
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

function _shouldUseComplexModel(lastUserText = '', toolNames = new Set()) {
  const text = String(lastUserText || '').toLowerCase();
  if (!text) return false;

  const multiStepIntent =
    /\b(then|after that|also|next|for each|step by step|plan)\b/i.test(text) ||
    /\b(check|read|scan|fetch|find).{1,80}\b(and|then)\b.{1,80}\b(remind|reply|send|label|update|create)\b/i.test(text);

  const highStakesGoogleIntent =
    /\b(gmail|email|inbox|calendar|drive|tasks?|classroom)\b/i.test(text) &&
    /\b(urgent|important|all|every|summarize|triage|organize|categorize)\b/i.test(text);

  const capabilityIntent =
    /\b(google|gmail|drive|calendar|tasks?|classroom)\b/i.test(text) &&
    /\b(capab|access|permission|scope|what can you do)\b/i.test(text);

  return Boolean(
    multiStepIntent ||
    highStakesGoogleIntent ||
    capabilityIntent ||
    (toolNames.size > 14 && /\b(do|handle|manage)\b/i.test(text))
  );
}

function _selectModel(messages = [], toolDefs = []) {
  if (!MODEL_ROUTER_ENABLED) return MODEL;
  const toolNames = _getToolNames(toolDefs);
  const lastUserText = _getLastUserText(messages);
  return _shouldUseComplexModel(lastUserText, toolNames) ? COMPLEX_MODEL : MODEL;
}

async function chat(messages, { signal } = {}) {
  const completion = await _retryCreate({ model: _selectModel(messages), messages }, { signal });
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

function _getToolNames(toolDefs) {
  return new Set((toolDefs || []).map((t) => t?.function?.name).filter(Boolean));
}

function _getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function _shouldForceToolGrounding(lastUserText, toolNames) {
  const text = String(lastUserText || '').toLowerCase();
  if (!text) return false;

  const googleCapabilityIntent =
    /\b(google|gmail|drive|calendar|tasks?|classroom)\b/i.test(text) &&
    /\b(can you|capab|access|permissions?|what can you do|what can you access)\b/i.test(text);
  if (googleCapabilityIntent && toolNames.has('google_capabilities')) return true;

  const googleIntent = /\b(google|gmail|email|inbox|calendar|schedule|meeting|drive|classroom|assignment|homework|task|to-?do)\b/i.test(text);
  if (googleIntent) {
    if (toolNames.has('google_auth_status') || toolNames.has('google_scope_status')) return true;
    if (
      toolNames.has('google_calendar_list') ||
      toolNames.has('gmail_read_unread') ||
      toolNames.has('google_drive_list') ||
      toolNames.has('google_tasks_list') ||
      toolNames.has('google_classroom_get_assignments')
    ) return true;
  }

  const reminderIntent = /\b(remind|reminder)\b/i.test(text);
  if (reminderIntent && toolNames.has('set_reminder')) return true;

  const notesIntent = /\b(save (this|that)|take a note|remember this|note\b)\b/i.test(text);
  if (notesIntent && (toolNames.has('save_note') || toolNames.has('get_notes'))) return true;

  const fileIntent = /\b(my files|list files|directory|folder|uploaded)\b/i.test(text);
  if (fileIntent && (toolNames.has('list_directory') || toolNames.has('read_file'))) return true;

  const systemIntent = /\b(check server|system status|cpu|memory|pm2|logs?)\b/i.test(text);
  if (systemIntent && (toolNames.has('run_command') || toolNames.has('system_health'))) return true;

  return false;
}

function _looksLikeUnsupportedGoogleCapabilityClaim(text, toolNames) {
  const content = String(text || '').toLowerCase();
  if (!content) return false;
  if (!toolNames.has('google_auth_status')) return false;

  const mentionsGoogleService = /\b(google|drive|gmail|inbox|calendar|tasks?|classroom)\b/i.test(content);
  if (!mentionsGoogleService) return false;

  const privacyExcuseOrFalseRestriction =
    /\bprivacy\b/i.test(content) ||
    /\bsecurity feature\b/i.test(content) ||
    /\bcannot read\b.*\binbox\b/i.test(content) ||
    /\bcannot access\b.*\binbox\b/i.test(content) ||
    /\bcan't read\b.*\binbox\b/i.test(content) ||
    /\bsnippet access\b/i.test(content) ||
    /\bcannot access\b.*\bclassroom\b/i.test(content) ||
    /\bcan't access\b.*\bclassroom\b/i.test(content) ||
    /\bview only\b/i.test(content);

  const contradictsDriveCrud =
    (toolNames.has('google_drive_create_file') || toolNames.has('google_drive_update_file') || toolNames.has('google_drive_delete_file')) &&
    /\bdrive\b/i.test(content) &&
    /\b(cannot|can't)\b[\s\S]{0,40}\b(create|add|edit|update|delete|modify)\b/i.test(content);

  const contradictsCalendarCrud =
    (toolNames.has('google_calendar_create_event') || toolNames.has('google_calendar_update_event') || toolNames.has('google_calendar_delete_event')) &&
    /\bcalendar\b/i.test(content) &&
    /\b(cannot|can't)\b[\s\S]{0,40}\b(create|add|edit|update|delete|modify)\b/i.test(content);

  const contradictsTasksCrud =
    (toolNames.has('google_tasks_create') || toolNames.has('google_tasks_update') || toolNames.has('google_tasks_delete')) &&
    /\btask\b/i.test(content) &&
    /\b(cannot|can't)\b[\s\S]{0,40}\b(create|add|edit|update|delete|modify)\b/i.test(content);

  const contradictsGmailInboxRead =
    toolNames.has('gmail_inbox_read') &&
    /\b(gmail|inbox)\b/i.test(content) &&
    (
      /\b(cannot|can't)\b[\s\S]{0,40}\b(read|access)\b[\s\S]{0,20}\binbox\b/i.test(content) ||
      /\bsnippet access\b/i.test(content)
    );

  const contradictsGmailActions =
    (toolNames.has('gmail_send') || toolNames.has('gmail_reply') || toolNames.has('gmail_draft_create') || toolNames.has('gmail_label_add')) &&
    /\b(gmail|email|inbox)\b/i.test(content) &&
    /\b(cannot|can't)\b[\s\S]{0,50}\b(send|reply|draft|label|mark read|mark unread|modify)\b/i.test(content);

  return Boolean(
    privacyExcuseOrFalseRestriction ||
    contradictsDriveCrud ||
    contradictsCalendarCrud ||
    contradictsTasksCrud ||
    contradictsGmailInboxRead ||
    contradictsGmailActions
  );
}

async function _runVerificationPass(currentMessages, signal) {
  const verifyPrompt = {
    role: 'user',
    content:
      'Run a strict final verification pass on your previous answer against the completed tool results. ' +
      'If anything is missing or vague, revise it now. Return only the final answer.',
  };
  const verified = await chat([...currentMessages, verifyPrompt], { signal });
  return verified && verified.trim() ? verified.trim() : '';
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
      model: _selectModel([{ role: 'user', content: transcript }]),
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
  const toolNames = _getToolNames(toolDefs);
  const initialUserText = _getLastUserText(messages);
  const shouldForceToolGrounding = _shouldForceToolGrounding(initialUserText, toolNames);
  const isGoogleCapabilityRequest =
    /\b(google|gmail|drive|calendar|tasks?|classroom)\b/i.test(initialUserText) &&
    /\b(can you|capab|access|permissions?|what can you do|what can you access)\b/i.test(initialUserText);
  let groundingNudgeUsed = false;
  let capabilityPreflightAttempts = 0;

  // Track the plan if Rin produces one, so we can display progress
  let activePlan = null;
  let externalToolCalls = 0;
  let verificationPassDone = false;
  let capabilityCorrectionUsed = false;
  let googleCapabilitiesChecked = false;
  const routedModel = _selectModel(messages, toolDefs);

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // DEBUG LOGGING
      try {
        require('fs').writeFileSync('/tmp/llm_payload.json', JSON.stringify({ model: routedModel, messages: current, tools: (toolDefs || []).length }));
      } catch (e) { }

      const completion = await _retryCreate({
        model: routedModel,
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

        if (!groundingNudgeUsed && shouldForceToolGrounding && externalToolCalls === 0) {
          groundingNudgeUsed = true;
          _logGuardEvent('tool_grounding_nudge', { reason: 'forced_tool_grounding' });
          current.push(msg);
          current.push({
            role: 'user',
            content:
              'Do not guess for this request. Use relevant tools now. ' +
              'If this is a Google capability/access request, call google_capabilities first. ' +
              'If access is unavailable, call google_auth_status and google_scope_status, then include the exact relink URL.',
          });
          continue;
        }

        if (
          isGoogleCapabilityRequest &&
          toolNames.has('google_capabilities') &&
          !googleCapabilitiesChecked &&
          capabilityPreflightAttempts < 2
        ) {
          capabilityPreflightAttempts++;
          _logGuardEvent('capability_preflight_nudge', {
            reason: 'missing_google_capabilities_call',
            attempt: capabilityPreflightAttempts,
          });
          current.push(msg);
          current.push({
            role: 'user',
            content:
              'Before finalizing capability answers, call google_capabilities first. ' +
              'If there is any auth/scope issue, also call google_auth_status and google_scope_status.',
          });
          continue;
        }

        if (!capabilityCorrectionUsed && _looksLikeUnsupportedGoogleCapabilityClaim(content, toolNames)) {
          capabilityCorrectionUsed = true;
          _logGuardEvent('capability_correction_trigger', { reason: 'unsupported_google_capability_claim' });
          current.push(msg);
          current.push({
            role: 'user',
            content:
              'Your previous message made an unsupported Google capability claim. ' +
              'Call google_capabilities, google_auth_status, and google_scope_status, then verify with relevant Google tools before answering. ' +
              'Do not cite generic privacy/security limitations. ' +
              'Do not say "view-only" for a service if create/update/delete tools for that service are available. ' +
              'If access fails, report the real auth/scope error and provide the exact relink URL.',
          });
          continue;
        }

        if (!content && activePlan) {
          return 'Done — all planned steps completed.';
        }

        const needsVerification = !verificationPassDone && (externalToolCalls > 1 || (activePlan && activePlan.length > 1));
        if (needsVerification) {
          verificationPassDone = true;
          _logGuardEvent('verification_pass', { external_tool_calls: externalToolCalls });
          const verified = await _runVerificationPass([...current, msg], signal);
          if (verified) return verified;
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
            externalToolCalls++;
            if (toolName === 'google_capabilities') googleCapabilitiesChecked = true;
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
