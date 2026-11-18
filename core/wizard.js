'use strict';
// ── Service 2: LISTS & PICKING (the wizard) ─────────────────────────
// The conversation layer plugins never re-implement:
// show a numbered list -> wait for the pick; show episode prompt ->
// accept a number or a range like 1-15; show qualities -> wait.
// ctx = { msgr, chatId, senderId, quoted } (quoted = user's message)

// Pick one item from a numbered list. Returns the index or -1.
async function pickFromList(ctx, { header, items, footer }) {
  const lines = items.map((label, i) => `${i + 1} - ${label}`);
  const text = `${header}\n\n${lines.join('\n')}\n\n${footer || '💡 رد (Reply) على هذه الرسالة برقم الاختيار.'}`;
  const sent = await ctx.msgr.sendText(ctx.chatId, text, { quoted: ctx.quoted });
  const reply = await ctx.msgr.awaitReply(sent.key.id, { chatId: ctx.chatId, senderId: ctx.senderId });
  if (reply === null) return -1;
  const n = parseInt(String(reply).trim(), 10);
  if (isNaN(n) || n < 1 || n > items.length) {
    await ctx.msgr.sendText(ctx.chatId, '❌ رقم غير صحيح.', { quoted: ctx.quoted });
    return -1;
  }
  return n - 1;
}

// Parse an episode pick: "7" -> { type:'single', from:7, to:7 }
// "1-15" -> { type:'range', from:1, to:15 }. null when invalid.
function parseEpisodePick(text, count) {
  const t = String(text || '').trim();
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
  if (range) {
    let a = parseInt(range[1], 10);
    let b = parseInt(range[2], 10);
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > count || b - a > 60) return null;
    return { type: 'range', from: a, to: b };
  }
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (n < 1 || n > count) return null;
    return { type: 'single', from: n, to: n };
  }
  return null;
}

// Episode prompt: if a poster buffer is given it becomes the prompt
// message itself (caption = title + source + count only), else text.
// Returns parseEpisodePick result or null.
async function pickEpisode(ctx, { title, sourceTag, count, poster }) {
  const caption = `📺 *${title}*\n${sourceTag}\n🔢 عدد الحلقات: ${count}\n\n💡 رد (Reply) على هذه الرسالة برقم الحلقة، أو بمدى مثل 1-15 لتحميل عدة حلقات دفعة واحدة.`;
  let sent;
  if (poster) {
    sent = await ctx.msgr.sendImage(ctx.chatId, poster, caption, { quoted: ctx.quoted });
  } else {
    sent = await ctx.msgr.sendText(ctx.chatId, caption, { quoted: ctx.quoted });
  }
  const reply = await ctx.msgr.awaitReply(sent.key.id, { chatId: ctx.chatId, senderId: ctx.senderId });
  if (reply === null) return null;
  const pick = parseEpisodePick(reply, count);
  if (!pick) {
    await ctx.msgr.sendText(ctx.chatId, `❌ اختيار غير صحيح — المسلسل فيه ${count} حلقة.`, { quoted: ctx.quoted });
    return null;
  }
  return pick;
}

// Quality pick: links = [{ url, label }]. Sizes are attached by the
// caller (extract.attachSizes). Returns the chosen link or null.
async function pickQuality(ctx, { title, links }) {
  const idx = await pickFromList(ctx, {
    header: `🎬 *${title}*\nاختر الجودة:`,
    items: links.map((l) => l.label),
  });
  return idx >= 0 ? links[idx] : null;
}

module.exports = { pickFromList, parseEpisodePick, pickEpisode, pickQuality };
