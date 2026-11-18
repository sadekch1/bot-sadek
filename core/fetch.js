'use strict';
// ── Service 5: FETCH ────────────────────────────────────────────────
// The only door to the internet for the core and node plugins:
// GET/POST with a real browser User-Agent, retries and timeouts.
// (Bash plugins use curl themselves; this is for the core and .js plugins.)
const axios = require('axios');

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, opts = {}) {
  const tries = opts.tries || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await axios({
        method,
        url,
        timeout: opts.timeout || 30000,
        maxRedirects: 8,
        validateStatus: (s) => s >= 200 && s < 400,
        responseType: opts.responseType || 'text',
        data: opts.data,
        headers: {
          'User-Agent': opts.ua || WEB_UA,
          'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
          ...(opts.referer ? { Referer: opts.referer } : {}),
          ...(opts.headers || {}),
        },
      });
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

async function getText(url, opts = {}) {
  const res = await request('GET', url, opts);
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

async function getJson(url, opts = {}) {
  const res = await request('GET', url, { ...opts, responseType: 'json' });
  return res.data;
}

async function getBuffer(url, opts = {}) {
  const res = await request('GET', url, { ...opts, responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

module.exports = { WEB_UA, sleep, request, getText, getJson, getBuffer };
