require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { startPairing, unpairSession, getSessionStatus, restoreSavedSessions, stopAll } = require('./pair');

const TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME || '🌷 𝐗 Nᴏʙɪᴛᴀ Mᴏᴅᴢ 🌷';
const OFFICIAL_GROUP_ID = String(process.env.OFFICIAL_GROUP_ID || '').trim();
const OFFICIAL_GROUP_LINK = process.env.OFFICIAL_GROUP_LINK || 'https://t.me/x_nobita_xd_pair';
const STARTED_AT = Date.now();
const ADMIN_IDS = new Set(String(process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)));
const DATA_DIR = path.join(__dirname, 'data');
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.error(`[data] Cannot read ${path.basename(file)}:`, err.message); return fallback; }
}
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
let owners = readJson(OWNERS_FILE, {}); // WhatsApp number -> Telegram numeric user ID (string)
let settings = readJson(SETTINGS_FILE, {}); // WhatsApp number -> private settings
function saveOwners() { writeJson(OWNERS_FILE, owners); }
function saveSettings() { writeJson(SETTINGS_FILE, settings); }

if (!TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and add your Telegram bot token.');
  process.exit(1);
}
const bot = new TelegramBot(TOKEN, { polling: true });
const pairingDestinations = new Map();
const { pairingEvents } = require('./pair');

async function deletePairCodeMessage(destination) {
  if (!destination?.codeMessageId || destination.codeMessageDeleted) return;
  destination.codeMessageDeleted = true;
  try { await bot.deleteMessage(destination.chatId, String(destination.codeMessageId)); }
  catch (err) { console.warn('[Telegram] Could not delete pairing-code message:', err.message); }
}

function sendPairText(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { ...extra, disable_web_page_preview: true });
}
function countryForNumber(number) {
  const prefixes = [
    ['1','🇺🇸','United States / Canada'], ['7','🇷🇺','Russia'], ['20','🇪🇬','Egypt'],
    ['27','🇿🇦','South Africa'], ['30','🇬🇷','Greece'], ['31','🇳🇱','Netherlands'],
    ['32','🇧🇪','Belgium'], ['33','🇫🇷','France'], ['34','🇪🇸','Spain'],
    ['36','🇭🇺','Hungary'], ['39','🇮🇹','Italy'], ['40','🇷🇴','Romania'],
    ['41','🇨🇭','Switzerland'], ['43','🇦🇹','Austria'], ['44','🇬🇧','United Kingdom'],
    ['45','🇩🇰','Denmark'], ['46','🇸🇪','Sweden'], ['47','🇳🇴','Norway'],
    ['48','🇵🇱','Poland'], ['49','🇩🇪','Germany'], ['51','🇵🇪','Peru'],
    ['52','🇲🇽','Mexico'], ['54','🇦🇷','Argentina'], ['55','🇧🇷','Brazil'],
    ['60','🇲🇾','Malaysia'], ['61','🇦🇺','Australia'], ['62','🇮🇩','Indonesia'],
    ['63','🇵🇭','Philippines'], ['65','🇸🇬','Singapore'], ['66','🇹🇭','Thailand'],
    ['81','🇯🇵','Japan'], ['82','🇰🇷','South Korea'], ['84','🇻🇳','Vietnam'],
    ['86','🇨🇳','China'], ['90','🇹🇷','Turkey'], ['91','🇮🇳','India'],
    ['92','🇵🇰','Pakistan'], ['93','🇦🇫','Afghanistan'], ['94','🇱🇰','Sri Lanka'],
    ['95','🇲🇲','Myanmar'], ['98','🇮🇷','Iran'], ['212','🇲🇦','Morocco'],
    ['213','🇩🇿','Algeria'], ['216','🇹🇳','Tunisia'], ['218','🇱🇾','Libya'],
    ['220','🇬🇲','Gambia'], ['221','🇸🇳','Senegal'], ['234','🇳🇬','Nigeria'],
    ['249','🇸🇩','Sudan'], ['250','🇷🇼','Rwanda'], ['251','🇪🇹','Ethiopia'],
    ['254','🇰🇪','Kenya'], ['255','🇹🇿','Tanzania'], ['256','🇺🇬','Uganda'],
    ['880','🇧🇩','Bangladesh'], ['971','🇦🇪','United Arab Emirates'],
    ['972','🇮🇱','Israel'], ['974','🇶🇦','Qatar'], ['966','🇸🇦','Saudi Arabia'],
    ['977','🇳🇵','Nepal'], ['998','🇺🇿','Uzbekistan'], ['374','🇦🇲','Armenia']
  ].sort((a, b) => b[0].length - a[0].length);
  const found = prefixes.find(([code]) => number.startsWith(code));
  return found ? { flag: found[1], name: found[2], code: found[0] } : { flag: '🌍', name: 'Unknown', code: '' };
}

