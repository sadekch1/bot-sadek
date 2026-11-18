'use strict';
// ── SOURCE FLOW (the wizard commands .anime/.series/.movie/.kdrama) ─
// One engine for every source type:
//   search all plugins of the type in parallel -> merged numbered list
//   -> pick -> poster (compressed) as the episode prompt when possible
//   -> episode pick (number or range) -> links -> quality pick
//   -> core download service. Movies skip the episode steps.
const { sourceSearch, sourceEpisodes, sourceLinks } = require('./loader');
const wizard = require('./wizard');
const { attachSizes, posterBufferFromUrl } = require('./extract');
const { downloadAndSend } = require('./download');

const TYPE_LABEL = { anime: 'أنمي', series: 'مسلسل', movie: 'فيلم', kdrama: 'دراما كورية' };

async function runSourceFlow(ctx, registry, type, query) {
  const { msgr, chatId, quoted } = ctx;
  const sources = registry.sources.get(type) || [];
  if (!sources.length) {
    await msgr.sendText(chatId, `❌ لا توجد مصادر مسجلة من نوع ${type} بعد. أضف plugin في مجلد plugins.`, { quoted });
    return;
  }
  await msgr.sendText(chatId, `🔍 جاري البحث عن *${query}* في ${sources.length} مصادر...`, { quoted });

  const settled = await Promise.allSettled(sources.map((s) => sourceSearch(s, query)));
  const results = [];
  const seen = new Set();
  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') return;
    for (const item of (res.value || []).slice(0, 8)) {
      const key = String(item.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push({ ...item, _src: sources[i] });
      if (results.length >= 15) break;
    }
  });

  if (!results.length) {
    await msgr.sendText(chatId, `❌ لا نتائج عن *${query}*.`, { quoted });
    return;
  }

  const pickIdx = await wizard.pickFromList(ctx, {
    header: `📋 نتائج *${query}* (${TYPE_LABEL[type] || type}):`,
    items: results.map((r) => `${r.title} [${r._src.name}]`),
  });
  if (pickIdx < 0) return;
  const selected = results[pickIdx];
  const src = selected._src;

  // Movie: straight to links.
  if (type === 'movie') {
    await sendLinksFlow(ctx, src, selected, selected.id, selected.title);
    return;
  }

  // Series-like: episodes first.
  let eps;
  try {
    eps = await sourceEpisodes(src, selected.id);
  } catch (e) {
    await msgr.sendText(chatId, `❌ فشل جلب الحلقات: ${e.message}`, { quoted });
    return;
  }
  let count = 0;
  let epList = null;
  if (typeof eps.count === 'number') count = eps.count;
  else if (Array.isArray(eps.episodes)) { epList = eps.episodes; count = epList.length; }
  if (!count) {
    await msgr.sendText(chatId, '❌ لا توجد حلقات لهذا العنوان.', { quoted });
    return;
  }

  const poster = selected.poster ? await posterBufferFromUrl(selected.poster, undefined) : null;
  const pick = await wizard.pickEpisode(ctx, {
    title: selected.title,
    sourceTag: `[${src.name}]`,
    count,
    poster,
  });
  if (!pick) return;

  const epRefOf = (n) => (epList ? epList[n - 1].id : String(n));

  if (pick.type === 'single') {
    await sendLinksFlow(ctx, src, selected, epRefOf(pick.from), `${selected.title} - الحلقة ${pick.from}`, pick.from);
    return;
  }

  // Range: best quality automatically, one episode after another.
  await msgr.sendText(chatId, `⏳ سأحمّل الحلقات ${pick.from} إلى ${pick.to} بأفضل جودة متاحة...`, { quoted });
  for (let n = pick.from; n <= pick.to; n++) {
    try {
      const links = await sourceLinks(src, selected.id, epRefOf(n));
      if (!links.length) {
        await msgr.sendText(chatId, `⚠️ الحلقة ${n}: لا روابط — تخطيتها.`, { quoted });
        continue;
      }
      await downloadAndSend(ctx, {
        url: links[0].url,
        title: `${selected.title} - الحلقة ${n}`,
        referer: links[0].referer,
        headers: links[0].headers,
        subtitleUrl: links[0].subtitleUrl,
        partMB: ctx.partMB,
      });
    } catch (e) {
      await msgr.sendText(chatId, `⚠️ الحلقة ${n}: فشل (${e.message}) — أكمل بالتي بعدها.`, { quoted });
    }
  }
  await msgr.sendText(chatId, `✅ انتهت دفعة *${selected.title}* (${pick.from}-${pick.to}).`, { quoted });
}

async function sendLinksFlow(ctx, src, selected, epRef, titleForLinks, epNumber) {
  const { msgr, chatId, quoted } = ctx;
  await msgr.sendText(chatId, `⏳ جاري جلب السيرفرات...`, { quoted });
  let links;
  try {
    links = await sourceLinks(src, selected.id, epRef);
  } catch (e) {
    await msgr.sendText(chatId, `❌ فشل جلب السيرفرات: ${e.message}`, { quoted });
    return;
  }
  if (!links || !links.length) {
    await msgr.sendText(chatId, '❌ لا توجد سيرفرات شغالة.', { quoted });
    return;
  }
  await attachSizes(links);
  const chosen = await wizard.pickQuality(ctx, { title: titleForLinks, links });
  if (!chosen) return;
  await downloadAndSend(ctx, {
    url: chosen.url,
    title: titleForLinks,
    referer: chosen.referer,
    headers: chosen.headers,
    subtitleUrl: chosen.subtitleUrl,
    partMB: ctx.partMB,
  });
}

module.exports = { runSourceFlow, TYPE_LABEL };
