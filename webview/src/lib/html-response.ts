import { NextResponse } from 'next/server';

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export function htmlResponse(title: string, message: string, details?: string, status: number = 200) {
    const isError = status >= 400;
    const color = isError ? '#f44336' : '#4caf50';
    const icon = isError ? '❌' : '✅';
    const escapedMessage = escapeHtml(message);
    const escapedDetails = details ? `<p style="color: #666; font-size: 14px; margin-top: 10px;">${escapeHtml(details)}</p>` : '';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(title)}</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #e6f8fa; flex-direction: column; text-align: center; padding: 20px; box-sizing: border-box;">
          <h2 style="color: ${color}; margin-bottom: 10px;">${icon} ${escapedMessage}</h2>
          ${escapedDetails}
          <p style="margin-top: 20px;">You can close this window and return to the bot.</p>
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
          <script>
            if (!${isError}) {
              setTimeout(() => {
                window.close();
                window.Telegram?.WebApp?.close?.();
              }, 3000);
            }
          </script>
        </body>
      </html>
    `;

    return new NextResponse(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}
