const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { registerWhatsAppHandler, extractText } = require('./wa-handler');
const { createCommandHandler } = require('./commands-only');
const { handleAutomation } = require('./plugins/automation');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const ROOT = path.join(__dirname, 'sessions');
fs.mkdirSync(ROOT, { recursive: true });

const sessions = new Map();
const pairingEvents = new EventEmitter();
pairingEvents.setMaxListeners(0);
const starts = new Map();
const connectedNoticeSent = new Set();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sessionPath(number) {
  return path.join(ROOT, number);
}
function getStatusCode(error) {
  try { return new Boom(error).output.statusCode; }
  catch { return undefined; }
}

async function createSocket(number) {
  const dir = sessionPath(number);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    console.log(`[${number}] Baileys version: ${version.join('.')}${result.isLatest ? ' (latest)' : ''}`);
  } catch (err) {
    console.warn(`[${number}] Could not fetch latest Baileys version: ${err.message}`);
  }

  const socket = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  const record = {
    number,
    socket,
    state: state.creds.registered ? 'connecting' : 'pairing',
    reconnectTimer: null,
    reconnectAttempts: 0,
    intentionalStop: false,
    starting: true
  };
  sessions.set(number, record);

  socket.ev.on('creds.update', saveCreds);
  registerWhatsAppHandler(socket, number, () => {
    try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'data', 'settings.json'), 'utf8'))[number] || { prefix: '.', repliesEnabled: true }; }
    catch { return { prefix: '.', repliesEnabled: true }; }
  });

  // Route commands-only.js through this EXISTING socket. It does not create
  // sockets or pairing handlers. wa-handler.js keeps only welcome/goodbye events.
  const extendedCommandHandler = createCommandHandler({
    sock: socket,
    downloadMediaMessage,
    logger: pino({ level: 'silent' }),
    config: { ownerNumber: number, ownerName: process.env.OWNER_NAME || '𝐗 𝐍𝐎𝐁𝐈𝐓𝐀', prefix: process.env.COMMAND_PREFIX || '.', mode: 'public' }
  });
  // Route every incoming message through the existing command handler so group
  // moderation (anti-link / anti-sticker) can inspect non-command messages too.
  const extendedSeen = new Set();
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!['notify', 'append'].includes(type) || !Array.isArray(messages)) return;
    for (const msg of messages) {
      try {
        if (!msg?.key?.remoteJid || !msg?.message) continue;
        // Run automations on the same live socket and same per-session settings key.
        await handleAutomation(socket, msg, number).catch(err => console.error(`[${number}] automation error:`, err.message || err));
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.endsWith('@newsletter')) continue;
        const key = msg?.key?.id;
        if (key && extendedSeen.has(key)) continue;
        if (key) {
          extendedSeen.add(key);
          if (extendedSeen.size > 5000) extendedSeen.delete(extendedSeen.values().next().value);
        }
        await extendedCommandHandler(msg);
      } catch (err) {
        console.error(`[${number}] extended command/moderation error:`, err.message || err);
      }
    }
  });

  socket.ev.on('connection.update', (update) => {
    const current = sessions.get(number);
    if (current !== record || record.intentionalStop) return;

    if (update.connection === 'open') {
      record.state = 'connected';
      if (record.pairingTimer) { clearTimeout(record.pairingTimer); record.pairingTimer = null; }
      record.pairingFailedEmitted = false;
      pairingEvents.emit('connected', { number });
      record.reconnectAttempts = 0;
      record.starting = false;
      console.log(`[${number}] WhatsApp connected.`);
      // Send a one-time-per-process connected notice to the paired number's own DM.
      // Send only the connected notice; do not send a separate vCard contact card.
      if (!connectedNoticeSent.has(number)) {
        connectedNoticeSent.add(number);
        (async () => {
          const jid = `${number}@s.whatsapp.net`;
          const notice = [
            '🌷 𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃 🌷',
            '',
            '╭─「 💚 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 」─',
            '│ 🤖 𝐁𝐨𝐭: 𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃',
            '│ 🟢 𝐒𝐭𝐚𝐭𝐮𝐬: 𝐎𝐧𝐥𝐢𝐧𝐞',
            '│ ✨ 𝐒𝐲𝐬𝐭𝐞𝐦: 𝐑𝐮𝐧𝐧𝐢𝐧𝐠',
            '╰────────────',
            '',
            '💖 𝐘𝐨𝐮𝐫 𝐁𝐨𝐭 𝐈𝐬 𝐑𝐞𝐚𝐝𝐲!',
            '🌸 𝐄𝐧𝐣𝐨𝐲 𝐓𝐡𝐞 𝐒𝐦𝐨𝐨𝐭𝐡 𝐄𝐱𝐩𝐞𝐫𝐢𝐞𝐧𝐜𝐞 ✨',
            '',
            '💞 𝐏𝐚𝐢𝐫 𝐆𝐫𝐨𝐮𝐩:',
            'https://t.me/x_nobita_xd_pair',
            '',
            '📢 𝐖𝐡𝐚𝐭𝐬𝐀𝐩𝐩 𝐂𝐡𝐚𝐧𝐧𝐞𝐥:',
            'https://whatsapp.com/channel/0029VbDtZiW4dTnQtGld7D0e',
            '',
            '🌷 𝐒𝐭𝐚𝐲 𝐂𝐨𝐧𝐧𝐞𝐜𝐭𝐞𝐝 • 𝐒𝐭𝐚𝐲 𝐂𝐨𝐨𝐥 💚',
            '👑 𝐏𝐨𝐰𝐞𝐫𝐞𝐝 𝐁𝐲 𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃 🌸'
          ].join('\n');
          await socket.sendMessage(jid, { text: notice });
          console.log(`[${number}] Connected DM notice sent.`);
        })().catch(err => {
          connectedNoticeSent.delete(number);
          console.error(`[${number}] Could not send connected DM notice: ${err.message || err}`);
        });
      }
    }

    if (update.connection === 'close') {
      const statusCode = getStatusCode(update.lastDisconnect?.error);
      const wasAwaitingPair = ['pairing', 'waiting for code', 'connecting'].includes(record.state) && !state.creds.registered;
      if (record.pairingTimer) { clearTimeout(record.pairingTimer); record.pairingTimer = null; }
      if (wasAwaitingPair && !record.pairingFailedEmitted) {
        record.pairingFailedEmitted = true;
        pairingEvents.emit('failed', { number, statusCode });
      }
      record.starting = false;
      console.warn(`[${number}] Connection closed (status ${statusCode || 'unknown'}).`);
      if (statusCode === DisconnectReason.loggedOut) {
        record.state = 'logged out';
        // Keep files for inspection; do not automatically destroy user credentials.
        sessions.delete(number);
        return;
      }
      record.state = 'reconnecting';
      scheduleReconnect(number, record);
    }
  });

  return { socket, state, record };
}

