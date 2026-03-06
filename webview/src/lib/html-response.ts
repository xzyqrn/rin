import { NextResponse } from 'next/server';

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export function htmlResponse(title: string, message: string, isError: boolean, status: number) {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const titleColor = isError ? '#f44336' : '#4caf50';
    const bgColor = isError ? '#ffebee' : '#e6f8fa';
    const icon = isError ? '❌' : '✅';

    return new NextResponse(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${safeTitle}</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: ${bgColor}; flex-direction: column; text-align: center; padding: 20px; box-sizing: border-box;">
          <h2 style="color: ${titleColor};">${icon} ${safeTitle}</h2>
          <p style="color: #333; max-width: 400px; line-height: 1.5;">${safeMessage}</p>
          <p style="color: #666; font-size: 0.9em; margin-bottom: 20px;">You can close this window and return to the bot.</p>
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
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
    `, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}
