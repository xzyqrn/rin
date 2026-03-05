## 2024-10-24 - Add native command menu to Telegram bot
**Learning:** In a chat-based UI that lacks standard HTML forms or buttons, users have poor discoverability for available commands. Without an explicit list of commands native to the client, users are forced to memorize them.
**Action:** Always register a bot's commands with the Telegram platform via `setMyCommands` to populate the native Menu button and enable command auto-complete.

## 2025-03-08 - Replace transient chat status messages with final states
**Learning:** Sending a "processing" message followed by a separate "done" message creates unnecessary clutter in conversational interfaces, pushing context out of view.
**Action:** When performing async actions in chat UIs (like file uploads), capture the ID of the initial status message and use the platform's `editMessageText` method to update it with the final outcome instead of appending new messages.

## 2025-03-08 - Provide styled HTML errors with close buttons in Telegram WebApps
**Learning:** When using OAuth flows inside Telegram WebApps, returning plain text error responses (e.g., HTTP 400 Bad Request) leaves users stranded. Without a native browser back button or a custom "Close" action in the UI, they must force-close the overlay.
**Action:** Always return styled HTML templates containing `window.Telegram?.WebApp?.close?.()` buttons, even for error states, so users can smoothly exit the WebApp and return to the chat context.