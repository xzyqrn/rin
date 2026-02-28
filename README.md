# Rin — Telegram AI Bot

A personal Telegram bot powered by **Google Gemini 2.5 Flash Lite**. Rin is an **autonomous agent** that remembers you across conversations, manages server tasks, browses the web, schedules reminders, monitors uptime, and integrates with your Google Workspace.

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
- [Errors & Troubleshooting](#errors--troubleshooting)
- [Security Notes](#security-notes)
- [License](#license)

---

## Features

- **Autonomous Agency** — Rin uses a Reasoning loop (Think → Plan → Act → Reflect) to handle complex, multi-step requests.
- **Persistent Memory** — Memory of conversation history and extracted user facts are stored in Firestore, so Rin "knows" you across restarts.
- **Per-User Isolation** — Every user has their own private memory, notes, reminders, files, and sandboxed storage.
- **Google Workspace Integration** — Securely link your Google account to interact with Drive, Calendar, Gmail, Tasks, and Classroom.
- **File Handling** — Upload any file (photo, video, doc, voice); Rin saves it to a per-user directory on the VPS and can read/write/list or send them back to you.
- **Monitoring & Automation** — Schedule recurring cron jobs, monitor URL health, and track system status (CPU, RAM, Disk).
- **Webhooks** — Create custom endpoints to receive data from external services directly in your Telegram chat.
- **Rate Limiting** — Configurable per-user and per-webhook rate limits to ensure stability.

---

## Tech Stack

| Component | Library / Service |
|-----------|-------------------|
| Runtime | Node.js v18+ |
| Telegram API | [telegraf](https://github.com/telegraf/telegraf) v4 |
| Database | [Firebase Firestore](https://firebase.google.com/docs/firestore) |
| LLM Provider | [Google Gemini](https://ai.google.dev/) (Native) or [OpenRouter](https://openrouter.ai) |
| Web Scraping | axios + cheerio (with private IP protection) |
| Scheduling | node-cron |
| Webhook Server | express |

---

## Project Structure

```
├── src/
│   ├── index.js                Entry point — env check, DB init, wires everything together
│   ├── bot.js                  Telegraf setup, commands, rate limiting, message handler
│   ├── database.js             Firestore schema and all DB helpers
│   ├── llm.js                  LLM client, tool-call loop, usage tracking, fact extraction
│   ├── personality.js          Rin's system prompts (base + admin + user-specific info)
│   ├── shell.js                Safe shell execution (timeout, output cap, denylist)
│   ├── tools.js                Tool definitions, schema, and executor dispatcher
│   ├── poller.js               Background loops — reminders + health checks
│   ├── webhook.js              Express server for webhooks (legacy OAuth endpoints forward to webview)
│   └── capabilities/
│       ├── web.js              Web browsing and URL validation
│       ├── files.js            File operations (read/write/list/delete/convert)
│       ├── google.js           Google API integrations (token-backed Drive, Gmail, Calendar, etc.)
│       ├── cron.js             Recurring task scheduler
│       ├── monitoring.js       System health, PM2 status, API usage metrics
│       ├── storage.js          Per-user key-value store
│       └── uploads.js          Telegram file transfer and quota enforcement
├── uploads/                    User-uploaded files (per-user subdirectories)
├── .env.example                Template for required environment variables
└── package.json
```

---

## Tools

Rin uses function calling to take real-world actions.

### Available to all users

| Category | Tool | What it does |
|----------|------|-------------|
| **Agency** | `think` | Private reasoning scratchpad for planning (user never sees this) |
| | `plan` | Decompose multi-step goals into concrete actions |
| | `reflect` | Review the final answer and revise if needed |
| **Web** | `browse_url` | Fetch any public URL and return its text content |
| **Memory** | `save_note` | Save a formatted note with a title |
| | `get_notes` | Search and retrieve your saved notes |
| | `delete_note` | Delete a note by title |
| **Reminders** | `set_reminder` | Schedule a message for later (e.g. "in 5m", "2pm") |
| | `list_reminders` | View all your pending reminders |
| | `delete_reminder` | Cancel a reminder by ID |
| **Storage** | `storage_set` | Save a persistent key-value pair (e.g. "favorite_color") |
| | `storage_get` | Retrieve a stored value by key |
| | `storage_list` | List all your stored key-value pairs |
| **Google Auth** | `google_auth_status` | Check link status, token freshness, and exact relink URL |
| | `google_capabilities` | Return currently enabled Google capabilities (read/write) based on active tools |
| **Files*** | `read_file` | Read contents of a file in your personal folder |
| | `write_file` | Create or overwrite a file in your folder |
| | `list_directory` | See what files you have uploaded/created |
| | `send_file` | Send a file from your VPS folder back to you on Telegram |
| **Google** | `google_drive_list` | List files in your Google Drive |
| (Auth req.)| `google_drive_create_file / update / delete` | Create, edit, and delete Drive files by ID |
| | `google_calendar_list` | List upcoming events from Calendar |
| | `google_calendar_create_event / update / delete` | Create, edit, and delete Calendar events |
| | `gmail_inbox_read` | Read inbox messages including content preview/body |
| | `gmail_read_unread` | Read unread inbox messages with content |
| | `google_tasks_list` | List items in Google Tasks |
| | `google_tasks_create / update / delete` | Create, edit, and delete Tasks |
| | `google_classroom_...` | List Classroom courses and assignments |

*\*All file operations for non-admin users are strictly sandboxed to their dedicated `uploads/<user_id>` directory.*

### Admin only

| Category | Tool | What it does |
|----------|------|-------------|
| **System** | `run_command` | Execute a bash command on the VPS (with safety filters) |
| | `update_bot` | Pull latest code, install deps, and restart the service |
| **Monitor** | `system_health` | Snapshot of CPU, Memory, Disk, and Uptime |
| | `pm2_status` | Status of all running PM2 processes |
| | `api_usage` | Detailed LLM token usage and costs for the last N days |
| **Cron** | `create_cron` | Schedule recurring messages, shell commands, or checks |
| | `list_crons` | View all scheduled tasks |
| | `delete_cron` | Delete a scheduled task |
| **Health** | `add_health_check` | Monitor a URL; Rin alerts you if it goes down |
| | `list_health_checks` | View registered monitors and their current status |
| **Webhooks** | `create_webhook` | Create a secret URL for external data triggers |
| | `list_webhooks`| View your active webhook endpoints |
| **Utility** | `convert_file` | Convert files between formats (e.g. CSV to JSON) |

---

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/start` | Everyone | Initial greeting and capability overview |
| `/help` | Everyone | Detailed help message showing all features |
| `/myfiles` | Everyone | List files in your private storage folder |
| `/linkgoogle` | Everyone | Authenticate with Google to enable integration tools |
| `/cancel` | Everyone | Stop an ongoing reasoning or tool-calling loop |
| `/shell <cmd>` | Admins | Run a shell command directly (skips LLM reasoning) |
| `/status` | Admins | Quick health check (CPU, RAM, Disk, Uptime) |

---

## Usage Examples

### Research & Planning
**User:** "Find the latest Node.js LTS version, then write a dockerfile for it and save it as node_dockerfile."
**Rin:** *Uses `browse_url` to find version, `think` to design Dockerfile, `write_file` to save it, and informs the user.*

### Reminders
**User:** "Remind me to check the oven in 10 minutes."
**Rin:** *Uses `set_reminder`.*
*(10m later)* **Rin:** "🔔 Reminder: check the oven"

### Webhooks
1. Admin creates a webhook: `/shell webhook create backup_service`
2. Service sends POST: `curl -X POST https://api.yourbot.com/webhook/TOKEN -d "Backup complete"`
3. Rin notifies Admin on Telegram immediately.

---

## Background Services

Rin runs three main polling loops for automation:

1. **Reminder Poller (30s)**: Checks Firestore for due reminders and delivers them.
2. **Health Poller (60s)**: pings monitored URLs; alerts on success/failure state transitions.
3. **Cron Job Manager**: Orchestrates recurring tasks (hourly digests, midnight backups, etc.).

---

## Database

Rin uses **Google Cloud Firestore**.

- `users/{id}/memory`: Chat history (auto-compressed when old).
- `users/{id}/facts`: Key information Rin has learned about you.
- `users/{id}/notes`: User-created notes (cached in Firestore).
- `users/{id}/google_auth`: Encrypted OAuth tokens for Google services.
- `reminders`, `cron_jobs`, `health_checks`: Task and monitoring schedules.
- `api_metrics`: Token usage logs for billing and usage tracking.
- `webhooks`: Registry of secret tokens and delivery targets.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | Service Account key (JSON string or file) |
| `GEMINI_API_KEY` | Yes* | Key for Google Gemini (Primary/Recommended) |
| `OPENROUTER_API_KEY` | No | Key for OpenRouter (Alternative) |
| `ADMIN_USER_ID` | Yes | Your Telegram ID (to enable admin tools) |
| `GOOGLE_OAUTH_BASE_URL` | Yes** | Canonical webview base URL that serves `/api/auth/google/*` |
| `WEBHOOK_BASE_URL` | Yes | Public URL for webhook endpoints only (`/webhook/:token`) |
| `LLM_MODEL` | No | Model ID (default: `gemini-2.5-flash-lite`) |
| `TIMEZONE` | No | Global system timezone (e.g., `Asia/Manila`) |

*\*Google Gemini is the default provider. OpenRouter is supported as a fallback.*
*\*\*Required for Google linking flow from `/linkgoogle`.*

---

## Errors & Troubleshooting

### Connectivity & Startup
- **`[bot] 409 Conflict`**: Another instance of the bot is running. Only one polling process can exist.
- **`TELEGRAM_BOT_TOKEN is not set`**: Check your `.env` file for missing keys.
- **`Failed to set commands`**: Network error or invalid token; retry or check internet on VPS.

### Database (Firestore)
- **`Firestore not initialized`**: Firebase service account JSON is either missing or malformed.
- **`Rate limit transaction failed`**: High-frequency database updates; the bot usually "fails open" to avoid blocking messages.
- **`Doc already exists`**: Conflict when creating a webhook or cron job with a duplicate name.

### Google Integration
- **`Google account is not linked for this user.`**: Run `/linkgoogle` or call `google_auth_status` to get the exact relink URL.
- **`Google authentication expired or was revoked.`**: Relink your Google account and approve permissions again.
- **`Google denied this request due to missing permissions/scopes.`**: Relink and grant full requested scopes on consent screen.
- **`Auth error: access_denied`**: You declined the permissions on the Google consent screen.
- **After new Google features are deployed**: Relink once via `/linkgoogle` so your token includes the newest scopes.

### Terminal & Shell
- **`Command blocked by security policy`**: You tried to run a forbidden command (e.g., `rm -rf /`).
- **`Command timed out after 30s`**: Long-running processes are stopped to prevent VPS resource exhaustion.
- **`$ command not found`**: Required tool (e.g., `pm2`, `git`, `curl`) is not installed on the VPS.

### File & Storage
- **`Access denied: Path is outside your folder`**: You tried to access files outside your `/uploads/<user_id>` sandbox.
- **`File too large`**: Incoming file exceeds the configured `MAX_UPLOAD_MB` (default 50MB).
- **`Upload would exceed your storage quota`**: You've used up your allocated `MAX_USER_QUOTA_MB` (default 500MB).

### LLM & API
- **`Tool error: <sanitized>`**: An error occurred inside a tool (e.g., a 404 while browsing a website).
- **`Detected raw tool_code block`**: Model hallucinated raw code; Rin will automatically fall back to plain chat.

---

## Security Notes

- **Sandboxing**: Non-admin file operations are restricted to per-user folders.
- **Shell Filtering**: Destructive shell patterns are blocked by a regex-based denylist.
- **SSRF Protection**: Web browsing tools block access to private/internal network IPs.
- **Sanitized Errors**: Pathnames and stack traces are stripped from errors shown to users or the LLM.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