pairingEvents.on('connected', async ({ number }) => {
  const destination = pairingDestinations.get(number);
  if (!destination || destination.connectedSent) return;
  destination.connectedSent = true;
  destination.outcome = 'connected';
  await deletePairCodeMessage(destination);
  try {
    await sendPairText(destination.chatId,
      `❤️‍🩹 𝐂ᴏɴɴᴇᴄᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ\n\n📱 𝐍ᴜᴍʙᴇʀ: +${number}\n💚 𝐖ʜᴀᴛsAᴘᴘ: 𝐎ɴʟɪɴᴇ\n\n✨ 𝐘ᴏᴜʀ 𝐁ᴏᴛ 𝐈s 𝐑ᴇᴀᴅʏ`,
      { reply_to_message_id: destination.messageId });
  } catch (err) { console.error('[Telegram] Could not send connected status:', err.message); }
  pairingDestinations.delete(number);
});
pairingEvents.on('failed', async ({ number }) => {
  const destination = pairingDestinations.get(number);
  if (!destination || destination.connectedSent || destination.failedSent) return;
  destination.failedSent = true;
  destination.outcome = 'failed';
  await deletePairCodeMessage(destination);
  try {
    await sendPairText(destination.chatId,
      `🥀 𝐏ᴀɪʀɪɴɢ 𝐒ᴇssɪᴏɴ 𝐄xᴘɪʀᴇᴅ 𝐎ʀ 𝐅ᴀɪʟᴇᴅ\n\n📱 𝐍ᴜᴍʙᴇʀ: +${number}\n⏳ 𝐓ʜᴇ 𝐒ᴇssɪᴏɴ 𝐃ɪᴅ 𝐍ᴏᴛ 𝐂ᴏɴɴᴇᴄᴛ\n\n🔄 𝐓ʀʏ 𝐀ɢᴀɪɴ\n/pair ${number}`,
      { reply_to_message_id: destination.messageId });
  } catch (err) { console.error('[Telegram] Could not send failed status:', err.message); }
  pairingDestinations.delete(number);
});
const BOX = (title, body) => `🌷 𝐗 Nᴏʙɪᴛᴀ Mᴏᴅᴢ 🌷\n\n${title}\n\n${body}\n\n🌷 𝐒ᴛᴀʏ Cᴏɴɴᴇᴄᴛᴇᴅ • Sᴛᴀʏ Cᴏᴏʟ 💚`;
function normalizeNumber(input) {
  const number = String(input || '').replace(/[+\s()-]/g, '');
  if (!/^\d{7,15}$/.test(number) || number.startsWith('0')) return null;
  return number;
}
async function sendBox(chatId, title, body, extra = {}) {
  return bot.sendMessage(chatId, BOX(title, body), { ...extra, disable_web_page_preview: true });
}
function privateUser(msg) { return msg.chat?.type === 'private' && msg.from?.id != null; }
function isOfficialGroup(msg) {
  return Boolean(OFFICIAL_GROUP_ID && String(msg.chat?.id) === OFFICIAL_GROUP_ID &&
    (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'));
}
function isAdmin(msg) { return Boolean(msg.from?.id != null && ADMIN_IDS.has(String(msg.from.id))); }
function ownedNumbers(userId) {
  const id = String(userId);
  return Object.keys(owners).filter(number => String(owners[number]) === id);
}
function canOwn(userId, number) {
  const owner = owners[number];
  return owner == null || String(owner) === String(userId);
}
function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days} 𝐃ʏ ${hours} 𝐇ʀ ${minutes} 𝐌ɪɴ`;
}
async function adminOnly(msg) {
  if (isAdmin(msg)) return true;
  await sendBox(msg.chat.id, '🔒 𝐀ᴅᴍɪɴ Oɴʟʏ', 'This command is reserved for bot administrators.');
  return false;
}
function usage() {
  return '💞 Pair: /pair NUMBER (Official Group only)\\n📊 /status (Admin)\\n⏱️ /uptime (Admin)\\n💚 /alive (Admin)\\n📋 /help (Admin)';
}

bot.onText(/^\/start(?:@[\\w]+)?(?:\\s.*)?$/i, async msg => {
  if (!(await adminOnly(msg))) return;
  if (!privateUser(msg)) return sendBox(msg.chat.id, '🔒 PRIVATE CHAT ONLY', 'Please open a private chat with this bot.');
  await sendBox(msg.chat.id, `💗 ${BOT_NAME}`, `Each Telegram account can pair only its own WhatsApp number.\\n\\n${usage()}`);
});

bot.onText(/^\/pair(?:@[\w]+)?(?:\s+(.+))?$/i, async (msg, match) => {
  const numberText = match?.[1];
  // In private DM, /pair always directs users to the official pairing group.
  if (msg.chat?.type === 'private') {
    return sendBox(msg.chat.id, '💞 𝐏ᴀɪʀɪɴɢ Gʀᴏᴜᴘ', `Join the official group to request a WhatsApp pairing code:\n${OFFICIAL_GROUP_LINK}\n\nIn that group use:\n/pair 919876543210`);
  }
  if (!isOfficialGroup(msg)) {
    // A safety fallback in case the bot receives a command before Telegram's leave event.
    try { await bot.leaveChat(msg.chat.id); } catch (err) { console.error('[security] Could not leave non-official group:', err.message); }
    return;
  }
  const number = normalizeNumber(numberText);
  if (!number) {
    return sendPairText(msg.chat.id, 'Nobita pair:\n❌ 𝐈ɴᴠᴀʟɪᴅ 𝐍ᴜᴍʙᴇʀ\n\n📱 𝐔sᴇ: /pair 919876543210\n🌍 𝐔sᴇ 𝐅ᴜʟʟ 𝐂ᴏᴜɴᴛʀʏ 𝐂ᴏᴅᴇ', { reply_to_message_id: msg.message_id });
  }
  if (!canOwn(msg.from.id, number)) {
    return sendBox(msg.chat.id, '⛔ 𝐀ᴄᴄᴇss Dᴇɴɪᴇᴅ', 'This number is already assigned to another Telegram account.');
  }

  const userId = String(msg.from.id);
  const wasOwned = owners[number] != null;
  owners[number] = userId;
  saveOwners();
  const waitMsg = await sendPairText(msg.chat.id,
    `⏳ 𝐆ᴇɴᴇʀᴀᴛɪɴɢ 𝐂ᴏᴅᴇ\n\n📱 𝐍ᴜᴍʙᴇʀ: +${number}\n🌍 𝐏ʟᴇᴀsᴇ 𝐖ᴀɪᴛ...`,
    { reply_to_message_id: msg.message_id });
  try {
    const destination = { chatId: msg.chat.id, userId, messageId: msg.message_id, connectedSent: false, failedSent: false, codeMessageId: null, codeMessageDeleted: false, outcome: null };
    pairingDestinations.set(number, destination);
    const result = await startPairing(number);
    try { await bot.deleteMessage(msg.chat.id, String(waitMsg.message_id)); } catch {}
    const country = countryForNumber(number);
    const codeMessage = await sendPairText(msg.chat.id,
      `🌷 𝐗 Nᴏʙɪᴛᴀ Mᴏᴅᴢ\n\n💗 𝐏ᴀɪʀɪɴɢ 𝐂ᴏᴅᴇ 𝐑ᴇᴀᴅʏ\n\n📱 𝐍ᴜᴍʙᴇʀ: +${number}\n🌍 𝐂ᴏᴜɴᴛʀʏ: ${country.flag} ${country.name}${country.code ? ` (+${country.code})` : ''}\n\n🔐 𝐂ᴏᴅᴇ: ${result.code}\n\n⏳ 𝐄xᴘɪʀᴇs 𝐈ɴ: 𝟿𝟶 𝐒ᴇᴄᴏɴᴅs\n⚠️ 𝐃ᴏ 𝐍ᴏᴛ 𝐒ʜᴀʀᴇ 𝐓ʜᴇ 𝐂ᴏᴅᴇ\n\n🌷 𝐗 Nᴏʙɪᴛᴀ Mᴏᴅᴢ`,
      {
        reply_to_message_id: msg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '📋 Copy Code', copy_text: { text: result.code } }]] }
      });
    destination.codeMessageId = codeMessage.message_id;
    if (destination.outcome) await deletePairCodeMessage(destination);
  } catch (err) {
    const destination = pairingDestinations.get(number);
    if (destination) { destination.outcome = 'failed'; await deletePairCodeMessage(destination); pairingDestinations.delete(number); }
    if (!wasOwned && String(owners[number]) === userId) { delete owners[number]; saveOwners(); }
    try { await bot.deleteMessage(msg.chat.id, String(waitMsg.message_id)); } catch {}
    await sendPairText(msg.chat.id,
      `🥀 𝐏ᴀɪʀɪɴɢ 𝐒ᴇssɪᴏɴ 𝐄xᴘɪʀᴇᴅ 𝐎ʀ 𝐅ᴀɪʟᴇᴅ\n\n📱 𝐍ᴜᴍʙᴇʀ: +${number}\n⏳ 𝐓ʜᴇ 𝐒ᴇssɪᴏɴ 𝐃ɪᴅ 𝐍ᴏᴛ 𝐂ᴏɴɴᴇᴄᴛ\n\n🔄 𝐓ʀʏ 𝐀ɢᴀɪɴ\n/pair ${number}`,
      { reply_to_message_id: msg.message_id });
    console.error(`[pair] ${number}:`, err.message || err);
  }
});

bot.onText(/^\/unpair(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!(await adminOnly(msg))) return;
  if (!privateUser(msg)) return sendBox(msg.chat.id, '🔒 PRIVATE CHAT ONLY', 'Please use /unpair in a private chat with this bot.');
  const number = normalizeNumber(match?.[1]);
  if (!number) return sendBox(msg.chat.id, '🔌 UNPAIR DEVICE', 'Use: /unpair 91XXXXXXXXXX');
  if (String(owners[number] ?? '') !== String(msg.from.id)) return sendBox(msg.chat.id, '⛔ ACCESS DENIED', 'You can unpair only a WhatsApp number owned by your Telegram account.');
  try {
    await unpairSession(number);
    delete owners[number];
    delete settings[number];
    saveOwners(); saveSettings();
    await sendBox(msg.chat.id, '✅ SESSION REMOVED', `📱 Number: ${number}\nYour local session and settings were removed. If needed, unlink the device in WhatsApp too.`);
  } catch (err) {
    await sendBox(msg.chat.id, '❌ UNPAIR FAILED', err.message || 'Could not remove this session.');
  }
});

bot.onText(/^\/status(?:@[\w]+)?$/i, async msg => {
  if (!(await adminOnly(msg))) return;
  const active = getSessionStatus();
  const connected = active.filter(s => s.state === 'connected').length;
  const body = `❤️‍🩹 𝐁ᴏᴛ 𝐒ᴛᴀᴛᴜs\n\n🟢 𝐒ᴛᴀᴛᴜs: 𝐎ɴʟɪɴᴇ\n📱 𝐒ᴇssɪᴏɴs: ${connected}\n⏱️ 𝐔ᴘᴛɪᴍᴇ: ${formatUptime(Date.now() - STARTED_AT)}\n⚡ 𝐏ɪɴɢ: 𝐑ᴇᴀʟ-𝐓ɪᴍᴇ\n\n🌷 𝐗 Nᴏʙɪᴛᴀ Mᴏᴅᴢ`;
  await sendPairText(msg.chat.id, body);
});

bot.onText(/^\/uptime(?:@[\w]+)?$/i, async msg => {
  if (!(await adminOnly(msg))) return;
  await sendBox(msg.chat.id, '⏱️ 𝐁ᴏᴛ Uᴘᴛɪᴍᴇ', `🟢 𝐒ᴛᴀᴛᴜs: 𝐎ɴʟɪɴᴇ\n⏱️ 𝐔ᴘᴛɪᴍᴇ: ${formatUptime(Date.now() - STARTED_AT)}`);
});

bot.onText(/^\/alive(?:@[\w]+)?$/i, async msg => {
  if (!(await adminOnly(msg))) return;
  await sendBox(msg.chat.id, '💚 𝐁ᴏᴛ Aʟɪᴠᴇ', `🟢 𝐒ᴛᴀᴛᴜs: 𝐎ɴʟɪɴᴇ\n✨ 𝐒ʏsᴛᴇᴍ: Rᴜɴɴɪɴɢ\n📱 𝐒ᴇssɪᴏɴs: ${getSessionStatus().filter(s => s.state === 'connected').length}\n⏱️ 𝐔ᴘᴛɪᴍᴇ: ${formatUptime(Date.now() - STARTED_AT)}`);
});

bot.onText(/^\/(?:help|halp)(?:@[\w]+)?$/i, async msg => {
  if (!(await adminOnly(msg))) return;
  await sendBox(msg.chat.id, '📋 𝐀ᴅᴍɪɴ Hᴇʟᴘ', usage());
});

bot.onText(/^\/settings(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (!(await adminOnly(msg))) return;
  if (!privateUser(msg)) return sendBox(msg.chat.id, '🔒 PRIVATE CHAT ONLY', 'Please use /settings in a private chat.');
  const mine = ownedNumbers(msg.from.id);
  const requested = match?.[1] ? normalizeNumber(match[1]) : null;
  if (match?.[1] && !requested) return sendBox(msg.chat.id, '⚙️ SETTINGS', 'Use: /settings [your-number]');
  const numbers = requested ? [requested] : mine;
  if (!numbers.length) return sendBox(msg.chat.id, '⚙️ SETTINGS', 'No owned sessions yet. Pair a number first with /pair.');
  if (numbers.some(n => String(owners[n] ?? '') !== String(msg.from.id))) return sendBox(msg.chat.id, '⛔ ACCESS DENIED', 'You can view settings only for your own session.');
  const body = numbers.map(n => `${n}\n${JSON.stringify(settings[n] || { prefix: '.', repliesEnabled: true }, null, 2)}`).join('\n\n');
  await sendBox(msg.chat.id, '⚙️ YOUR SESSION SETTINGS', body);
});

bot.onText(/^\/setsetting(?:@\w+)?(?:\s+(\S+)\s+(\S+)\s+(.+))?$/i, async (msg, match) => {
  if (!(await adminOnly(msg))) return;
  if (!privateUser(msg)) return sendBox(msg.chat.id, '🔒 PRIVATE CHAT ONLY', 'Please use /setsetting in a private chat.');
  const number = normalizeNumber(match?.[1]);
  const key = String(match?.[2] || '').toLowerCase();
  const value = String(match?.[3] || '').trim();
  if (!number || !key || !value) return sendBox(msg.chat.id, '⚙️ SETTING', 'Use: /setsetting NUMBER KEY VALUE\nAllowed keys: prefix, repliesEnabled');
  if (String(owners[number] ?? '') !== String(msg.from.id)) return sendBox(msg.chat.id, '⛔ ACCESS DENIED', 'You can change settings only for your own session.');
  if (!['prefix', 'repliesenabled'].includes(key)) return sendBox(msg.chat.id, '⚙️ SETTING', 'Allowed keys: prefix, repliesEnabled');
  settings[number] ||= { prefix: '.', repliesEnabled: true };
  if (key === 'prefix') {
    if (value.length > 3 || /\s/.test(value)) return sendBox(msg.chat.id, '⚙️ SETTING', 'Prefix must be 1–3 characters with no spaces.');
    settings[number].prefix = value;
  } else {
    if (!['true', 'false'].includes(value.toLowerCase())) return sendBox(msg.chat.id, '⚙️ SETTING', 'repliesEnabled must be true or false.');
    settings[number].repliesEnabled = value.toLowerCase() === 'true';
  }
  saveSettings();
  await sendBox(msg.chat.id, '✅ SETTING SAVED', `${number}\n${key} = ${JSON.stringify(key === 'repliesenabled' ? settings[number].repliesEnabled : settings[number].prefix)}`);
});


bot.on('my_chat_member', async update => {
  const chat = update.chat;
  const status = update.new_chat_member?.status;
  if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
  if (!['member', 'administrator'].includes(status)) return;
  if (OFFICIAL_GROUP_ID && String(chat.id) === OFFICIAL_GROUP_ID) {
    console.log(`[security] Added to official group ${chat.id}.`);
    return;
  }
  console.warn(`[security] Added to non-official group ${chat.id}; leaving.`);
  try { await bot.leaveChat(chat.id); }
  catch (err) { console.error(`[security] Failed to leave group ${chat.id}:`, err.message); }
});

bot.on('polling_error', err => console.error('[Telegram polling]', err.message));
bot.on('error', err => console.error('[Telegram]', err.message));
process.once('SIGINT', async () => { await stopAll(); await bot.stopPolling(); process.exit(0); });
process.once('SIGTERM', async () => { await stopAll(); await bot.stopPolling(); process.exit(0); });
console.log(`💗 ${BOT_NAME} Telegram multi-user pairing bot started.`);
restoreSavedSessions().catch(err => console.error('[sessions] Restore failed:', err.message));
