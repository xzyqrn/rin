## 2024-10-24 - Add native command menu to Telegram bot
**Learning:** In a chat-based UI that lacks standard HTML forms or buttons, users have poor discoverability for available commands. Without an explicit list of commands native to the client, users are forced to memorize them.
**Action:** Always register a bot's commands with the Telegram platform via `setMyCommands` to populate the native Menu button and enable command auto-complete.

## 2025-03-08 - Replace transient chat status messages with final states
**Learning:** Sending a "processing" message followed by a separate "done" message creates unnecessary clutter in conversational interfaces, pushing context out of view.
**Action:** When performing async actions in chat UIs (like file uploads), capture the ID of the initial status message and use the platform's `editMessageText` method to update it with the final outcome instead of appending new messages.
## 2025-03-08 - Improve Telegram WebApp OAuth error states with styled HTML and close actions
**Learning:** Returning plain text error responses in a Telegram WebApp strands users on an unstyled page with no clear way to return to the bot, causing poor UX.
**Action:** When handling WebApp callbacks (like OAuth), always return styled HTML with explicit action buttons (like `window.close()` and `Telegram.WebApp.close()`) to provide clear exit paths, even for error states.
