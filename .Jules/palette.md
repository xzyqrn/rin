## 2024-10-24 - Add native command menu to Telegram bot
**Learning:** In a chat-based UI that lacks standard HTML forms or buttons, users have poor discoverability for available commands. Without an explicit list of commands native to the client, users are forced to memorize them.
**Action:** Always register a bot's commands with the Telegram platform via `setMyCommands` to populate the native Menu button and enable command auto-complete.

## 2025-03-08 - Replace transient chat status messages with final states
**Learning:** Sending a "processing" message followed by a separate "done" message creates unnecessary clutter in conversational interfaces, pushing context out of view.
**Action:** When performing async actions in chat UIs (like file uploads), capture the ID of the initial status message and use the platform's `editMessageText` method to update it with the final outcome instead of appending new messages.

## 2025-03-10 - Provide actionable HTML instead of plain text in WebApp callbacks
**Learning:** Returning plain text in Telegram WebApp API routes (like OAuth callbacks) leaves users stranded on an unstyled page with no clear way back to the bot.
**Action:** Always return styled, user-friendly HTML pages with an explicit, actionable "Close App" button (calling `window.close()` and `window.Telegram?.WebApp?.close?.()`) to smoothly return users to the conversational context.