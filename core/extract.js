'use strict';
// ── Service 6: EXTRACTION TOOLBOX ───────────────────────────────────
// Shared scraping helpers: m3u8 quality variants, packed-JS unpacking,
// embed-page resolution (embed -> direct file), size probing/estimation,
// and compressed poster images.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { WEB_UA, getText, getBuffer } = require('./fetch');

function fmtBytes(n) {
  if (!n || isNaN(n)) return 'غير معروف';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

// ── m3u8: master playlist -> [{ url, label }] ───────────────────────
function parseM3u8Variants(text, baseUrl) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith('#EXT-X-STREAM-INF')) {
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(ln);
      const bw = /BANDWIDTH=(\d+)/.exec(ln);
      let url = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].trim().startsWith('#')) { url = lines[j].trim(); break; }
      }
      if (!url) continue;
      let abs;
      try { abs = new URL(url, baseUrl).href; } catch (_) { continue; }
      const label = res ? res[2] + 'p' : (bw ? Math.round(+bw[1] / 1000) + ' kbps' : 'جودة ' + (out.length + 1));
      out.push({ url: abs, label, height: res ? +res[2] : 0 });
    }
  }
  out.sort((a, b) => b.height - a.height);
  return out.map(({ url, label }) => ({ url, label }));
}

// If the url is a master playlist, expand it to variants; if it is a
// single-variant playlist, return it as one link.
async function expandM3u8(url, referer) {
  const text = await getText(url, { referer, timeout: 20000 });
  const variants = parseM3u8Variants(text, url);
  if (variants.length) return variants;
  if (/#EXTINF/.test(text)) return [{ url, label: 'بث مباشر/أصلي' }];
  return [];
}

// ── Dean-Edwards packed JS -> unpacked text (pure, no eval) ─────────
function unpackPacked(code) {
  const m = /eval\(function\(p,a,c,k,e,[rd]\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/.exec(code);
  if (!m) return null;
  let payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = parseInt(m[2], 10);
  let count = parseInt(m[3], 10);
  const dict = m[4].split('|');
  const token = (c) => {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (c < radix) return chars[c] || '';
    return token(Math.floor(c / radix)) + chars[c % radix];
  };
  const map = {};
  while (count--) {
    const t = token(count);
    map[t] = dict[count] || t;
  }
  payload = payload.replace(/\b\w+\b/g, (w) => map[w] || w);
  return payload;
}

function findStreamUrls(text) {
  const urls = [];
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  let mm;
  while ((mm = re.exec(text))) {
    const u = mm[0].replace(/[),;]+$/, '');
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

// ── Embed page -> direct stream/file ────────────────────────────────
// Returns [{ url, label }] (best first) or [] when nothing is found.
async function resolveEmbed(embedUrl, referer) {
  try {
    let html = await getText(embedUrl, { referer, timeout: 25000 });
    let text = html;
    if (/eval\(function\(p,a,c,k,e/.test(html)) {
      const un = unpackPacked(html);
      if (un) text = un + '\n' + html;
    }
    const urls = findStreamUrls(text);
    if (!urls.length) return [];
    const m3u8 = urls.find((u) => u.includes('.m3u8'));
    if (m3u8) {
      try {
        const variants = await expandM3u8(m3u8, embedUrl);
        if (variants.length) return variants.map((v) => ({ ...v, label: v.label }));
      } catch (_) {}
      return [{ url: m3u8, label: 'HLS' }];
    }
    return urls.map((u, i) => ({ url: u, label: 'MP4 ' + (i + 1) }));
  } catch (_) {
    return [];
  }
}

// ── Sizes ───────────────────────────────────────────────────────────
async function probeSize(url, referer) {
  const headers = { 'User-Agent': WEB_UA, ...(referer ? { Referer: referer } : {}) };
  try {
    const res = await axios.head(url, { headers, timeout: 15000, maxRedirects: 8, validateStatus: () => true });
    const len = parseInt(res.headers['content-length'], 10);
    if (len > 0) return len;
  } catch (_) {}
  try {
    const res = await axios.get(url, { headers: { ...headers, Range: 'bytes=0-0' }, timeout: 15000, maxRedirects: 8, validateStatus: () => true, responseType: 'arraybuffer' });
    const cr = res.headers['content-range'];
    if (cr && /\/(\d+)$/.test(cr)) return parseInt(/\/(\d+)$/.exec(cr)[1], 10);
    const len = parseInt(res.headers['content-length'], 10);
    if (len > 1) return len;
  } catch (_) {}
  return null;
}

async function estimateHlsSize(playlistUrl, referer) {
  try {
    let text = await getText(playlistUrl, { referer, timeout: 20000 });
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const variants = parseM3u8Variants(text, playlistUrl);
      if (!variants.length) return null;
      playlistUrl = variants[0].url;
      text = await getText(playlistUrl, { referer, timeout: 20000 });
    }
    const lines = text.split('\n');
    const segs = [];
    let totalDur = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (ln.startsWith('#EXTINF:')) {
        const d = parseFloat(ln.slice(8));
        if (!isNaN(d)) totalDur += d;
      } else if (ln && !ln.startsWith('#')) {
        try { segs.push(new URL(ln, playlistUrl).href); } catch (_) {}
      }
    }
    if (!segs.length || !totalDur) return null;
    const picks = [segs[0], segs[Math.floor(segs.length / 2)], segs[segs.length - 1]];
    const sizes = [];
    for (const s of picks) {
      const sz = await probeSize(s, referer);
      if (sz) sizes.push(sz);
    }
    if (!sizes.length) return null;
    const avgSeg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const avgDur = totalDur / segs.length;
    return Math.round((avgSeg / avgDur) * totalDur);
  } catch (_) {
    return null;
  }
}

// Mutates link labels: "720p" -> "720p — 1.10 GB" (exact) or "— ~1.10 GB" (HLS estimate)
async function attachSizes(links) {
  const jobs = links.slice(0, 8).map(async (l) => {
    try {
      if (/\.m3u8($|\?)/i.test(l.url)) {
        const est = await estimateHlsSize(l.url, l.referer);
        if (est) l.label = l.label + ' — ~' + fmtBytes(est);
      } else {
        const sz = await probeSize(l.url, l.referer);
        if (sz) l.label = l.label + ' — ' + fmtBytes(sz);
      }
    } catch (_) {}
  });
  await Promise.allSettled(jobs);
  return links;
}

// ── Posters: compress any image to a small JPEG (<=540px) ───────────
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err.slice(-200)))));
  });
}

