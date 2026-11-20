// ────────────────────────────────────────────────────────────────
// إضافة .gemini — يجيب من Google Gemini (مجاني) داخل واتساب.
//
// التثبيت:
//   1) انسخ هذا الملف إلى plugins/tools/gemini.js
//   2) أضف سرّاً في GitHub: Settings → Secrets → GEMINI_API_KEY
//      (مفتاح مجاني من https://aistudio.google.com/apikey)
//   3) في .github/workflows/bot.yml أضف تحت env:
//        GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
//   4) أعد تشغيل البوت.
//
// ملاحظة أمان: المفتاح يُقرأ من متغير البيئة فقط — لا يُكتب في الكود أبداً.
// لا توجد هنا أي كتابة على GitHub أو أي مستودع: الكود يصلك ملفاً، وأنت ترفعه بنفسك.
// ────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../core/store.js');
const fetchx = require('../../core/fetch.js');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TEXT_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const MAX_HISTORY = 10;              // آخر تبادلات محفوظة لكل محادثة
const MAX_DOC_CHARS = 3000;          // فوق هذا تُرسل الإجابة ملفاً
const MEM_PREFIX = 'gemini_mem_';
const MAP_PREFIX = 'gemini_map_';

// ── ذاكرة المحادثة لكل دردشة ────────────────────────────────────
function memKey(chatId) { return MEM_PREFIX + String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function loadMemory(chatId) { return store.readJson(memKey(chatId), []); }
function saveMemory(chatId, mem) { store.writeJson(memKey(chatId), (mem || []).slice(-MAX_HISTORY * 2)); }

// ── تحويل Markdown خفيف إلى تنسيق واتساب ────────────────────────
function toWhatsApp(md) {
    let t = String(md || '');
    t = t.replace(/```(\w*)\n/g, '```\n');            // واتساب لا يفهم لغة الكتلة
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');       // العناوين → غامق
    t = t.replace(/\*\*([^*]+)\*\*/g, '*$1*');        // **غامق** → *غامق*
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1: $2');
    return t.trim();
}

// ── نداء Gemini ─────────────────────────────────────────────────
function apiKey() { return process.env.GEMINI_API_KEY || ''; }

async function geminiText(contents) {
    const key = apiKey();
    if (!key) throw new Error('مفتاح GEMINI_API_KEY غير مضبوط في أسرار GitHub');
    const res = await fetchx.request(`${API_BASE}/${TEXT_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents })
    });
    const data = await res.json();
    if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        throw new Error('Gemini: ' + msg);
    }
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.map((p) => p.text || '').join('').trim();
}

async function geminiImage(prompt) {
    const key = apiKey();
    if (!key) throw new Error('مفتاح GEMINI_API_KEY غير مضبوط في أسرار GitHub');
    const res = await fetchx.request(`${API_BASE}/${IMAGE_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] }
        })
    });
    const data = await res.json();
    if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        throw new Error('Gemini: ' + msg);
    }
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    for (const p of parts) {
        const inline = p.inlineData || p.inline_data;
        if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    }
    return null;
}

// ── إرسال الإجابة (ملف إن طالت، وإلا نصوص مقسّمة) ────────────────
async function sendReply(ctx, reply, title) {
    const text = toWhatsApp(reply);
    const bigCode = /```[\s\S]{1500,}```/.test(reply);
    if (text.length > MAX_DOC_CHARS || bigCode) {
        const dir = path.join(process.cwd(), 'tmp-gemini');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, (title || 'gemini-reply') + '.txt');
        fs.writeFileSync(file, reply, 'utf8');
        try {
            await ctx.msgr.sendDocument(ctx.chatId, file, path.basename(file),
                '✻ إجابة طويلة — أرسلتها ملفاً كاملاً:', { mimetype: 'text/plain' });
            return;
        } catch (_) { /* نرجع للنصوص المقسّمة */ }
    }
    const chunks = [];
    let rest = text;
    while (rest.length > 3500) {
        let cut = rest.lastIndexOf('\n', 3500);
        if (cut < 1000) cut = 3500;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    for (const c of chunks) await ctx.msgr.sendText(ctx.chatId, c, { quoted: ctx.quoted });
}

