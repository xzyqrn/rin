## 2024-10-24 - Add native command menu to Telegram bot
**Learning:** In a chat-based UI that lacks standard HTML forms or buttons, users have poor discoverability for available commands. Without an explicit list of commands native to the client, users are forced to memorize them.
**Action:** Always register a bot's commands with the Telegram platform via `setMyCommands` to populate the native Menu button and enable command auto-complete.

## 2025-03-08 - Replace transient chat status messages with final states
**Learning:** Sending a "processing" message followed by a separate "done" message creates unnecessary clutter in conversational interfaces, pushing context out of view.
**Action:** When performing async actions in chat UIs (like file uploads), capture the ID of the initial status message and use the platform's `editMessageText` method to update it with the final outcome instead of appending new messages.## 2024-05-24 - WebApp Error Handling UX
**Learning:** Returning raw strings/plain text from Telegram WebApp API routes strands users on a white screen with no way out if the initialization fails or errors out. CI enforces strict constraints against large inline HTML strings.
**Action:** Always return styled HTML responses for errors and successes inside WebApp endpoints, explicitly including a `window.Telegram?.WebApp?.close?.()` button to escape the interface cleanly. Keep HTML strings in separate module-level constants or utility files to avoid CI failures for overly complex/large methods.
