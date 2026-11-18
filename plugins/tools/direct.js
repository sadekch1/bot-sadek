'use strict';
// Command plugin example (node): .dl <direct link>
// Downloads any direct file / HLS / embed link through the core
// download service — the plugin itself is only a few lines.
const { downloadAndSend } = require('../../core/download');

module.exports = {
  name: 'DirectDownload',
  commands: ['.dl'],
  help: '.dl <رابط> — تحميل ملف أو فيديو من رابط مباشر',

  async handle(ctx) {
    const url = (ctx.args || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      await ctx.msgr.sendText(ctx.chatId, 'اكتب الرابط بعد الأمر، مثال:\n.dl https://example.com/file.mp4', { quoted: ctx.quoted });
      return;
    }
    await downloadAndSend(ctx, { url, title: 'ملف', partMB: ctx.partMB, asDocument: false });
  },
};
