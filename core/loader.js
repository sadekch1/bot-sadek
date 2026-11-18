'use strict';
// ── PLUGIN LOADER ───────────────────────────────────────────────────
// Scans plugins/ recursively. Every plugin loads IN ISOLATION: a broken
// one is logged and skipped, the bot keeps running.
// Two plugin kinds:
//   SOURCE  — feeds a wizard command (.anime/.series/.movie/.kdrama)
//             bash: header lines "# NAME:"/"# TYPE:" + stage printing
//             node: exports { name, type, search, episodes, links }
//   COMMAND — standalone command (node only)
//             exports { name, commands: ['.x'], help, handle(ctx) }
// Files/folders starting with "_" or named TEMPLATE* are skipped.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
const STAGE_TIMEOUT = 90000;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('TEMPLATE')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(sh|js)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

function bashHeader(file) {
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 40).join('\n');
  const name = /#\s*NAME:\s*(.+)/i.exec(head);
  const type = /#\s*TYPE:\s*(.+)/i.exec(head);
  if (!name || !type) return null;
  return { name: name[1].trim(), type: type[1].trim().toLowerCase() };
}

function loadPlugins(log = console.log) {
  const sources = new Map(); // type -> [source]
  const commands = new Map(); // '.cmd' -> plugin
  const errors = [];
  const addSource = (type, src) => {
    if (!sources.has(type)) sources.set(type, []);
    sources.get(type).push(src);
  };

  for (const file of walk(PLUGINS_DIR)) {
    const rel = path.relative(process.cwd(), file);
    try {
      if (file.endsWith('.sh')) {
        const h = bashHeader(file);
        if (!h) { errors.push(rel + ': missing NAME/TYPE header'); continue; }
        addSource(h.type, { kind: 'bash', name: h.name, type: h.type, path: file });
        log(`[plugin] source ${h.type}/${h.name} (bash)`);
      } else {
        delete require.cache[require.resolve(file)];
        const mod = require(file);
        if (mod && mod.type && typeof mod.search === 'function') {
          addSource(String(mod.type).toLowerCase(), { kind: 'node', name: mod.name || path.basename(file, '.js'), type: String(mod.type).toLowerCase(), mod });
          log(`[plugin] source ${mod.type}/${mod.name} (node)`);
        } else if (mod && Array.isArray(mod.commands) && typeof mod.handle === 'function') {
          for (const c of mod.commands) commands.set(String(c).toLowerCase(), { name: mod.name || c, help: mod.help || '', mod });
          log(`[plugin] command ${mod.commands.join(' ')} (node)`);
        } else {
          errors.push(rel + ': exports neither a source nor a command');
        }
      }
    } catch (e) {
      errors.push(rel + ': ' + e.message);
    }
  }
  for (const e of errors) log('[plugin] SKIPPED ' + e);
  return { sources, commands, errors };
}

// ── Bash source runner (the print contract) ─────────────────────────
// SEARCH  "query"            -> lines "title | id" (optional 3rd: "| posterUrl")
// EPISODES "seriesId"        -> "COUNT n" OR lines "epId | label"
// LINKS   "seriesId" "epRef" -> lines "label | url" (optional 3rd: "| referer")
function runBash(file, args) {
  return new Promise((resolve, reject) => {
    execFile('bash', [file, ...args], { timeout: STAGE_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('plugin failed: ' + err.message));
      resolve(String(stdout || ''));
    });
  });
}

function splitLines(out) {
  return String(out).split('\n').map((s) => s.trim()).filter(Boolean);
}
function splitFields(line) {
  return line.split('|').map((s) => s.trim());
}

async function bashSearch(src, query) {
  const out = await runBash(src.path, ['SEARCH', query]);
  return splitLines(out).map((ln) => {
    const f = splitFields(ln);
    return f.length >= 2 ? { title: f[0], id: f[1], poster: f[2] || null } : null;
  }).filter(Boolean);
}

async function bashEpisodes(src, seriesId) {
  const out = await runBash(src.path, ['EPISODES', String(seriesId)]);
  const lines = splitLines(out);
  const countLine = lines.find((l) => /^COUNT\s+\d+/i.test(l));
  if (countLine) return { count: parseInt(/(\d+)/.exec(countLine)[1], 10) };
  const episodes = lines.map((ln) => {
    const f = splitFields(ln);
    return f.length >= 1 ? { id: f[0], label: f[1] || '' } : null;
  }).filter(Boolean);
  return { episodes };
}

async function bashLinks(src, seriesId, epRef) {
  const out = await runBash(src.path, ['LINKS', String(seriesId), String(epRef)]);
  return splitLines(out).map((ln) => {
    const f = splitFields(ln);
    return f.length >= 2 ? { label: f[0], url: f[1], referer: f[2] || undefined } : null;
  }).filter(Boolean);
}

// Unified source API (bash or node behind one shape).
async function sourceSearch(src, query) {
  if (src.kind === 'bash') return bashSearch(src, query);
  const r = await src.mod.search(query);
  return (r || []).map((x) => ({ title: x.title, id: String(x.id), poster: x.poster || null }));
}
async function sourceEpisodes(src, seriesId) {
  if (src.kind === 'bash') return bashEpisodes(src, seriesId);
  const r = await src.mod.episodes(seriesId);
  if (typeof r === 'number') return { count: r };
  if (r && typeof r.count === 'number') return { count: r.count };
  return { episodes: (r || []).map((x) => ({ id: String(x.id), label: x.label || x.title || '' })) };
}
async function sourceLinks(src, seriesId, epRef) {
  if (src.kind === 'bash') return bashLinks(src, seriesId, epRef);
  const r = await src.mod.links(seriesId, epRef);
  return (r || []).map((x) => ({ label: x.label, url: x.url, referer: x.referer, headers: x.headers, subtitleUrl: x.subtitleUrl }));
}

module.exports = { loadPlugins, sourceSearch, sourceEpisodes, sourceLinks, PLUGINS_DIR };
