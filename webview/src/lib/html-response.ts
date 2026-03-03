import { NextResponse } from 'next/server';

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

const TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>TITLE_PLACEHOLDER</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        body {
            font-family: sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: BG_COLOR;
            flex-direction: column;
            text-align: center;
            padding: 20px;
        }
        h2 {
            color: TITLE_COLOR;
            margin-bottom: 10px;
        }
        p {
            color: #333;
            max-width: 400px;
            line-height: 1.5;
        }
        button {
            padding: 10px 20px;
            font-size: 16px;
            background: #0088cc;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 20px;
            transition: background 0.2s;
        }
        button:hover {
            background: #0077b3;
        }
    </style>
</head>
<body>
    <h2>TITLE_PLACEHOLDER</h2>
    <p>MESSAGE_PLACEHOLDER</p>
    <p>You can close this window and return to the bot. This window will close automatically.</p>
    <button onclick="window.close(); window.Telegram?.WebApp?.close?.();" aria-label="Close this window">Close App</button>
    <script>
        setTimeout(() => {
            window.close();
            window.Telegram?.WebApp?.close?.();
        }, 3000);
    </script>
</body>
</html>
`;

export function successResponse(title: string, message: string) {
    const html = TEMPLATE
        .split('TITLE_PLACEHOLDER').join(escapeHtml(title))
        .split('MESSAGE_PLACEHOLDER').join(escapeHtml(message))
        .split('BG_COLOR').join('#e6f8fa')
        .split('TITLE_COLOR').join('#4caf50');

    return new NextResponse(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
    });
}

export function errorResponse(title: string, message: string, status: number) {
    const html = TEMPLATE
        .split('TITLE_PLACEHOLDER').join(escapeHtml(title))
        .split('MESSAGE_PLACEHOLDER').join(escapeHtml(message))
        .split('BG_COLOR').join('#fff0f0')
        .split('TITLE_COLOR').join('#d32f2f');

    return new NextResponse(html, {
        status,
        headers: { 'Content-Type': 'text/html' }
    });
}
