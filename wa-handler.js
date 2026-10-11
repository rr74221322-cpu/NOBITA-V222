const moduleStartedAt = Date.now();

function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 8 && current; i++) {
    const wrapped = current.ephemeralMessage?.message || current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message || current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message || current.editedMessage?.message;
    if (!wrapped) break;
    current = wrapped;
  }
  return current || {};
}

function extractText(message) {
  const m = unwrapMessage(message);
  return String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText || m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title || m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedId ||
    m.interactiveResponseMessage?.body?.text || '').trim();
}

function normalizeJid(jid) {
  return String(jid || '').replace(/:\d+@/, '@').replace(/@c\.us$/, '@s.whatsapp.net');
}
function numberJid(input) {
  const number = String(input || '').replace(/[+\s()-]/g, '');
  return /^\d{7,15}$/.test(number) && !number.startsWith('0') ? `${number}@s.whatsapp.net` : null;
}
function styled(text) { return text; }
async function reply(socket, jid, msg, text) {
  await socket.sendMessage(jid, { text: styled(text) }, { quoted: msg });
}

function registerWhatsAppHandler(socket, number, getSettings = () => ({ prefix: '.', repliesEnabled: true })) {
  const seenMessageIds = new Set();
  function readAllSettings() {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'data', 'settings.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  function updateSettings(patch) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'data');
    const file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const all = readAllSettings();
    all[number] = { prefix: '.', repliesEnabled: true, mode: 'public', blockedJids: [], knownChats: [], ...(all[number] || {}), ...patch };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    return all[number];
  }

  function readWelcomeStore() {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'data', 'welcome.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  function writeWelcomeStore(store) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'data');
    const file = path.join(dir, 'welcome.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const defaultWelcome = '🌸 হেইইই {user} 🥰💗 {userdp}\n\n🎀 Welcome to {groupname} 🫶✨\n\n💖 আমাদের ছোট্ট আড্ডার পরিবারে তোমাকে জানাই অনেক অনেক স্বাগতম! 🌷🥹\n\n😚 এখানে সবার সাথে গল্প করো, হাসি-মজা করো আর নতুন নতুন বন্ধু বানাও! 💕🤝\n\n🦋 আশা করি আমাদের সাথে তোমার প্রতিটা মুহূর্ত সুন্দর আর আনন্দে কাটবে! 🌈💝\n\n🙈 চুপচাপ থাকা চলবে না কিন্তু, সবার সাথে মিশে আড্ডা জমিয়ে তুলতে হবে! 😂💗\n\n🌹 Once Again, Welcome to Our Adda Family! 🫂💞\n\n✨ Stay Active • Keep Smiling • Spread Love ✨';
  const defaultGoodbye = '🥀 *𝐆ᴏᴏᴅʙʏᴇ* 💔\n\n👤 𝐌ᴇᴍʙᴇʀ: {user}\n🏠 𝐆ʀᴏᴜᴘ: {group}\n👥 𝐌ᴇᴍʙᴇʀs: {count}\n\n💗 𝐖ᴇ ᴡɪʟʟ ᴍɪss ʏᴏᴜ!\n👑 *𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃*';
  function getWelcomeConfig(groupJid) {
    const store = readWelcomeStore();
    return store[number]?.[groupJid] || { enabled: false, message: defaultWelcome };
  }
  function setWelcomeConfig(groupJid, patch) {
    const store = readWelcomeStore();
    store[number] ||= {};
    store[number][groupJid] = { enabled: false, message: defaultWelcome, ...(store[number][groupJid] || {}), ...patch };
    writeWelcomeStore(store);
    return store[number][groupJid];
  }
  function getGoodbyeConfig(groupJid) {
    const store = readWelcomeStore();
    return store[number]?.[groupJid]?.goodbye || { enabled: false, message: defaultGoodbye };
  }
  function setGoodbyeConfig(groupJid, patch) {
    const store = readWelcomeStore();
    store[number] ||= {};
    const current = store[number][groupJid] || { enabled: false, message: defaultWelcome };
    current.goodbye = { enabled: false, message: defaultGoodbye, ...(current.goodbye || {}), ...patch };
    store[number][groupJid] = current;
    writeWelcomeStore(store);
    return current.goodbye;
  }
  function renderWelcome(template, participant, groupName, count) {
    const mentionNumber = String(participant || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return String(template || defaultWelcome)
      .replace(/\{user\}/gi, mentionNumber ? `@${mentionNumber}` : '@member')
      .replace(/\{groupname\}/gi, groupName || 'Group')
      .replace(/\{group\}/gi, groupName || 'Group')
      .replace(/\{count\}/gi, String(count ?? 'N/A'))
      .replace(/\{userdp\}/gi, '')
      .replace(/\{dp\}/gi, '');
  }

  socket.ev.on('group-participants.update', async update => {
    try {
      const groupJid = update?.id;
      if (!groupJid || !groupJid.endsWith('@g.us') || !['add', 'invite'].includes(update.action)) return;
      const config = getWelcomeConfig(groupJid);
      if (!config.enabled) return;
      const metadata = await socket.groupMetadata(groupJid).catch(() => null);
      const groupName = metadata?.subject || 'Group';
      const count = metadata?.participants?.length ?? 'N/A';
      for (const participant of (update.participants || [])) {
        const template = config.message || defaultWelcome;
        const hasDp = /\{(?:userdp|dp)\}/i.test(template);
        const caption = renderWelcome(template, participant, groupName, count);
        const mentionNumber = String(participant || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const mentions = participant ? [participant] : [];
        if (hasDp) {
          try {
            const pictureUrl = await socket.profilePictureUrl(participant, 'image');
            const response = await fetch(pictureUrl);
            if (!response.ok) throw new Error('Profile picture unavailable');
            const imageBuffer = Buffer.from(await response.arrayBuffer());
            await socket.sendMessage(groupJid, { image: imageBuffer, caption, mentions });
            continue;
          } catch (err) {
            // If a profile picture cannot be retrieved, still deliver the welcome text.
          }
        }
        await socket.sendMessage(groupJid, { text: caption, mentions });
      }
    } catch (err) {
      console.error(`[${number}] welcome event failed:`, err.stack || err.message || err);
    }
  });

  socket.ev.on('group-participants.update', async update => {
    try {
      const groupJid = update?.id;
      if (!groupJid || !groupJid.endsWith('@g.us') || !['remove', 'leave'].includes(update.action)) return;
      const config = getGoodbyeConfig(groupJid);
      if (!config.enabled) return;
      const metadata = await socket.groupMetadata(groupJid).catch(() => null);
      const groupName = metadata?.subject || 'Group';
      const count = metadata?.participants?.length ?? 'N/A';
      for (const participant of (update.participants || [])) {
        const template = config.message || defaultGoodbye;
        const caption = String(template)
          .replace(/\{user\}/gi, `@${String(participant || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'member'}`)
          .replace(/\{group\}/gi, groupName)
          .replace(/\{count\}/gi, String(count))
          .replace(/\{dp\}/gi, '');
        const mentions = participant ? [participant] : [];
        if (/\{dp\}/i.test(template)) {
          try {
            const pictureUrl = await socket.profilePictureUrl(participant, 'image');
            const response = await fetch(pictureUrl);
            if (!response.ok) throw new Error('Profile picture unavailable');
            const imageBuffer = Buffer.from(await response.arrayBuffer());
            await socket.sendMessage(groupJid, { image: imageBuffer, caption, mentions });
            continue;
          } catch (err) { /* Send text if the profile picture is unavailable. */ }
        }
        await socket.sendMessage(groupJid, { text: caption, mentions });
      }
    } catch (err) {
      console.error(`[${number}] goodbye event failed:`, err.stack || err.message || err);
    }
  });

  // Legacy WhatsApp text commands are intentionally disabled. All text
  // commands are handled by commands-only.js on the same existing socket.
  // Keep the group-participant listener above for welcome/goodbye automation.
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    return;
    /* Legacy command implementation retained below for reference only. */
    if (!['notify', 'append'].includes(type) || !Array.isArray(messages)) return;
    for (const msg of messages) {
      const id = msg?.key?.id;
      const jid = msg?.key?.remoteJid;
      if (!msg?.message || !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      if (id && seenMessageIds.has(id)) continue;
      if (id) { seenMessageIds.add(id); if (seenMessageIds.size > 2000) seenMessageIds.clear(); }

      const ownJids = new Set([normalizeJid(`${number}@s.whatsapp.net`), normalizeJid(socket.user?.id), normalizeJid(socket.user?.lid)].filter(Boolean));
      const isOwner = msg.key?.fromMe === true;
      const normalizedJid = normalizeJid(jid);
      const content = extractText(msg.message);
      if (!content) continue;

      let config = getSettings() || { prefix: '.', repliesEnabled: true };
      config = { prefix: '.', repliesEnabled: true, mode: 'public', blockedJids: [], knownChats: [], ...config };
      const knownChats = [...new Set([...(config.knownChats || []), jid])];
      if (knownChats.length !== (config.knownChats || []).length) config = updateSettings({ knownChats });
      const prefix = typeof config.prefix === 'string' && config.prefix ? config.prefix : '.';
      const blocked = new Set((config.blockedJids || []).map(normalizeJid));
      if (blocked.has(normalizedJid) && !isOwner) continue;
      if (!content.startsWith(prefix)) continue;
      if (config.repliesEnabled === false) continue;

      const parts = content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
      const command = (parts[0] || '').toLowerCase().split('@')[0];
      const args = parts.slice(1);
      const argText = args.join(' ').trim();
      const ownerCommands = new Set(['setprefix', 'pair', 'public', 'private', 'block', 'unblock', 'broadcast', 'welcome', 'setwelcome', 'getwelcome', 'resetwelcome', 'goodbye', 'setgoodbye', 'getgoodbye', 'resetgoodbye']);
      if (ownerCommands.has(command) && !isOwner) {
        await reply(socket, jid, msg, '*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*');
        continue;
      }
      if (config.mode === 'private' && !isOwner && !ownerCommands.has(command)) continue;

      try {
        const botStartedAt = moduleStartedAt;
        const getUptime = () => {
          let seconds = Math.floor((Date.now() - botStartedAt) / 1000);
          const days = Math.floor(seconds / 86400); seconds %= 86400;
          const hours = Math.floor(seconds / 3600); seconds %= 3600;
          const minutes = Math.floor(seconds / 60);
          return `${days} 𝐃ᴀʏs, ${hours} 𝐇ᴏᴜʀs, ${minutes} 𝐌ɪɴs`;
        };
        if (command === 'ping') {
          const started = Date.now();
          const pingMs = Date.now() - started;
          await reply(socket, jid, msg, `💗 𝐏ᴏɴɢ!  𝐒ᴘᴇᴇᴅ: ${pingMs}𝐦𝐬 🌷`);
        } else if (command === 'alive') {
          await reply(socket, jid, msg,
            `🟢 *𝐒ᴛᴀᴛᴜs: 𝐎ɴʟɪɴᴇ*\n📱 *𝐒ᴇssɪᴏɴs: 𝟏*\n⏱️ *𝐔ᴘᴛɪᴍᴇ: ${getUptime()}* 💜\n⚡ *𝐏ɪɴɢ: 𝐑ᴇᴀʟ-𝐓ɪᴍᴇ*\n\n🌷 *𝐗 𝐍ᴏʙɪᴛᴀ 𝐌ᴏᴅᴢ*`);
        } else if (command === 'time') {
          const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
          await reply(socket, jid, msg, `⏰ *𝐂ᴜʀʀᴇɴᴛ 𝐓ɪᴍᴇ: ${time}* 💗`);
        } else if (command === 'date') {
          const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
          await reply(socket, jid, msg, `📅 *𝐓ᴏᴅᴀʏ's 𝐃ᴀᴛᴇ: ${date}* 🌸`);
        } else if (command === 'botinfo') {
          await reply(socket, jid, msg, '🤖 *𝐍ᴀᴍᴇ: 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ*\n🌷 *𝐕ᴇʀsɪᴏɴ: 𝟏.𝟎* 💗');
        } else if (command === 'support') {
          await reply(socket, jid, msg, '💌 *𝐒ᴜᴘᴘᴏʀᴛ 𝐋ɪɴᴋ 𝐑ᴇᴀᴅʏ!* 💗\n🔗 https://whatsapp.com/channel/0029VbDtZiW4dTnQtGld7D0e');
        } else if (command === 'uptime') {
          await reply(socket, jid, msg, `⏱️ *𝐔ᴘᴛɪᴍᴇ: ${getUptime()}* 💜🌷`);
        } else if (command === 'echo') {
          if (!argText) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}echo Hello 💞`);
          } else {
            await reply(socket, jid, msg, `💞 *𝐌ᴇssᴀɢᴇ: ${argText}* 🌷`);
          }
        } else if (command === 'menu') {
          // The comprehensive menu is handled by commands-only.js on this same socket.
          // Skip the legacy short menu to prevent duplicate replies.
          continue;
        } else if (command === 'help') {
          await reply(socket, jid, msg,
            `💌 *𝐇ᴇʟᴘ 𝐂ᴏᴍᴍᴀɴᴅ 𝐑ᴇᴀᴅʏ!* 🌸\n💗 *𝐔sᴇ ${prefix}menu 𝐓ᴏ 𝐕ɪᴇᴡ 𝐀ʟʟ 𝐂ᴏᴍᴍᴀɴᴅs!*`);
        } else if (command === 'welcome') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐒ʏsᴛᴇᴍ*\nUse this command inside a group.');
            continue;
          }
          const action = String(args[0] || '').toLowerCase();
          if (!['on', 'off'].includes(action)) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}welcome on/off`);
            continue;
          }
          setWelcomeConfig(jid, { enabled: action === 'on' });
          await reply(socket, jid, msg, action === 'on'
            ? '🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐒ʏsᴛᴇᴍ 𝐄ɴᴀʙʟᴇᴅ!* 💗\n✅ New members will be welcomed.'
            : '🔕 *𝐖ᴇʟᴄᴏᴍᴇ 𝐒ʏsᴛᴇᴍ 𝐃ɪsᴀʙʟᴇᴅ!*\n❌ Automatic welcome messages stopped.');
        } else if (command === 'setwelcome') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐒ʏsᴛᴇᴍ*\nUse this command inside a group.');
            continue;
          }
          if (!argText) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}setwelcome Your message\nVariables: {user}, {group}, {count}, {dp}`);
            continue;
          }
          setWelcomeConfig(jid, { message: argText });
          await reply(socket, jid, msg, '🌷 *𝐂ᴜsᴛᴏᴍ 𝐖ᴇʟᴄᴏᴍᴇ 𝐒ᴀᴠᴇᴅ!* 💗\n✅ Your welcome message has been saved for this group.');
        } else if (command === 'getwelcome') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🌷 Use this command inside a group.');
            continue;
          }
          const welcome = getWelcomeConfig(jid);
          await reply(socket, jid, msg, `🌸 *𝐂ᴜʀʀᴇɴᴛ 𝐖ᴇʟᴄᴏᴍᴇ* 💗\n🔔 Status: ${welcome.enabled ? 'Enabled' : 'Disabled'}\n\n${welcome.message || defaultWelcome}`);
        } else if (command === 'resetwelcome') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🌷 Use this command inside a group.');
            continue;
          }
          setWelcomeConfig(jid, { message: defaultWelcome });
          await reply(socket, jid, msg, '🌸 *𝐖ᴇʟᴄᴏᴍᴇ 𝐑ᴇsᴇᴛ 𝐃ᴏɴᴇ!*\n✅ Default message restored.');
        } else if (command === 'goodbye') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🥀 *𝐆ᴏᴏᴅʙʏᴇ 𝐒ʏsᴛᴇᴍ*\nUse this command inside a group.');
            continue;
          }
          const action = String(args[0] || '').toLowerCase();
          if (!['on', 'off'].includes(action)) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}goodbye on/off`);
            continue;
          }
          setGoodbyeConfig(jid, { enabled: action === 'on' });
          await reply(socket, jid, msg, action === 'on'
            ? '🥀 *𝐆ᴏᴏᴅʙʏᴇ 𝐒ʏsᴛᴇᴍ 𝐄ɴᴀʙʟᴇᴅ!* 💗\n✅ Leaving members will receive a goodbye message.'
            : '🔕 *𝐆ᴏᴏᴅʙʏᴇ 𝐒ʏsᴛᴇᴍ 𝐃ɪsᴀʙʟᴇᴅ!*\n❌ Automatic goodbye messages stopped.');
        } else if (command === 'setgoodbye') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🥀 Use this command inside a group.');
            continue;
          }
          if (!argText) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}setgoodbye Your message\nVariables: {user}, {group}, {count}, {dp}`);
            continue;
          }
          setGoodbyeConfig(jid, { message: argText });
          await reply(socket, jid, msg, '🥀 *𝐂ᴜsᴛᴏᴍ 𝐆ᴏᴏᴅʙʏᴇ 𝐒ᴀᴠᴇᴅ!* 💗\n✅ Your goodbye message has been saved for this group.');
        } else if (command === 'getgoodbye') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🥀 Use this command inside a group.');
            continue;
          }
          const goodbye = getGoodbyeConfig(jid);
          await reply(socket, jid, msg, `🥀 *𝐂ᴜʀʀᴇɴᴛ 𝐆ᴏᴏᴅʙʏᴇ* 💗\n🔔 Status: ${goodbye.enabled ? 'Enabled' : 'Disabled'}\n\n${goodbye.message || defaultGoodbye}`);
        } else if (command === 'resetgoodbye') {
          if (!jid.endsWith('@g.us')) {
            await reply(socket, jid, msg, '🥀 Use this command inside a group.');
            continue;
          }
          setGoodbyeConfig(jid, { message: defaultGoodbye });
          await reply(socket, jid, msg, '🥀 *𝐆ᴏᴏᴅʙʏᴇ 𝐑ᴇsᴇᴛ 𝐃ᴏɴᴇ!*\n✅ Default message restored.');
        } else if (command === 'setprefix') {
          if (!argText || argText.length > 3 || /\s/.test(argText)) {
            await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}setprefix !\n*𝐏ʀᴇғɪx 𝐌ᴜsᴛ 𝐁ᴇ 𝟏–𝟑 𝐂ʜᴀʀᴀᴄᴛᴇʀs!* ⚙️💜`);
            continue;
          }
          updateSettings({ prefix: argText });
          await reply(socket, jid, msg, `*𝐏ʀᴇғɪx 𝐔ᴘᴅᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ! ⚙️💜*\n*𝐍ᴇᴡ 𝐏ʀᴇғɪx : ${argText} 👑✨*`);
        } else if (command === 'pair') {
          await reply(socket, jid, msg, '*𝐏ᴀɪʀɪɴɢ 𝐈s 𝐌ᴀɴᴀɢᴇᴅ 𝐕ɪᴀ 𝐓ᴇʟᴇɢʀᴀᴍ! 🔗💋*\n*𝐔sᴇ /pair NUMBER 𝐈ɴ 𝐘ᴏᴜʀ 𝐓ᴇʟᴇɢʀᴀᴍ 𝐁ᴏᴛ! 💜✨*');
        } else if (command === 'public') {
          updateSettings({ mode: 'public' });
          await reply(socket, jid, msg, '*𝐁ᴏᴛ 𝐌ᴏᴅᴇ 𝐒ᴇᴛ 𝐓ᴏ 𝐏ᴜʙʟɪᴄ! 🌐💚*\n*𝐍ᴏᴡ 𝐄ᴠᴇʀʏᴏɴᴇ 𝐂ᴀɴ 𝐔sᴇ 𝐈ᴛ! 💋✨*');
        } else if (command === 'private') {
          updateSettings({ mode: 'private' });
          await reply(socket, jid, msg, '*𝐁ᴏᴛ 𝐌ᴏᴅᴇ 𝐒ᴇᴛ 𝐓ᴏ 𝐏ʀɪᴠᴀᴛᴇ! 🔒💜*\n*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐈ᴛ! 👑❤️‍🩹*');
        } else if (command === 'block' || command === 'unblock') {
          const target = numberJid(args[0]);
          if (!target) { await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}${command} 91XXXXXXXXXX 🚫`); continue; }
          const next = new Set((config.blockedJids || []).map(normalizeJid));
          if (command === 'block') next.add(target); else next.delete(target);
          updateSettings({ blockedJids: [...next] });
          await reply(socket, jid, msg, command === 'block'
            ? '*𝐔sᴇʀ 𝐁ʟᴏᴄᴋᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ! 🚫💔*\n*𝐁ᴏᴛ 𝐑ᴇᴘʟɪᴇs 𝐑ᴇsᴛʀɪᴄᴛᴇᴅ! 👑💜*'
            : '*𝐔sᴇʀ 𝐔ɴʙʟᴏᴄᴋᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ! ✅💚*\n*𝐁ᴏᴛ 𝐑ᴇᴘʟɪᴇs 𝐑ᴇsᴛᴏʀᴇᴅ! 💋✨*');
        } else if (command === 'broadcast') {
          if (!argText) { await reply(socket, jid, msg, `*𝐔sᴀɢᴇ:* ${prefix}broadcast Your message 📢`); continue; }
          const chats = [...new Set(config.knownChats || [])].filter(chat => chat !== jid && chat !== 'status@broadcast' && !chat.endsWith('@newsletter'));
          let sent = 0;
          for (const chat of chats) {
            try { await socket.sendMessage(chat, { text: argText }); sent++; }
            catch (err) { console.error(`[${number}] broadcast failed for ${chat}:`, err.message); }
          }
          await reply(socket, jid, msg, `*𝐁ʀᴏᴀᴅᴄᴀsᴛ 𝐂ᴏᴍᴘʟᴇᴛᴇ! 📢❤️‍🩹*\n*𝐒ᴇɴᴛ: ${sent}/${chats.length} 𝐂ʜᴀᴛs! 💜✨*`);
        } else {
          // Unknown commands are intentionally ignored.
        }
      } catch (err) {
        console.error(`[${number}] handler/send failed for ${command}:`, err.stack || err.message || err);
      }
    }
  });
}

module.exports = { registerWhatsAppHandler, extractText, normalizeJid };
