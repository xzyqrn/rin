import { NextResponse } from 'next/server';

export function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export function errorHtmlResponse(message: string, status: number = 400) {
    const safeMessage = escapeHtml(message);
    const html = `
      <html>
        <head>
          <meta charset="utf-8">
          <title>Error</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff0f0; flex-direction: column;">
          <h2 style="color: #d32f2f;">❌ Authentication Error</h2>
          <p style="color: #555; text-align: center; max-width: 80%;">${safeMessage}</p>
          <p style="color: #777; font-size: 14px;">You can close this window and try again.</p>
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #d32f2f; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#b71c1c'" onmouseout="this.style.background='#d32f2f'">Close App</button>
        </body>
      </html>
    `;

    return new NextResponse(html, {
        status,
        headers: { 'Content-Type': 'text/html' }
    });
}

export const SUCCESS_HTML = `
      <html>
        <head>
          <meta charset="utf-8">
          <title>Success</title>
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
        </head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #e6f8fa; flex-direction: column;">
          <h2 style="color: #4caf50;">✅ Google Account successfully linked!</h2>
          <p>Your tokens have been saved to the database.</p>
          <p>You can close this window and return to the bot. This window will close automatically.</p>
          <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window" style="padding: 10px 20px; font-size: 16px; background: #0088cc; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 20px; transition: background 0.2s;" onmouseover="this.style.background='#0077b3'" onmouseout="this.style.background='#0088cc'">Close App</button>
          <script>
            setTimeout(() => {
              window.close();
              window.Telegram?.WebApp?.close?.();
            }, 3000);
          </script>
        </body>
      </html>
`;
