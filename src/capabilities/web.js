'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const HTTP_TIMEOUT = 15_000;
const MAX_CONTENT_CHARS = 4000;

// Basic SSRF guard — block private/loopback addresses
function isPrivateHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|\[::\]|\[fc[0-9a-f]{2}:|\[fd[0-9a-f]{2}:)/i.test(host);
  } catch {
    return true;
  }
}

async function browseUrl(url) {
  if (isPrivateHost(url)) {
    return { error: 'Access to private/local addresses is not allowed.' };
  }

  try {
    const response = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Rin-Bot/1.0; +https://github.com/rin-bot)' },
      validateStatus: null,
    });

    if (response.status >= 400) {
      return { url, error: `HTTP ${response.status}` };
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return { url, error: `Unsupported content type: ${contentType}` };
    }

    const $ = cheerio.load(response.data);
    $('script, style, nav, footer, header, aside, iframe, [hidden]').remove();

    const title = $('title').text().trim();
    const body  = ($('main, article, [role="main"]').first().text() || $('body').text())
      .replace(/\s+/g, ' ')
      .trim();

    const text = body.length > MAX_CONTENT_CHARS
      ? body.slice(0, MAX_CONTENT_CHARS) + `\n... [truncated — ${body.length - MAX_CONTENT_CHARS} more chars]`
      : body;

    return { url, title, text, status: response.status };
  } catch (err) {
    return { url, error: err.message };
  }
}

async function checkUrl(url) {
  if (isPrivateHost(url)) {
    return { url, ok: false, status: -1, error: 'Access to private/local addresses is not allowed.' };
  }

  try {
    const start = Date.now();
    const response = await axios.get(url, {
      timeout: 10_000,
      validateStatus: null,
      maxContentLength: 1024,
    });
    return {
      url,
      ok: response.status < 400,
      status: response.status,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return { url, ok: false, status: -1, error: err.message };
  }
}

module.exports = { browseUrl, checkUrl };
