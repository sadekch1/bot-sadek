'use strict';
// ── Service 1: MESSAGES & REPLIES ───────────────────────────────────
// Sending wrappers + the reply registry: the core remembers which sent
// message waits for a reply, from whom, and delivers the reply text to
// the waiting flow. Every interaction in the bot rides on this.

class Messenger {
  constructor(sock) {
    this.sock = sock;
    this.waiters = new Map(); // sentMsgId -> { resolve, chatId, senderId, timer }
  }

  async sendText(chatId, text, opts = {}) {
    return this.sock.sendMessage(chatId, { text, ...(opts.linkPreview === null ? { linkPreview: null } : {}) }, opts.quoted ? { quoted: opts.quoted } : undefined);
  }

  async sendImage(chatId, buffer, caption, opts = {}) {
    return this.sock.sendMessage(chatId, { image: buffer, caption }, opts.quoted ? { quoted: opts.quoted } : undefined);
  }

  async sendVideo(chatId, filePath, caption, opts = {}) {
    const fs = require('fs');
    return this.sock.sendMessage(chatId, { video: fs.readFileSync(filePath), caption, ...(opts.gif ? { gifPlayback: true } : {}) }, opts.quoted ? { quoted: opts.quoted } : undefined);
  }

  async sendDocument(chatId, filePath, fileName, caption, opts = {}) {
    const fs = require('fs');
    return this.sock.sendMessage(chatId, { document: fs.readFileSync(filePath), fileName, mimetype: opts.mimetype || 'video/mp4', caption }, opts.quoted ? { quoted: opts.quoted } : undefined);
  }

  async sendPresence(chatId, state) {
    try { await this.sock.sendPresenceUpdate(state, chatId); } catch (_) {}
  }

  // Wait for a reply (quote) to a message we just sent.
  // Resolves with the reply text, or null on timeout.
  awaitReply(sentMsgId, { chatId, senderId, timeoutMs = 300000 } = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sentMsgId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(sentMsgId, { resolve, chatId, senderId, timer });
    });
  }

  // Called by the router for every incoming message.
  // Returns true when the message was a reply someone was waiting for.
  dispatchReply({ quotedId, chatId, senderId, text }) {
    if (!quotedId) return false;
    const w = this.waiters.get(quotedId);
    if (!w) return false;
    if (w.chatId && w.chatId !== chatId) return false;
    if (w.senderId && w.senderId !== senderId) return false;
    clearTimeout(w.timer);
    this.waiters.delete(quotedId);
    w.resolve(text || '');
    return true;
  }
}

// Helpers to read an incoming Baileys message.
function messageText(mek) {
  const m = mek.message || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    ''
  ).trim();
}

function quotedMessageId(mek) {
  const m = mek.message || {};
  const parts = [m.extendedTextMessage, m.imageMessage, m.videoMessage, m.documentMessage, m.buttonsResponseMessage, m.listResponseMessage];
  for (const p of parts) {
    if (p && p.contextInfo && p.contextInfo.stanzaId) return p.contextInfo.stanzaId;
  }
  return null;
}

module.exports = { Messenger, messageText, quotedMessageId };
