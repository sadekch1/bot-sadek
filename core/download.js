'use strict';
// ── Service 3: DOWNLOAD ─────────────────────────────────────────────
// One trusted way to turn a URL into a file in the chat:
//  - embed pages are resolved to direct streams first
//  - HLS (.m3u8) is saved with ffmpeg (stream copy)
//  - files are downloaded in a SINGLE stream and size-verified
//    (never trust parallel chunks: hosts cut them and short parts
//     used to merge silently into corrupt files)
//  - files over 2 GB are sent as sequential, size-verified parts
//    (part downloaded -> verified -> sent -> deleted -> next);
//    the bot NEVER merges parts — the user merges them himself.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { WEB_UA, sleep } = require('./fetch');
const { probeSize, resolveEmbed, runFfmpeg, fmtBytes } = require('./extract');

const MAX_DIRECT = 2000 * 1048576; // ~2 GB WhatsApp document ceiling

function tmpDir() {
  const d = path.join(process.cwd(), 'dltmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rm(p) { try { fs.unlinkSync(p); } catch (_) {} }

async function streamToFile(url, dest, headers) {
  const res = await axios.get(url, {
    headers, responseType: 'stream', timeout: 0, maxRedirects: 8,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const total = parseInt(res.headers['content-length'], 10) || 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    res.data.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.data.pipe(ws);
  });
  return total;
}

async function rangedPart(url, start, end, dest, headers) {
  const res = await axios.get(url, {
    headers: { ...headers, Range: `bytes=${start}-${end}` },
    responseType: 'stream', timeout: 0, maxRedirects: 8,
    validateStatus: (s) => s === 206 || s === 200,
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    res.data.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.data.pipe(ws);
  });
  return fs.statSync(dest).size;
}

async function muxSubtitle(filePath, subtitleUrl) {
  if (!subtitleUrl) return filePath;
  const dir = tmpDir();
  const subPath = path.join(dir, 'sub_' + Date.now() + '.srt');
  const outPath = filePath.replace(/(\.mp4)?$/i, '') + '_sub.mp4';
  try {
    const res = await axios.get(subtitleUrl, { timeout: 30000, responseType: 'arraybuffer', headers: { 'User-Agent': WEB_UA } });
    fs.writeFileSync(subPath, Buffer.from(res.data));
    await runFfmpeg(['-y', '-i', filePath, '-i', subPath, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=ar', outPath]);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      rm(filePath);
      return outPath;
    }
  } catch (_) {}
  finally { rm(subPath); }
  return filePath;
}

// Download an HLS stream (VOD) to a single mp4 with ffmpeg stream copy.
async function downloadHls(url, dest, headers) {
  const args = ['-y'];
  const hdr = Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  if (hdr) args.push('-headers', hdr);
  args.push('-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', dest);
  await runFfmpeg(args);
  return fs.statSync(dest).size;
}

// Main entry.
// opts: { url, title, headers?, referer?, subtitleUrl?, partMB?, asDocument? }
// Returns true when something was delivered.
async function downloadAndSend(ctx, opts) {
  const { msgr, chatId, quoted } = ctx;
  let url = opts.url;
  const headers = { 'User-Agent': WEB_UA, ...(opts.referer ? { Referer: opts.referer } : {}), ...(opts.headers || {}) };
  const dir = tmpDir();
  const tag = 'dl_' + Date.now();

  // 1) Embed page? Resolve to direct streams and take the best one.
  if (!/\.(mp4|mkv|mov|webm|m3u8|mpd)($|\?)/i.test(url)) {
    const resolved = await resolveEmbed(url, opts.referer);
    if (resolved.length) url = resolved[0].url;
  }

  const isHls = /\.m3u8($|\?)/i.test(url);

  // 2) HLS -> one mp4 via ffmpeg.
  if (isHls) {
    const out = path.join(dir, tag + '.mp4');
    try {
      await msgr.sendText(chatId, `⏳ جاري تحميل *${opts.title}* ...`, { quoted });
      const size = await downloadHls(url, out, headers);
      let finalPath = await muxSubtitle(out, opts.subtitleUrl);
      await msgr.sendDocument(chatId, finalPath, (opts.title || 'video') + '.mp4', `✅ *${opts.title}*\n📦 ${fmtBytes(size)}`, { quoted });
      rm(finalPath);
      return true;
    } catch (e) {
      rm(out);
      await msgr.sendText(chatId, `❌ فشل التحميل: ${e.message}`, { quoted });
      return false;
    }
  }

  // 3) Direct file. Probe its size first.
  let size = await probeSize(url, opts.referer);
  const partMB = opts.partMB || 500;
  const partBytes = partMB * 1048576;

  // 3a) Too big for one message -> sequential verified parts, never merged.
  if (size && size > MAX_DIRECT) {
    const totalParts = Math.ceil(size / partBytes);
    await msgr.sendText(chatId, `🧩 *${opts.title}*\nالملف كبير (${fmtBytes(size)}) — سيصلك في ${totalParts} أجزاء من ${partMB} MB. ادمجها بنفسك بعد اكتمالها.`, { quoted });
    for (let i = 0; i < totalParts; i++) {
      const start = i * partBytes;
      const end = Math.min(size - 1, start + partBytes - 1);
      const want = end - start + 1;
      const partPath = path.join(dir, `${tag}.part${String(i + 1).padStart(2, '0')}`);
      let got = 0;
      for (let attempt = 0; attempt < 2 && got !== want; attempt++) {
        try { got = await rangedPart(url, start, end, partPath, headers); } catch (_) { got = 0; }
        if (got !== want) await sleep(1500);
      }
      if (got !== want) {
        rm(partPath);
        await msgr.sendText(chatId, `❌ توقف عند الجزء ${i + 1}/${totalParts} — وصلك ${i} أجزاء سليمة.`, { quoted });
        return false;
      }
      const name = `${opts.title}.part${String(i + 1).padStart(2, '0')}`;
      await msgr.sendDocument(chatId, partPath, name, `🧩 جزء ${i + 1}/${totalParts} — *${opts.title}*`, { quoted });
      rm(partPath);
    }
    await msgr.sendText(chatId, `✅ اكتمل إرسال كل أجزاء *${opts.title}* (${totalParts} أجزاء).`, { quoted });
    return true;
  }

  // 3b) One file: single stream + final size verification (one retry).
  const ext = (/\.([a-z0-9]{2,5})($|\?)/i.exec(url) || [])[1] || 'mp4';
  const out = path.join(dir, tag + '.' + ext);
  try {
    await msgr.sendText(chatId, `⏳ جاري تحميل *${opts.title}* ...`, { quoted });
    let got = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      await streamToFile(url, out, headers);
      got = fs.statSync(out).size;
      if (!size || got === size) break;
      if (attempt === 1) throw new Error(`وصل ${fmtBytes(got)} من أصل ${fmtBytes(size)}`);
      await sleep(1500);
    }
    let finalPath = out;
    if (opts.subtitleUrl && /\.mp4$/i.test(out)) finalPath = await muxSubtitle(out, opts.subtitleUrl);
    const caption = `✅ *${opts.title}*\n📦 ${fmtBytes(fs.statSync(finalPath).size)}`;
    if (opts.asDocument || !/\.mp4$/i.test(finalPath)) {
      await msgr.sendDocument(chatId, finalPath, (opts.title || 'file') + path.extname(finalPath), caption, { quoted });
    } else {
      await msgr.sendVideo(chatId, finalPath, caption, { quoted });
    }
    rm(finalPath);
    return true;
  } catch (e) {
    rm(out);
    await msgr.sendText(chatId, `❌ فشل التحميل: ${e.message}`, { quoted });
    return false;
  }
}

module.exports = { downloadAndSend, downloadHls, streamToFile, rangedPart, MAX_DIRECT };