// ── خريطة أقسام الكود (نسخة صغيرة من منطق التطبيق) ──────────────
function buildMapFromText(text) {
    const src = String(text || '');
    const lines = src.split('\n');
    const sections = [];
    const isBash = /^\s*(#![^\n]*\b(ba)?sh\b|NAME=.*\nTYPE=bash)/m.test(src) || /\n[a-zA-Z_][\w-]*\s*\(\)\s*\{/.test(src);
    const marks = [];
    if (isBash) {
        lines.forEach((ln, i) => {
            const m = ln.match(/^([a-zA-Z_][\w-]*)\s*\(\)\s*\{/);
            if (m) marks.push({ name: m[1], line: i });
        });
    } else {
        lines.forEach((ln, i) => {
            let m = ln.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
            if (m) { marks.push({ name: m[1], line: i }); return; }
            m = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
            if (m) { marks.push({ name: m[1], line: i }); return; }
            m = ln.match(/command\s*={2,3}\s*['"]([^'"]+)['"]/);
            if (m) marks.push({ name: m[1], line: i });
        });
    }
    for (let k = 0; k < marks.length; k++) {
        const start = marks[k].line;
        const end = (k + 1 < marks.length ? marks[k + 1].line - 1 : lines.length - 1);
        sections.push({ name: marks[k].name, startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n') });
    }
    return sections;
}
function mapKey(chatId) { return MAP_PREFIX + String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// ── المعالج الرئيسي ─────────────────────────────────────────────
async function handle(ctx) {
    const raw = (ctx.text || '').trim();
    const arg = (ctx.args || '').trim();

    // .gemini new — محادثة جديدة (تصفير ذاكرة هذه الدردشة)
    if (arg === 'new' || arg === 'جديد') {
        saveMemory(ctx.chatId, []);
        await ctx.msgr.sendText(ctx.chatId, '✻ بدأت محادثة جديدة — نُسي كل ما قبلها في هذه الدردشة.', { quoted: ctx.quoted });
        return;
    }

    // .gemini list — معلومات المحادثة الحالية
    if (arg === 'list' || arg === 'قائمة') {
        const mem = loadMemory(ctx.chatId);
        const map = store.readJson(mapKey(ctx.chatId), null);
        await ctx.msgr.sendText(ctx.chatId,
            `✻ محادثة هذه الدردشة:\n• تبادلات محفوظة: ${Math.floor(mem.length / 2)} من ${MAX_HISTORY}\n` +
            `• خريطة محفوظة: ${map ? map.name + ' (' + map.sections.length + ' قسماً)' : 'لا'}\n` +
            '• لمسح الذاكرة: .gemini new', { quoted: ctx.quoted });
        return;
    }

    // .gemini خريطة — بناء خريطة من كود في الرسالة أو المقتبَس
    if (arg.startsWith('خريطة')) {
        const quotedText = (ctx.quoted && ctx.quoted.message &&
            ((ctx.quoted.message.conversation) ||
             ((ctx.quoted.message.extendedTextMessage || {}).text) || '')) || '';
        const code = arg.slice('خريطة'.length).trim() || quotedText;
        if (!code || code.length < 30) {
            await ctx.msgr.sendText(ctx.chatId,
                '✻ أرسل الكود مع الأمر: .gemini خريطة <الكود> — أو اقتبس رسالة فيها الكود واكتب .gemini خريطة', { quoted: ctx.quoted });
            return;
        }
        const sections = buildMapFromText(code);
        const nameMatch = code.match(/NAME\s*=\s*['"]?([\w.-]+)/);
        const name = (nameMatch && nameMatch[1]) || 'code';
        store.writeJson(mapKey(ctx.chatId), { name, sections, at: Date.now() });
        const list = sections.slice(0, 40).map((s) => `• ${s.name} (${s.startLine}–${s.endLine})`).join('\n');
        await ctx.msgr.sendText(ctx.chatId,
            `✻ حُفظت خريطة «${name}» (${sections.length} قسماً).\nاسأل الآن واذكر اسم القسم في سؤالك، وسأرسل نصّه وحده مع سؤالك لتوفير التوكنات.\n${list}`, { quoted: ctx.quoted });
        return;
    }

    // .gemini صورة: <الوصف>
    const imgMatch = arg.match(/^صورة\s*:\s*([\s\S]+)/);
    if (imgMatch) {
        try {
            await ctx.msgr.sendText(ctx.chatId, '✻ جارٍ توليد الصورة…', { quoted: ctx.quoted });
            const buf = await geminiImage(imgMatch[1].trim());
            if (!buf) { await ctx.msgr.sendText(ctx.chatId, '✻ لم يُرجع النموذج صورة لهذا الوصف.', { quoted: ctx.quoted }); return; }
            await ctx.msgr.sendImage(ctx.chatId, buf, '✻ ' + imgMatch[1].trim().slice(0, 80));
        } catch (e) {
            await ctx.msgr.sendText(ctx.chatId, '✻ تعذّر توليد الصورة: ' + e.message, { quoted: ctx.quoted });
        }
        return;
    }

    // سؤال عادي
    if (!arg) {
        await ctx.msgr.sendText(ctx.chatId,
            '✻ اكتب سؤالك بعد الأمر، مثال: .gemini اكتب لي إضافة بوت تطبع الوقت\n' +
            '• .gemini صورة: <وصف> — توليد صورة\n• .gemini new — محادثة جديدة\n• .gemini list — معلومات المحادثة\n• .gemini خريطة <كود> — حفظ خريطة أقسام الكود',
            { quoted: ctx.quoted });
        return;
    }

    try {
        // إن وُجدت خريطة محفوظة: أرفق ملخّصها + الأقسام المذكورة بالاسم في السؤال فقط
        let question = arg;
        const map = store.readJson(mapKey(ctx.chatId), null);
        if (map && map.sections && map.sections.length) {
            const outline = map.sections.map((s) => `${s.name} (${s.startLine}-${s.endLine})`).join(', ');
            const hits = map.sections.filter((s) => arg.includes(s.name));
            question = `[خريطة محفوظة: ${map.name}]\nالأقسام: ${outline}\n` +
                hits.map((s) => `\n[قسم: ${s.name}]\n${s.text}\n`).join('') +
                `\n[السؤال]\n${arg}`;
        }

        const mem = loadMemory(ctx.chatId);
        const contents = mem.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
        contents.push({ role: 'user', parts: [{ text: question }] });

        const reply = await geminiText(contents);
        if (!reply) { await ctx.msgr.sendText(ctx.chatId, '✻ وصلت إجابة فارغة من Gemini.', { quoted: ctx.quoted }); return; }

        mem.push({ role: 'user', text: arg }, { role: 'model', text: reply });
        saveMemory(ctx.chatId, mem);
        await sendReply(ctx, reply, 'gemini-reply');
    } catch (e) {
        await ctx.msgr.sendText(ctx.chatId, '✻ تعذّر إكمال الطلب: ' + e.message, { quoted: ctx.quoted });
    }
}

module.exports = {
    name: 'gemini',
    commands: ['.gemini'],
    help: '.gemini <سؤال> — اسأل Gemini (ذاكرة لكل دردشة) • .gemini صورة: <وصف> • .gemini new • .gemini list • .gemini خريطة <كود>',
    handle
};
