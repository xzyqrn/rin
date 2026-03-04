export function renderHtml(isError: boolean, title: string, message: string): string {
  // Explicitly escape dynamic HTML inputs to prevent reflected XSS.
  const escapeHtml = (unsafe: string) => {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  const bgColor = isError ? '#fff0f0' : '#e6f8fa';
  const iconColor = isError ? '#e53e3e' : '#4caf50';
  const icon = isError ? '❌' : '✅';

  return `
    <html>
      <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
      </head>
      <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: ${bgColor}; flex-direction: column;">
        <h2 style="color: ${iconColor};">
          <span style="font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif;">${icon}</span> ${safeTitle}
        </h2>
        <p style="text-align: center; max-width: 400px;">${safeMessage}</p>
        <p>You can close this window and return to the bot. This window will close automatically.</p>
        <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
        <script>
          setTimeout(() => {
            window.close();
            window.Telegram?.WebApp?.close?.();
          }, 4000);
        </script>
      </body>
    </html>
  `.trim();
}
