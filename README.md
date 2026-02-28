# Rin — Telegram AI Bot

A personal Telegram bot powered by [Trinity](https://openrouter.ai/arcee-ai/trinity-large-preview) via OpenRouter. Rin remembers things about you across conversations, runs on a Linux VPS, and can manage the server, browse the web, schedule tasks, monitor uptime, and more.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Tools](#tools)
- [Commands](#commands)
- [Usage Examples](#usage-examples)
- [Background Services](#background-services)
- [Database](#database)
- [Environment Variables](#environment-variables)
- [Errors](#errors)
- [Security Notes](#security-notes)
- [License](#license)

---

## Features

- **Persistent memory** — conversation history and extracted user facts are stored in Firestore and injected into every prompt, so Rin remembers you across restarts
- **Per-user isolation** — every Telegram user has their own private memory, notes, reminders, and storage
- **Multi-user support** — any number of users can chat simultaneously
- **Tool-calling** — Rin uses OpenAI-compatible function calling to act, not just talk
- **Graceful fallback** — if the model doesn't support tool calling, Rin falls back to plain chat seamlessly
- **File uploads** — send any document, photo, video, audio, or voice message; files are saved to the VPS under a per-user folder with configurable size and quota limits
- **Rate limiting** — configurable per-hour message cap for non-admin users
- **API usage tracking** — every LLM call logs token counts to Firestore
- **Google Integration** — link your Google account to interact with Drive, Calendar, Gmail, and more

---

## Tech Stack

| Component | Library / Service |
|-----------|-------------------|
| Runtime | Node.js v18+ |
| Telegram API | [telegraf](https://github.com/telegraf/telegraf) v4 |
| Database | [Firebase Firestore](https://firebase.google.com/docs/firestore) |
| LLM Provider | [OpenRouter](https://openrouter.ai) or [Google Gemini](https://ai.google.dev/) |
| Model | `arcee-ai/trinity-large-preview:free` (configurable via `LLM_MODEL`) |
| Web scraping | axios + cheerio |
| Scheduling | node-cron |
| Webhook server | express |

---

## Project Structure

```
├── src/
│   ├── index.js                Entry point — env check, DB init, wires everything together
│   ├── bot.js                  Telegraf setup, commands, rate limiting, message handler
│   ├── database.js             Firestore schema and all DB helpers
│   ├── llm.js                  LLM client, tool-call loop, usage tracking, fact extraction
│   ├── personality.js          Rin's system prompts (base + admin)
│   ├── logger.js               Structured logging helper
│   ├── shell.js                Safe shell execution (timeout, output cap, denylist)
│   ├── tools.js                All tool definitions + executor dispatcher
│   ├── poller.js               Background loops — reminders + health checks
│   ├── webhook.js              Express webhook server for callbacks and triggers
│   └── capabilities/
│       ├── web.js              browseUrl, checkUrl
│       ├── files.js            readFile, writeFile, listDirectory, deleteFile, convertFile
│       ├── cron.js             node-cron scheduler (loads from DB on startup)
│       ├── monitoring.js       system health, PM2 status, API usage
│       ├── storage.js          per-user key-value store
│       └── uploads.js          Telegram file download, per-user quota enforcement
├── uploads/                    User files (git-ignored)
├── .env.example
└── package.json
```

---

## Tools

Rin uses function calling to take real actions. Tools are split by access level.

### Available to all users

| Tool | What it does |
|------|-------------|
| `browse_url` | Fetch a web page and return readable text content |
| `set_reminder` | Schedule a reminder (relative minutes or absolute datetime) |
| `list_reminders` | Show pending reminders |
| `delete_reminder` | Cancel a reminder by ID |
| `save_note` | Save or overwrite a note by title |
| `get_notes` | Retrieve notes, with optional keyword search |
| `delete_note` | Delete a note by title |
| `storage_set` | Persist a key-value pair |
| `storage_get` | Retrieve a stored value by key |
| `storage_delete` | Remove a key |
| `storage_list` | List all stored keys and values |

### Admin only

| Tool | What it does |
|------|-------------|
| `run_command` | Execute a bash command on the VPS |
| `read_file` | Read a file's contents (≤ 512 KB) |
| `write_file` | Write or create a file |
| `list_directory` | List files in a directory |
| `delete_file` | Delete a file |
| `convert_file` | Convert between formats (csv ↔ json) |
| `system_health` | CPU, memory, disk, load average, uptime |
| `pm2_status` | Status of all PM2-managed processes |
| `api_usage` | LLM call count and token totals for the last N days |
| `create_cron` | Schedule a recurring job (message / shell command / health check) |
| `list_crons` | List all cron jobs |
| `delete_cron` | Remove a cron job by name |
| `add_health_check` | Register a URL to monitor for uptime |
| `list_health_checks` | List monitored URLs and their last status |
| `remove_health_check` | Remove a health check |
| `create_webhook` | Create a webhook endpoint that forwards POST payloads to Telegram |
| `list_webhooks` | List webhook endpoints and their URLs |
| `delete_webhook` | Remove a webhook |

---

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/start` | Everyone | Introduction message |
| `/help` | Everyone | List available commands and capabilities |
| `/myfiles` | Everyone | List your uploaded files |
| `/linkgoogle` | Everyone | Start Google OAuth account linking process |
| `/cancel` | Everyone | Cancel an ongoing LLM request |
| `/shell <cmd>` | Admins | Execute a shell command directly, bypassing the LLM |
| `/status` | Admins | Quick system health snapshot (CPU, memory, disk, uptime) |

---

## Usage Examples

### Conversation & memory

```
You:  My name is Jay and I work as a backend engineer.
Rin:  Nice to meet you, Jay. Backend — what stack are you on?

# restart the bot

You:  Hey, do you remember me?
Rin:  You're Jay, a backend engineer. What's up?
```

### Reminders

```
You:  Remind me to push the deployment in 30 minutes.
Rin:  Done. Reminder #id set for 3:45 PM: "push the deployment"

# 30 minutes later, Rin messages you:
Rin:  Reminder: push the deployment
```

### File uploads

Just send Rin any file directly in the Telegram chat — no command required.

| What you send | How Telegram forwards it |
|---------------|--------------------------|
| Any file / attachment | Document |
| Photo | Photo (highest resolution automatically selected) |
| Video | Video |
| Music / audio file | Audio |
| Voice message | Voice (saved as `voice_message.ogg`) |
| Circle video | Video note (saved as `video_note.mp4`) |

---

## Background Services

Three background processes run continuously:

| Service | Interval | What it does |
|---------|----------|-------------|
| Reminder poller | 30 s | Sends any due reminders via Telegram |
| Health check poller | 60 s | Checks registered URLs; alerts on state change |
| Cron scheduler | per job | Runs jobs on their configured cron expressions |

---

## Database

Rin uses **Google Cloud Firestore** for storage.

### Collections

| Collection | Purpose |
|------------|---------|
| `users/{id}/memory` | Per-user conversation history |
| `users/{id}/facts` | Durable facts extracted from conversations |
| `users/{id}/notes` | User notes keyed by base64 titles |
| `users/{id}/storage` | Arbitrary key-value pairs |
| `users/{id}/google_auth` | OAuth tokens for Google integration |
| `reminders` | Scheduled reminders with `fire_at` timestamps |
| `cron_jobs` | Recurring scheduled jobs |
| `health_checks` | URLs being monitored for uptime |
| `api_metrics` | LLM usage logs (tokens_in, tokens_out) |
| `webhooks` | Registered webhook endpoints and tokens |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | Bot token from @BotFather |
| `GEMINI_API_KEY` | **Yes*** | Google Gemini API Key |
| `OPENROUTER_API_KEY` | **Yes*** | API key from openrouter.ai (Alternative to Gemini) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Yes** | Your Firebase service account credentials (JSON string) |
| `ADMIN_USER_ID` | Recommended | Comma-separated Telegram user IDs with full access |
| `LLM_MODEL` | No | model identifier (e.g. `arcee-ai/trinity-large-preview:free`) |
| `WEBHOOK_BASE_URL` | No | Public base URL for OAuth/webhook links (e.g. `https://yourdomain.com`) |
| `TIMEZONE` | No | TZ string (e.g. `Asia/Manila`) |
| `RATE_LIMIT_PER_HOUR` | No | Max messages per hour for non-admin users (default: 60) |
| `MAX_UPLOAD_MB` | No | Maximum single file upload size (default: 50MB) |
| `MAX_USER_QUOTA_MB` | No | Maximum total storage per user (default: 500MB) |

*\*Either `GEMINI_API_KEY` or `OPENROUTER_API_KEY` must be provided.*

---

## Errors

### Bot Startup & Connectivity
- **`[error] TELEGRAM_BOT_TOKEN is not set.`**: The bot cannot start because the Telegram token is missing from the `.env` file.
- **`[error] GEMINI_API_KEY or OPENROUTER_API_KEY is not set.`**: No LLM provider key found. One of these must be configured.
- **`[bot] 409 Conflict`**: Another instance of the bot is already running. Stop other processes (PM2 or terminals) before starting.
- **`[bot] Failed to set commands`**: Usually a network error or invalid token preventing synchronization with Telegram's servers.

### Database (Firestore)
- **`[firebase] Failed to initialize Firebase`**: The service account JSON is invalid or missing required fields (`private_key`, etc.).
- **`[firebase] No FIREBASE_SERVICE_ACCOUNT_JSON in .env...`**: Firestore-dependent features (memory, reminders) will be disabled.
- **`[firebase] Rate limit transaction failed`**: A database collision occurred while updating message counts. The system usually "fails open" to allow the message through.

### File Uploads & Storage
- **`File too large`**: The file exceeds the `MAX_UPLOAD_MB` limit (default 50MB).
- **`Upload would exceed your storage quota`**: The user has reached their total storage limit (default 500MB).
- **`Telegram getFile returned not-ok`**: Telegram's servers rejected the file metadata request, often due to a large file (>20MB) or expired link.
- **`HTTP 404 while downloading file`**: The file was cleaned up from Telegram's servers before Rin could download it.

### Tool & Execution Errors
- **`Tool error: <sanitized message>`**: An internal tool (like `read_file` or `run_command`) failed. RIN sanitizes these to prevent leaking server paths or stack traces.
- **`Tool calling not supported, falling back to plain chat`**: The selected `LLM_MODEL` does not support function calling. Rin will continue as a standard chat bot.
- **`User rate limit reached`**: You have sent too many messages in the last hour.

### Webhooks & Google Auth
- **`Auth error: <error>`**: The Google OAuth process was cancelled or failed on Google's side.
- **`Rate limit exceeded. Max 60 requests/minute per webhook.`**: A specific webhook URL is being flooded with requests.

---

## Security Notes

- **Admin Gating**: All destructive tools (shell, files, cron, monitoring, webhooks) are gated by `ADMIN_USER_ID`.
- **Shell Sandboxing**: Commands are checked against a configured `SHELL_DENYLIST` (blocking `rm -rf /`, `mkfs`, etc.).
- **SSRF Protection**: `browse_url` blocks requests to private/loopback IP addresses.
- **Sanitized Errors**: Tool errors are stripped of absolute paths and stack traces before being shown to the LLM or user.
- **Payload Limits**: Inbound webhooks are capped at 1MB to prevent memory exhaustion.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
