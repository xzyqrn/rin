'use strict';

const { Telegraf } = require('telegraf');
const { SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT } = require('./personality');
const { chat, chatWithTools, summarizeHistory, extractFacts } = require('./llm');
const { buildTools } = require('./tools');
const { runCommand } = require('./shell');
const { checkAndIncrementRateLimit,
  saveMemory, getRecentMemories,
  upsertFact, getAllFacts } = require('./database');
const { downloadTelegramFile, listUserUploads,
  fmtSize } = require('./capabilities/uploads');

const ADMIN_IDS = (process.env.ADMIN_USER_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_HOUR || '60', 10);
const ADMIN_RATE_LIMIT = parseInt(process.env.ADMIN_RATE_LIMIT_PER_HOUR || '300', 10);
const MEMORY_TURNS = parseInt(process.env.MEMORY_TURNS || '30', 10);
const RECENT_TURNS = 10;          // keep this many turns verbatim
const COMPRESS_THRESHOLD = 15;    // summarise if older turns exceed this count
const MIN_FACT_EXTRACTION_LENGTH = 20;

// Per-user AbortController map for /cancel support
const activeRequests = new Map();

function isAdmin(ctx) {
  const fromId = ctx.from?.id;
  const admin = ADMIN_IDS.includes(fromId);
  return admin;
}

function buildSystemMessage(facts, admin) {
  const base = admin ? ADMIN_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const entries = Object.entries(facts);
  if (!entries.length) return base;
  const lines = entries.map(([k, v]) => `  - ${k.replace(/_/g, ' ')}: ${v}`).join('\n');
  return `${base}\n\n--- What you know about this user ---\n${lines}\n-------------------------------------`;
}

function _rowToMessage(row) {
  if (row.content.startsWith('user: ')) return { role: 'user', content: row.content.slice(6) };
  if (row.content.startsWith('rin: ')) return { role: 'assistant', content: row.content.slice(5) };
  return { role: 'user', content: row.content };
}

/**
 * Build the message history for the LLM.
 * - Keeps the most recent RECENT_TURNS turns verbatim.
 * - If there are older turns above COMPRESS_THRESHOLD, compresses them into a
 *   single summary message (summarized asynchronously on first need).
 * @param {Array} memories - all stored memory rows (newest last)
 * @param {AbortSignal} [signal] - optional abort signal for /cancel during summarization
 * @returns {Promise<Array>} resolved message array
 */
async function buildMessageHistory(memories, signal) {
  if (memories.length <= RECENT_TURNS) {
    return memories.map(_rowToMessage);
  }

  const olderRows = memories.slice(0, memories.length - RECENT_TURNS);
  const recentRows = memories.slice(memories.length - RECENT_TURNS);
  const recentMessages = recentRows.map(_rowToMessage);

  if (olderRows.length < COMPRESS_THRESHOLD) {
    // Not enough old turns to justify summarisation — include them all verbatim
    return [...olderRows.map(_rowToMessage), ...recentMessages];
  }

  // Compress older turns into a summary
  const olderMessages = olderRows.map(_rowToMessage);
  const summary = await summarizeHistory(olderMessages, signal);
  const summaryMessage = {
    role: 'assistant',
    content: `[Memory summary of earlier conversation]\n${summary}`,
  };

  return [summaryMessage, ...recentMessages];
}

/**
 * Returns true if the message appears to need multi-step processing.
 * Used to inject a planning nudge into the system prompt.
 */
function isMultiStepRequest(text) {
  if (text.length < 50) return false;
  // Keywords that typically imply chained actions
  const patterns = [
    /\b(then|after that|and then|followed by|also|next)\b/i,
    /\b(search|find|look up).{1,60}(save|store|note|remind|send)/i,
    /\b(get|fetch|check|read).{1,60}(and|then|also)/i,
    /\bfor each\b/i,
    /step[s]?:/i,
  ];
  return patterns.some((p) => p.test(text));
}

async function sendLong(ctx, text) {
  const LIMIT = 4096;
  if (text.length <= LIMIT) { await ctx.reply(text); return; }
  let start = 0;
  while (start < text.length) {
    let end = start + LIMIT;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start) end = lastNewline;
    }
    await ctx.reply(text.slice(start, end));
    start = end;
  }
}

/**
 * @param {object} db
 * @param {object} opts
 * @param {object} opts.webhookRef - mutable ref: { current: webhookService | null }
 *   Populated after bot.launch() when the webhook server starts.
 */
