const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'data', 'settings.json');
function read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function write(value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); }
const DEFAULT_AUTOMATION = { autotyping: false, autoread: false, autostoryview: false };
function withDefaults(value = {}) { return { prefix: '.', botMode: 'public', ...value, automation: { ...DEFAULT_AUTOMATION, ...(value.automation || {}) }, autoreact: value.autoreact === true }; }
module.exports = {
  get(key) { const all = read(); return withDefaults(all[String(key)] || {}); },
  update(key, updater) { const all = read(); const old = withDefaults(all[String(key)] || {}); const next = typeof updater === 'function' ? updater(old) : { ...old, ...updater }; all[String(key)] = { ...next, automation: { ...DEFAULT_AUTOMATION, ...(next.automation || {}) } }; write(all); return withDefaults(all[String(key)]); },
  setGroup(key, type, jid, value) { const all = read(); all[String(key)] ||= {}; all[String(key)].groups ||= {}; all[String(key)].groups[jid] ||= {}; all[String(key)].groups[jid][type] = value; write(all); }
};