function scheduleReconnect(number, record) {
  if (record.intentionalStop || record.reconnectTimer || sessions.get(number) !== record) return;
  record.reconnectAttempts += 1;
  const delay = Math.min(30_000, 1500 * (2 ** Math.min(record.reconnectAttempts - 1, 4)));
  record.reconnectTimer = setTimeout(async () => {
    record.reconnectTimer = null;
    if (record.intentionalStop || sessions.get(number) !== record) return;
    try {
      // End the old transport before replacing it; only one live socket per number.
      try { record.socket.end(new Error('Replacing closed socket')); } catch {}
      await sleep(500);
      const { socket, record: next } = await createSocket(number);
      next.reconnectAttempts = record.reconnectAttempts;
      console.log(`[${number}] Reconnect attempt ${next.reconnectAttempts} started.`);
    } catch (err) {
      console.error(`[${number}] Reconnect failed: ${err.message}`);
      if (sessions.get(number) === record) scheduleReconnect(number, record);
    }
  }, delay);
  if (record.reconnectTimer.unref) record.reconnectTimer.unref();
}

async function startPairing(number) {
  if (starts.has(number)) return starts.get(number);
  const existing = sessions.get(number);
  if (existing?.state === 'connected') {
    throw new Error('This number already has an active connection. Use /status or /unpair first.');
  }
  if (existing?.socket && existing.state !== 'logged out') {
    throw new Error('A connection for this number is already active or starting. Wait a moment, then check /status.');
  }

  const operation = (async () => {
    const { socket, state, record } = await createSocket(number);
    if (state.creds.registered) {
      record.state = 'connecting';
      throw new Error('This WhatsApp number already has a saved session. Use /status, or /unpair to remove it before pairing again.');
    }

    await sleep(1200);
    if (sessions.get(number) !== record || record.intentionalStop) {
      throw new Error('Pairing session was replaced. Please retry.');
    }
    const rawCode = await socket.requestPairingCode(number);
    if (!rawCode) throw new Error('WhatsApp did not return a pairing code. Please retry.');
    const code = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
    record.state = 'waiting for code';
    record.pairingFailedEmitted = false;
    record.pairingTimer = setTimeout(() => {
      if (sessions.get(number) !== record || record.state !== 'waiting for code') return;
      record.pairingFailedEmitted = true;
      pairingEvents.emit('failed', { number, reason: 'pairing code expired' });
      record.state = 'pairing expired';
      record.intentionalStop = true;
      try { record.socket?.end(new Error('Pairing code expired')); } catch {}
      sessions.delete(number);
    }, 90_000);
    if (record.pairingTimer.unref) record.pairingTimer.unref();
    return { code, alreadyRegistered: false };
  })();

  starts.set(number, operation);
  try {
    return await operation;
  } catch (err) {
    const record = sessions.get(number);
    if (record && record.state !== 'connected') {
      record.intentionalStop = true;
      if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
      try { record.socket?.end(new Error('Pairing failed')); } catch {}
      sessions.delete(number);
    }
    throw err;
  } finally {
    if (starts.get(number) === operation) starts.delete(number);
  }
}