function createBot(db, { webhookRef = null } = {}) {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.start((ctx) => {
    const admin = isAdmin(ctx);
    const suffix = admin ? ' I have shell, file, and monitoring access on this server too.' : '';
    ctx.reply(`Hey, I'm Rin. Nice to meet you. What's on your mind?${suffix}`);
  });

  // ── /help — list available commands and capabilities ───────────────────────
  bot.command('help', (ctx) => {
    const admin = isAdmin(ctx);
    const lines = [
      "Here's what I can do:\n",
      '/start — Introduction message',
      '/help — Show this help message',
      '/myfiles — List your uploaded files',
      '/cancel — Cancel an ongoing request',
    ];
    if (admin) {
      lines.push('/shell <cmd> — Execute a shell command directly');
      lines.push('/status — Quick system health snapshot');
    }
    if (!admin) {
      lines.push(
        '\nI can help you with a wide range of tasks:\n',
        'Information & Research',
        '- Find and summarize information from the web',
        '- Explain concepts in simple terms',
        '- Help with research and fact-checking\n',
        'Writing & Editing',
        '- Draft emails, articles, stories, or scripts',
        '- Edit and proofread text',
        '- Brainstorm ideas and outlines\n',
        'Analysis & Problem-Solving',
        '- Break down complex problems',
        '- Analyze data or text',
        '- Help with coding concepts and debugging\n',
        'Tools & Organization',
        '- Set reminders and manage tasks',
        '- Save and retrieve notes',
        '- Help with planning and scheduling\n',
        'Creative & Casual',
        '- Brainstorm creative ideas',
        '- Play word games',
        '- Have interesting conversations\n',
        'Technical Help',
        '- Explain how things work',
        '- Help with documentation',
        '- Suggest approaches to technical problems'
      );
    } else {
      lines.push('\nI can also browse the web, set reminders, save notes, and store key-value data — just ask naturally.');
    }
    if (admin) {
      lines.push('As an admin, I can manage cron jobs, health checks, webhooks, files, and monitor the server.');
    }
    const helpText = lines.join('\n');
    return ctx.reply(helpText);
  });

  // ── /cancel — abort an ongoing LLM request ────────────────────────────────
  bot.command('cancel', (ctx) => {
    const userId = ctx.from.id;
    const controller = activeRequests.get(userId);
    if (controller) {
      controller.abort();
      activeRequests.delete(userId);
      return ctx.reply('Cancelled the current request.');
    }
    return ctx.reply('Nothing to cancel — no active request.');
  });

  // ── /myfiles — list the user's uploaded files ──────────────────────────────
  bot.command('myfiles', (ctx) => {
    const userId = ctx.from.id;
    const files = listUserUploads(userId);
    if (!files.length) return ctx.reply('You haven\'t uploaded any files yet. Just send me a file!');
    const lines = files.slice(0, 50).map((f, i) =>
      `${i + 1}. ${f.name} (${fmtSize(f.size)}) — ${f.mtime.toLocaleString()}`
    );
    return ctx.reply(`📁 Your uploads (${files.length} file${files.length !== 1 ? 's' : ''}):\n\n${lines.join('\n')}`);
  });

  // ── Shared file-receive helper ─────────────────────────────────────────────
  async function handleFileMessage(ctx, fileId, originalName, label) {
    const userId = ctx.from.id;
    let statusMsg;
    try {
      statusMsg = await ctx.reply(`📥 Receiving your ${label}…`);
      const { saveName, fileSize } = await downloadTelegramFile(
        process.env.TELEGRAM_BOT_TOKEN, fileId, userId, originalName
      );
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `✅ Saved! \`${saveName}\` (${fmtSize(fileSize)}) is in your folder on the VPS.\n` +
        `Use /myfiles to see everything you\'ve uploaded.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[uploads] Failed to save file:', err.message || err);
      if (statusMsg) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          '❌ Sorry, I couldn\'t save that file. Please try again.'
        );
      } else {
        await ctx.reply('❌ Sorry, I couldn\'t save that file. Please try again.');
      }
    }
  }

  // ── File-type handlers ─────────────────────────────────────────────────────
  // Document (any file sent as a file/attachment)
  bot.on('document', (ctx) => {
    const doc = ctx.message.document;
    return handleFileMessage(ctx, doc.file_id, doc.file_name, 'file');
  });

  // Photo (Telegram compresses; we grab highest resolution)
  bot.on('photo', (ctx) => {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];  // last = largest
    return handleFileMessage(ctx, best.file_id, null, 'photo');
  });

  // Video
  bot.on('video', (ctx) => {
    const vid = ctx.message.video;
    return handleFileMessage(ctx, vid.file_id, vid.file_name || null, 'video');
  });

  // Audio / music
  bot.on('audio', (ctx) => {
    const aud = ctx.message.audio;
    const name = aud.file_name || (aud.performer ? `${aud.performer} - ${aud.title}` : null);
    return handleFileMessage(ctx, aud.file_id, name, 'audio file');
  });

  // Voice message (OGG)
  bot.on('voice', (ctx) => {
    return handleFileMessage(ctx, ctx.message.voice.file_id, 'voice_message.ogg', 'voice message');
  });

  // Video note (circle video)
  bot.on('video_note', (ctx) => {
    return handleFileMessage(ctx, ctx.message.video_note.file_id, 'video_note.mp4', 'video note');
  });

  // ── /shell — admin direct execution ───────────────────────────────────────
  bot.command('shell', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("You don't have permission to do that.");
    const command = ctx.message.text.replace(/^\/shell\s*/i, '').trim();
    if (!command) return ctx.reply('Usage: /shell <command>');

    const statusMsg = await ctx.reply(`Running: \`${command}\``, { parse_mode: 'Markdown' });
    const result = await runCommand(command);

    const outputText = `\`$ ${command}\`\n\`\`\`\n${result.output}\n\`\`\``;

    if (outputText.length <= 4096) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        outputText,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `Finished: \`${command}\``,
        { parse_mode: 'Markdown' }
      );
      await sendLong(ctx, `\`\`\`\n${result.output}\n\`\`\``);
    }
  });

  // ── /status — quick health summary (admin) ─────────────────────────────────
  bot.command('status', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("You don't have permission to do that.");
    const statusMsg = await ctx.reply('Fetching system status...');
    const { getSystemHealth } = require('./capabilities/monitoring');
    const health = await getSystemHealth();
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      health
    );
  });

  // ── Main text handler ──────────────────────────────────────────────────────
  bot.on('text', async (ctx) => {
    let userMessage = ctx.message.text.trim();
    if (!userMessage || userMessage.startsWith('/')) return;

    if (ctx.message.reply_to_message) {
      const repliedText = ctx.message.reply_to_message.text || '[non-text message]';
      const isBot = ctx.message.reply_to_message.from?.id === ctx.botInfo.id;
      const repliedTo = isBot ? "your message" : "another message";
      userMessage = `${userMessage}\n\n[Replying to ${repliedTo}: "${repliedText}"]`;
    }

    const userId = ctx.from.id;
    const admin = isAdmin(ctx);

    // Rate limiting
    if (admin) {
      if (!checkAndIncrementRateLimit(db, userId, ADMIN_RATE_LIMIT)) {
        return ctx.reply(`Admin rate limit reached (${ADMIN_RATE_LIMIT} messages/hour). Try again later.`);
      }
    } else if (!checkAndIncrementRateLimit(db, userId, RATE_LIMIT)) {
      return ctx.reply(`You've reached the rate limit (${RATE_LIMIT} messages/hour). Try again later.`);
    }

    // Set up AbortController for /cancel support
    const controller = new AbortController();
    activeRequests.set(userId, controller);

    try {
      const facts = getAllFacts(db, userId);
      const memories = getRecentMemories(db, userId, MEMORY_TURNS);

      // Build history (may include a compressed summary of older turns)
      const historyMessages = await buildMessageHistory(memories, controller.signal);

      // Inject a planning nudge for complex multi-step requests
      let systemContent = buildSystemMessage(facts, admin);
      if (isMultiStepRequest(userMessage)) {
        systemContent += '\n\n[Hint] This request appears to involve multiple steps. Consider using the `think` and `plan` tools before acting.';
      }

      const messages = [
        { role: 'system', content: systemContent },
        ...historyMessages,
        { role: 'user', content: userMessage },
      ];

      // Typing indicator — re-fire every 4s (Telegram clears it after 5s)
      await ctx.sendChatAction('typing');
      const typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => { }), 4000);

      let reply;
      try {
        const tools = buildTools(db, userId, { admin, webhookService: webhookRef?.current ?? null });
        reply = await chatWithTools(messages, tools.definitions, tools.executor, { signal: controller.signal });
      } finally {
        clearInterval(typingInterval);
        activeRequests.delete(userId);
      }

      await sendLong(ctx, reply);

      saveMemory(db, userId, `user: ${userMessage}`);
      saveMemory(db, userId, `rin: ${reply}`);

      // Only extract facts for substantive, non-command messages
      if (userMessage.length > MIN_FACT_EXTRACTION_LENGTH && !userMessage.startsWith('/')) {
        extractFacts(userMessage, reply)
          .then((newFacts) => { for (const { key, value } of newFacts) upsertFact(db, userId, key, value); })
          .catch(() => { });
      }
    } catch (err) {
      activeRequests.delete(userId);
      if (err.name === 'AbortError') return;
      console.error('[bot] Error:', err.message || err);
      await ctx.reply("Sorry, something went wrong on my end. Try again in a moment.");
    }
  });

  return bot;
}

module.exports = { createBot };
