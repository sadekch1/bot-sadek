'use strict';
// ── Service 4: RECORDING ────────────────────────────────────────────
// Record a live stream (HLS or DASH) with ffmpeg STREAM COPY ONLY
// (the host is weak — no re-encoding), split into time parts, and send
// each part as soon as it is closed. One active recording per chat.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fmtBytes } = require('./extract');
const { sleep } = require('./fetch');

const active = new Map(); // chatId -> { stop: () => void }

function isRecording(chatId) { return active.has(chatId); }

function stopRecording(chatId) {
  const rec = active.get(chatId);
  if (rec) { rec.stop(); return true; }
  return false;
}

// opts: { url, title, totalMin, partMin, headers?, decryptionKey? }
async function recordStream(ctx, opts) {
  const { msgr, chatId, quoted } = ctx;
  if (active.has(chatId)) {
    await msgr.sendText(chatId, '⚠️ يوجد تسجيل جارٍ في هذه المحادثة. أوقفه أولاً بـ .stoprec', { quoted });
    return false;
  }
  const totalMin = Math.min(360, Math.max(1, opts.totalMin || 60));
  const partMin = Math.max(1, opts.partMin || Math.ceil(totalMin / 6));
  const dir = path.join(process.cwd(), 'dltmp', 'rec_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });

  const args = ['-y'];
  const hdr = Object.entries(opts.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  if (hdr) args.push('-headers', hdr);
  if (opts.decryptionKey) args.push('-decryption_key', opts.decryptionKey);
  args.push(
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', opts.url,
    '-t', String(totalMin * 60),
    '-c', 'copy',
    '-f', 'segment', '-segment_time', String(partMin * 60), '-reset_timestamps', '1',
    path.join(dir, 'part%03d.mp4')
  );

  await msgr.sendText(chatId, `🔴 بدأ تسجيل *${opts.title}*\n⏱ المدة: ${totalMin} دقيقة — جزء كل ${partMin} دقيقة.\nللإيقاف: .stoprec`, { quoted });

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stopped = false;
  active.set(chatId, { stop: () => { stopped = true; try { proc.kill('SIGINT'); } catch (_) {} } });

  const sent = new Set();
  const lastSize = new Map();
  let partNo = 0;

  async function sendClosedParts(final) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^part\d+\.mp4$/.test(f)).sort(); } catch (_) {}
    for (const f of files) {
      if (sent.has(f)) continue;
      const p = path.join(dir, f);
      let sz = 0;
      try { sz = fs.statSync(p).size; } catch (_) { continue; }
      const stable = lastSize.get(f) === sz && sz > 0;
      lastSize.set(f, sz);
      const isLastFile = f === files[files.length - 1];
      if (!final && (isLastFile || !stable)) continue; // still being written
      sent.add(f);
      partNo++;
      try {
        await msgr.sendDocument(chatId, p, `${opts.title} - جزء ${partNo}.mp4`, `🎞 جزء ${partNo} — *${opts.title}* (${fmtBytes(sz)})`, { quoted });
      } catch (_) {}
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }

  const watcher = (async () => {
    while (active.has(chatId)) {
      await sendClosedParts(false);
      await sleep(5000);
    }
  })();

  const exitCode = await new Promise((resolve) => {
    proc.on('error', () => resolve(-1));
    proc.on('close', (code) => resolve(code));
  });

  active.delete(chatId);
  await watcher.catch(() => {});
  await sendClosedParts(true);
  try { fs.rmdirSync(dir); } catch (_) {}

  await msgr.sendText(chatId, stopped
    ? `⏹ توقف تسجيل *${opts.title}* — أُرسل ${partNo} أجزاء.`
    : `✅ انتهى تسجيل *${opts.title}* — أُرسل ${partNo} أجزاء.`, { quoted });
  return partNo > 0;
}

module.exports = { recordStream, stopRecording, isRecording };
