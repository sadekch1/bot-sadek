'use strict';
// ═══════════════════════════════════════════════════════════════════
//  SADEK BOT v2 — THE CORE
//  This file only: connects WhatsApp, loads plugins, routes messages.
//  All features live in plugins/. All shared machinery lives in core/.
//  You should rarely need to edit this file.
// ═══════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const store = require('./core/store');
const { Messenger, messageText, quotedMessageId } = require('./core/messenger');
const { loadPlugins } = require('./core/loader');
const { runSourceFlow, TYPE_LABEL } = require('./core/sourceflow');
const record = require('./core/record');

const config = store.loadConfig();
let registry = loadPlugins();
let msgr = null;
let pairingAsked = false;

const SOURCE_COMMANDS = { '.anime': 'anime', '.series': 'series', '.movie': 'movie', '.kdrama': 'kdrama' };

function helpText() {
  const lines = [`🤖 *${config.botName}*`, ''];
  lines.push('*الأوامر الأساسية:*');
  for (const [cmd, type] of Object.entries(SOURCE_COMMANDS)) {
    const n = (registry.sources.get(type) || []).length;
    if (n) lines.push(`${cmd} <اسم> — بحث ${TYPE_LABEL[type]} (${n} مصادر)`);
  }
  lines.push('.stoprec — إيقاف التسجيل الجاري');
  lines.push('.ping — فحص البوت');
  lines.push('.plugins — قائمة الإضافات المحملة');
  const cmds = [...registry.commands.values()];
  if (cmds.length) {
    lines.push('', '*أوامر الإضافات:*');
    const seen = new Set();
    for (const c of cmds) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      lines.push(c.help || c.name);
    }
  }
  return lines.join('\n');
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), 'session'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Sadek Bot v2', 'Chrome', '2.0.0'],
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
  });
  msgr = new Messenger(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'connecting') console.log('[bot] connecting...');
    if (connection === 'open') console.log('[bot] connected ✔');
    if (!state.creds.registered && config.phone && !pairingAsked) {
      pairingAsked = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.phone);
          console.log('════════════════════════════════════════');
          console.log('  PAIRING CODE: ' + code);
          console.log('  Enter it in WhatsApp > Linked devices');
          console.log('════════════════════════════════════════');
        } catch (e) {
          console.log('[bot] pairing failed: ' + e.message);
        }
      }, 4000);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[bot] connection closed, status=' + statusCode + (loggedOut ? ' (logged out)' : ', reconnecting...'));
      if (!loggedOut) setTimeout(() => start().catch((e) => console.log('[bot] restart error: ' + e.message)), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const mek of messages) {
      try { await handleMessage(sock, mek); } catch (e) { console.log('[bot] message error: ' + e.message); }
    }
  });

  console.log('[bot] starting ' + config.botName + ' — sources: ' +
    [...registry.sources.entries()].map(([t, arr]) => `${t}:${arr.length}`).join(' ') +
    ' — commands: ' + registry.commands.size);
}

async function handleMessage(sock, mek) {
  if (!mek.message || (mek.key && mek.key.fromMe)) return;
  const chatId = mek.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;
  const senderId = mek.key.participant || mek.key.remoteJid || '';
  const text = messageText(mek);
  const quotedId = quotedMessageId(mek);
  const ctx = { msgr, chatId, senderId, quoted: mek, sock, config, partMB: config.partMB, registry };

  // 1) A reply someone (a wizard) is waiting for?
  if (msgr.dispatchReply({ quotedId, chatId, senderId, text })) return;
  if (!text) return;

  const lower = text.toLowerCase();
  const cmd = lower.split(/\s+/)[0];
  const args = text.slice(cmd.length).trim();

  // 2) Built-ins
  if (cmd === '.help' || cmd === '.menu') {
    await msgr.sendText(chatId, helpText(), { quoted: mek });
    return;
  }
  if (cmd === '.ping') {
    const up = Math.floor(process.uptime());
    await msgr.sendText(chatId, `🏓 شغال — منذ ${Math.floor(up / 3600)} ساعة و${Math.floor((up % 3600) / 60)} دقيقة.`, { quoted: mek });
    return;
  }
  if (cmd === '.plugins') {
    const lines = ['🧩 *الإضافات المحملة:*'];
    for (const [type, arr] of registry.sources.entries()) {
      lines.push(`\n*${type}:*`);
      for (const s of arr) lines.push(`- ${s.name} (${s.kind})`);
    }
    if (registry.commands.size) {
      lines.push('\n*commands:*');
      const seen = new Set();
      for (const [c, p] of registry.commands.entries()) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        lines.push(`- ${p.name}: ${[...registry.commands.entries()].filter(([, v]) => v.name === p.name).map(([k]) => k).join(' ')}`);
      }
    }
    if (registry.errors.length) lines.push('\n⚠️ تخطّى التحميل: ' + registry.errors.length);
    await msgr.sendText(chatId, lines.join('\n'), { quoted: mek });
    return;
  }
  if (cmd === '.stoprec') {
    const ok = record.stopRecording(chatId);
    await msgr.sendText(chatId, ok ? '⏹ جاري إيقاف التسجيل...' : 'لا يوجد تسجيل جارٍ هنا.', { quoted: mek });
    return;
  }
  if (cmd === '.reload') {
    registry = loadPlugins();
    ctx.registry = registry;
    await msgr.sendText(chatId, '🔄 أعدت تحميل الإضافات. انظر .plugins للقائمة.', { quoted: mek });
    return;
  }

  // 3) Source wizard commands
  if (SOURCE_COMMANDS[cmd]) {
    if (!args) {
      await msgr.sendText(chatId, `اكتب الاسم بعد الأمر، مثال: ${cmd} ناروتو`, { quoted: mek });
      return;
    }
    runSourceFlow(ctx, registry, SOURCE_COMMANDS[cmd], args).catch((e) => console.log('[flow] ' + e.message));
    return;
  }

  // 4) Command plugins
  const plugin = registry.commands.get(cmd);
  if (plugin) {
    Promise.resolve(plugin.mod.handle({ ...ctx, args, text, cmd })).catch(async (e) => {
      console.log('[plugin] ' + plugin.name + ': ' + e.message);
      try { await msgr.sendText(chatId, '❌ خطأ في الإضافة: ' + e.message, { quoted: mek }); } catch (_) {}
    });
    return;
  }
}

start().catch((e) => console.log('[bot] fatal: ' + e.message));