async function compressPosterBuffer(buf) {
  const dir = path.join(process.cwd(), 'dltmp');
  fs.mkdirSync(dir, { recursive: true });
  const tag = 'poster_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const inP = path.join(dir, tag + '.in');
  const outP = path.join(dir, tag + '.jpg');
  try {
    fs.writeFileSync(inP, buf);
    await runFfmpeg(['-y', '-i', inP, '-vf', 'scale=min(540\\,iw):-2', '-q:v', '5', outP]);
    let out = fs.readFileSync(outP);
    if (out.length > 350 * 1024) {
      await runFfmpeg(['-y', '-i', inP, '-vf', 'scale=min(400\\,iw):-2', '-q:v', '8', outP]);
      out = fs.readFileSync(outP);
    }
    if (out.length >= 800 && out.length <= 900 * 1024) return out;
    return null;
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(inP); } catch (_) {}
    try { fs.unlinkSync(outP); } catch (_) {}
  }
}

async function posterBufferFromUrl(url, referer) {
  try {
    const buf = await getBuffer(url, { referer, timeout: 20000 });
    if (!buf.length || buf.length > 15 * 1024 * 1024) return null;
    return await compressPosterBuffer(buf);
  } catch (_) {
    return null;
  }
}

function extractOgImage(html, pageUrl) {
  const pats = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of pats) {
    const m = re.exec(html);
    if (m) { try { return new URL(m[1], pageUrl).href; } catch (_) {} }
  }
  const tmdb = /https:\/\/image\.tmdb\.org\/[^\s"'<>]+/.exec(html);
  if (tmdb) return tmdb[0];
  return null;
}

module.exports = {
  fmtBytes, parseM3u8Variants, expandM3u8, unpackPacked, findStreamUrls,
  resolveEmbed, probeSize, estimateHlsSize, attachSizes,
  runFfmpeg, compressPosterBuffer, posterBufferFromUrl, extractOgImage,
};
