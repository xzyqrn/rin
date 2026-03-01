'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const HTTP_TIMEOUT = 15_000;
const MAX_CONTENT_CHARS = 4000;
const MAX_REDIRECTS = 5;

function _normalizeIp(ip) {
  const value = String(ip || '').trim().toLowerCase();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function _isPrivateIpv4(ip) {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function _isPrivateIpv6(ip) {
  const value = String(ip || '').toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10
  if (value.startsWith('ff')) return true; // multicast
  if (value.startsWith('2001:db8')) return true; // documentation block
  return false;
}

function isPrivateIp(ip) {
  const normalized = _normalizeIp(ip);
  const family = net.isIP(normalized);
  if (family === 4) return _isPrivateIpv4(normalized);
  if (family === 6) return _isPrivateIpv6(normalized);
  return true;
}

function isDisallowedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return false;
}

async function resolvePublicIps(hostname) {
  const host = String(hostname || '').trim();
  const literal = _normalizeIp(host);
  if (net.isIP(literal)) {
    if (isPrivateIp(literal)) {
      throw new Error('Access to private/local addresses is not allowed.');
    }
    return [literal];
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error('Could not resolve target hostname.');
  }

  const ips = records
    .map((r) => _normalizeIp(r.address))
    .filter(Boolean);

  if (ips.some((ip) => isPrivateIp(ip))) {
    throw new Error('Access to private/local addresses is not allowed.');
  }
  return ips;
}

async function validateOutgoingUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
    }
    if (isDisallowedHostname(parsed.hostname)) {
      return { ok: false, error: 'Access to private/local addresses is not allowed.' };
    }
    await resolvePublicIps(parsed.hostname);
    return { ok: true, url: parsed.toString() };
  } catch (err) {
    return { ok: false, error: err.message || 'Invalid URL.' };
  }
}

async function fetchSafely(url, requestOptions) {
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const validation = await validateOutgoingUrl(currentUrl);
    if (!validation.ok) return { error: validation.error };

    let response;
    try {
      response = await axios.get(validation.url, {
        ...requestOptions,
        validateStatus: null,
        maxRedirects: 0,
      });
    } catch (err) {
      return { error: err.message || 'Request failed.' };
    }

    const location = response.headers?.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      try {
        currentUrl = new URL(location, validation.url).toString();
      } catch {
        return { error: 'Invalid redirect URL.' };
      }
      continue;
    }

    return { response, finalUrl: validation.url };
  }

  return { error: `Too many redirects (>${MAX_REDIRECTS}).` };
}

async function browseUrl(url) {
  const fetched = await fetchSafely(url, {
    timeout: HTTP_TIMEOUT,
    maxContentLength: 2 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Rin-Bot/1.0; +https://github.com/rin-bot)' },
  });
  if (fetched.error) return { error: fetched.error };

  try {
    const { response, finalUrl } = fetched;
    if (response.status >= 400) {
      return { url: finalUrl, error: `HTTP ${response.status}` };
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return { url: finalUrl, error: `Unsupported content type: ${contentType}` };
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

    return { url: finalUrl, title, text, status: response.status };
  } catch (err) {
    return { url, error: err.message };
  }
}

async function checkUrl(url) {
  const start = Date.now();
  const fetched = await fetchSafely(url, {
    timeout: 10_000,
    maxContentLength: 1024,
    headers: { 'User-Agent': 'Rin-Bot HealthCheck/1.0' },
  });
  if (fetched.error) {
    return { url, ok: false, status: -1, error: fetched.error };
  }
  try {
    const { response, finalUrl } = fetched;
    return {
      url: finalUrl,
      ok: response.status < 400,
      status: response.status,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return { url, ok: false, status: -1, error: err.message };
  }
}

module.exports = {
  browseUrl,
  checkUrl,
  _internals: {
    isPrivateIp,
    isDisallowedHostname,
    validateOutgoingUrl,
  },
};