async function unpairSession(number) {
  const pending = starts.get(number);
  if (pending) { try { await pending; } catch {} }
  const record = sessions.get(number);
  if (record) {
    record.intentionalStop = true;
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    sessions.delete(number);
    try { await record.socket?.logout(); } catch {}
    try { record.socket?.end(new Error('Session removed by user')); } catch {}
  }
  const dir = sessionPath(number);
  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}

async function restoreSavedSessions() {
  const entries = await fs.promises.readdir(ROOT, { withFileTypes: true });
  let restored = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{7,15}$/.test(entry.name)) continue;
    const number = entry.name;
    try {
      const credsPath = path.join(sessionPath(number), 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      const creds = JSON.parse(await fs.promises.readFile(credsPath, 'utf8'));
      if (!creds.registered) continue;
      if (sessions.has(number)) continue;
      await createSocket(number);
      restored += 1;
      // Stagger startup so several saved sessions do not all reconnect at once.
      await sleep(700);
    } catch (err) {
      console.error(`[${number}] Could not restore saved session: ${err.message}`);
    }
  }
  console.log(`[sessions] Restored ${restored} saved WhatsApp session(s).`);
  return restored;
}

function getSessionStatus() {
  return [...sessions.values()]
    .filter(s => s && s.number)
    .map(s => ({ number: s.number, state: s.state || 'starting' }));
}

async function stopAll() {
  const records = [...sessions.values()];
  for (const record of records) {
    record.intentionalStop = true;
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    try { record.socket?.end(new Error('Process stopping')); } catch {}
  }
  sessions.clear();
}

module.exports = { startPairing, unpairSession, getSessionStatus, restoreSavedSessions, stopAll, pairingEvents };
