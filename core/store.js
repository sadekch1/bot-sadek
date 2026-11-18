'use strict';
// ── Service 7: STORAGE ──────────────────────────────────────────────
// Small JSON persistence inside data/ (the workflow commits data/ back,
// so whatever is saved here survives bot restarts).
// Plugins must use this instead of touching files themselves.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(name, fallback) {
  try {
    ensureDir();
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(name, value) {
  ensureDir();
  const p = path.join(DATA_DIR, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// Bot configuration: data/config.json
//   phone:   your number in international format, digits only (for pairing)
//   botName: shown in .help
//   partMB:  part size when a file is bigger than 2 GB (default 500)
function loadConfig() {
  const cfg = readJson('config.json', {});
  return {
    phone: String(cfg.phone || '').replace(/\D/g, ''),
    botName: cfg.botName || 'Sadek Bot',
    partMB: Math.min(1900, Math.max(50, parseInt(cfg.partMB, 10) || 500)),
  };
}

module.exports = { DATA_DIR, readJson, writeJson, loadConfig };
