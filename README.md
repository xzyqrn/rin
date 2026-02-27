# Rin — Telegram AI Bot

A personal Telegram bot powered by [Trinity](https://openrouter.ai/arcee-ai/trinity-large-preview) via OpenRouter. Rin remembers things about you across conversations, runs on a Linux VPS, and can manage the server, browse the web, schedule tasks, monitor uptime, and more.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup](#setup)
- [Running on a VPS (Production)](#running-on-a-vps-production)
- [Reverse Proxy & HTTPS](#reverse-proxy--https)
- [Tools](#tools)
- [Commands](#commands)
- [Usage Examples](#usage-examples)
- [Background Services](#background-services)
- [Database](#database)
- [Environment Variables](#environment-variables)
- [Security Notes](#security-notes)
- [License](#license)

---

## Features

- **Persistent memory** — conversation history and extracted user facts are stored in SQLite and injected into every prompt, so Rin remembers you across restarts
- **Per-user isolation** — every Telegram user has their own private memory, notes, reminders, and storage
- **Multi-user support** — any number of users can chat simultaneously
- **Tool-calling** — Rin uses OpenAI-compatible function calling to act, not just talk
- **Graceful fallback** — if the model doesn't support tool calling, Rin falls back to plain chat seamlessly
- **File uploads** — send any document, photo, video, audio, or voice message; files are saved to the VPS under a per-user folder with configurable size and quota limits
- **Rate limiting** — configurable per-hour message cap for non-admin users
- **API usage tracking** — every LLM call logs token counts to SQLite

---

## Tech Stack

| Component | Library / Service |
|-----------|-------------------|
| Runtime | Node.js v18+ |
| Telegram API | [telegraf](https://github.com/telegraf/telegraf) v4 |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| LLM Provider | [OpenRouter](https://openrouter.ai) |
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
│   ├── database.js             SQLite schema, migrations, all DB helpers
│   ├── llm.js                  OpenRouter client, tool-call loop, usage tracking, fact extraction
│   ├── personality.js          Rin's system prompts (base + admin)
│   ├── logger.js               Structured logging helper
│   ├── shell.js                Safe shell execution (timeout, output cap, denylist)
│   ├── tools.js                All tool definitions + executor dispatcher
│   ├── poller.js               Background loops — reminders + health checks
│   ├── webhook.js              Express webhook server
│   └── capabilities/
│       ├── web.js              browseUrl, checkUrl
│       ├── files.js            readFile, writeFile, listDirectory, deleteFile, convertFile
│       ├── cron.js             node-cron scheduler (loads from DB on startup)
│       ├── monitoring.js       system health, PM2 status, API usage
│       ├── storage.js          per-user key-value store
│       └── uploads.js          Telegram file download, per-user quota enforcement
├── data/                       SQLite database (auto-created, git-ignored)
├── .env.example
└── package.json
```

---

## Setup

### 1. Prerequisites

- Node.js v18 or later
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys)
- Your Telegram user ID — message [@userinfobot](https://t.me/userinfobot) to get it

### 2. Clone and install

```bash
git clone <your-repo-url>
cd Rin
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Environment Variables](#environment-variables) below).

### 4. Run

```bash
npm start
```

Expected output:

```
[db] SQLite initialized.
[bot] Rin is online.
[poller] Reminder + health-check pollers started.
[cron] 0 job(s) loaded.
[webhook] Server listening on port 3000
```

---

## Running on a VPS (Production)

Run Rin under [PM2](https://pm2.keymetrics.io/) so it survives crashes and reboots.

```bash
npm install -g pm2
pm2 start src/index.js --name rin
pm2 save
pm2 startup    # follow the printed command to enable autostart
```

Common PM2 commands:

```bash
pm2 logs rin        # live log tail
pm2 restart rin     # restart
pm2 stop rin        # stop
pm2 status          # overview of all processes
```

---

## Reverse Proxy & HTTPS

The webhook HTTP server runs on plain HTTP and must be fronted by a reverse proxy with TLS in production. Below are minimal config snippets for the two most common options. After configuring either, set `WEBHOOK_BASE_URL=https://yourdomain.com` in `.env`.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

### Caddy

```caddyfile
yourdomain.com {
    reverse_proxy localhost:3000
}
```

Caddy handles TLS certificates automatically.

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

### Cancelling a request

```
You:  Write me a detailed essay about the history of the Roman Empire.
Rin:  [thinking…]

You:  /cancel
Rin:  Cancelled the current request.
```

### Reminders

```
You:  Remind me to push the deployment in 30 minutes.
Rin:  Done. Reminder #4 set for 3:45 PM: "push the deployment"

# 30 minutes later, Rin messages you:
Rin:  Reminder: push the deployment
```

### Notes & storage

```
You:  Save a note called "Deploy checklist" — run migrations, restart workers, clear cache
Rin:  Note "Deploy checklist" saved.

You:  What's in my deploy checklist?
Rin:  [Deploy checklist] run migrations, restart workers, clear cache
```

### File uploads

Just send Rin any file directly in the Telegram chat — no command required.

Supported types:

| What you send | How Telegram forwards it |
|---------------|--------------------------|
| Any file / attachment | Document |
| Photo | Photo (highest resolution automatically selected) |
| Video | Video |
| Music / audio file | Audio |
| Voice message | Voice (saved as `voice_message.ogg`) |
| Circle video | Video note (saved as `video_note.mp4`) |

```
You:  [sends project.zip]
Rin:  📥 Receiving your file…
      ✅ Saved! `project_1719000000000.zip` (1.23 MB) is in your folder on the VPS.
      Use /myfiles to see everything you've uploaded.

You:  /myfiles
Rin:  📁 Your uploads (3 files):
      1. project_1719000000000.zip (1.23 MB) — 6/21/2024, 12:00:00 PM
      2. screenshot_1718900000000.jpg (245.00 KB) — 6/20/2024, 8:00:00 AM
      3. notes_1718800000000.txt (4.1 KB) — 6/19/2024, 9:30:00 PM
```

Files are stored at `<UPLOADS_DIR>/<userId>/` on the VPS. Admins can access them via `read_file` / `list_directory` tools.

### Web browsing

```
You:  Summarise the Node.js 22 release notes
Rin:  [fetches nodejs.org] Here's a summary: ...
```

### VPS control (admins)

```
You:  How's the server doing?
Rin:  [runs system_health] Memory: 1.4 GB / 4.0 GB used (35%)
      Load: 0.12 / 0.15 / 0.11 — Uptime: 12d 4h 21m — Disk: 18G / 50G (36%)

You:  Is nginx running?
Rin:  [runs systemctl status nginx] Yes, active and running. No errors.

You:  Tail the app log
Rin:  [runs tail -n 30 /var/log/app.log] Here's what I see: ...
```

For direct execution without LLM interpretation:

```
/shell journalctl -n 50 --no-pager
/shell df -h && free -m
/shell ps aux --sort=-%mem | head -10
/status
```

### Cron jobs (admins)

```
You:  Send me a good morning message every day at 8am UTC
Rin:  [calls create_cron] Job "good-morning" created — runs at "0 8 * * *"

You:  Check if my API is up every 5 minutes and alert me if it goes down
Rin:  [calls add_health_check] Health check "api" added for https://myapi.com/health
```

### Webhooks (admins)

```
You:  Create a webhook called "github-push"
Rin:  Webhook "github-push" created.
      URL: https://yourserver.com/webhook/a3f9bc...
      POST JSON to that URL and it will appear here.
```

Configure it in GitHub → Settings → Webhooks, and you'll receive push notifications directly in Telegram.

---

## Background Services

Three background processes run continuously after `npm start`:

| Service | Interval | What it does |
|---------|----------|-------------|
| Reminder poller | 30 s | Sends any due reminders via Telegram |
| Health check poller | 60 s | Checks registered URLs; alerts on state change |
| Cron scheduler | per job | Runs jobs on their configured cron expressions |

---

## Database

The SQLite database lives at `data/rin.db` and is created automatically.

### Tables

| Table | Purpose |
|-------|---------|
| `memory` | Per-user conversation history (last 20 turns used as context) |
| `user_facts` | Durable facts extracted from conversations (name, job, etc.) |
| `reminders` | Scheduled reminder messages |
| `notes` | User notes keyed by title |
| `storage` | Arbitrary key-value pairs per user |
| `cron_jobs` | Recurring scheduled jobs |
| `health_checks` | URLs being monitored for uptime |
| `api_metrics` | LLM call log with token counts |
| `rate_limits` | Per-user per-hour message counts |
| `webhooks` | Registered webhook endpoints and tokens |

### Inspecting the database

```bash
sqlite3 data/rin.db

sqlite> SELECT * FROM user_facts WHERE user_id = 123456789;
sqlite> SELECT content, timestamp FROM memory WHERE user_id = 123456789 ORDER BY id DESC LIMIT 10;
sqlite> SELECT * FROM reminders ORDER BY fire_at;
sqlite> SELECT model, SUM(tokens_in + tokens_out) as total FROM api_metrics GROUP BY model;
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `OPENROUTER_API_KEY` | Yes | — | API key from openrouter.ai |
| `ADMIN_USER_ID` | Recommended | — | Comma-separated Telegram user IDs with full access |
| `LLM_MODEL` | No | `arcee-ai/trinity-large-preview:free` | OpenRouter model identifier |
| `RATE_LIMIT_PER_HOUR` | No | `60` | Max messages per hour for non-admin users |
| `MEMORY_TURNS` | No | `20` | Number of conversation turns to include as context |
| `WEBHOOK_PORT` | No | `3000` | Port for the webhook HTTP server |
| `WEBHOOK_BASE_URL` | No | — | Public base URL for webhook links (e.g. `https://yourdomain.com`). Must use HTTPS in production via a reverse proxy with TLS. |
| `ENABLE_WEBHOOKS` | No | `true` | Set to `false` to disable the webhook server entirely |
| `UPLOADS_DIR` | No | `./uploads` | Directory where user-uploaded files are stored |
| `MAX_UPLOAD_MB` | No | `50` | Maximum single file upload size in MB |
| `MAX_USER_QUOTA_MB` | No | `500` | Maximum total storage per user in MB |
| `SHELL_DENYLIST` | No | `rm -rf /,mkfs,dd if=` | Comma-separated shell command patterns to block |

---

## Security Notes

- All admin tools — shell, files, cron, monitoring, webhooks — are gated by `ADMIN_USER_ID`. Non-matching users cannot trigger them.
- Shell commands are checked against a configurable denylist (`SHELL_DENYLIST`) before execution, and all invocations are logged.
- Run the bot under a dedicated low-privilege OS user, never as root.
- Shell commands time out after 30 seconds; output is capped at 3 500 characters.
- `browse_url` blocks requests to private/loopback addresses (SSRF protection).
- Webhook tokens are 48-character hex secrets generated with `crypto.randomBytes`.
- The webhook server runs on plain HTTP; a reverse proxy with TLS (nginx, caddy) is required in production.
- File uploads are capped at `MAX_UPLOAD_MB` (default 50 MB) per file and `MAX_USER_QUOTA_MB` (default 500 MB) per user.
- Tool errors are sanitized to strip absolute paths and stack traces before being shown to the LLM.
- The `data/` directory and `.env` are git-ignored.

---

## License

MIT
