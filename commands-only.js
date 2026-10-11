// X NOBITA XD — COMMANDS ONLY
// This module deliberately contains NO Baileys import, socket creation, pairing,
// connection/reconnect lifecycle, or sock.ev event registration.
// Integrate it into your own bot by passing that bot's existing sock and calling
// handler(message) from your own message dispatcher.

const fs = require("fs");
const { generateWAMessageContent, generateMessageID } = require("@whiskeysockets/baileys");
const config = require("./config");
const botSettings = require("./botSettings");
const { automationCommand, autoreactCommand } = require("./plugins/automation");
const { handlePlaySong } = require("./plugins/downloader");
const { handleFunCommand } = require("./plugins/fun");
const { handleSourceCommand, handleMediaCommand } = require("./plugins/sourceCommands");

const commandReactionEmojis = ["❤️", "💜", "😂", "🥺", "⚡", "🌷", "🫶🏻", "🔥", "🌸", "🎀", "👀", "🤍", "🥀", "✨"];
function getRandomCommandReaction() {
  return commandReactionEmojis[Math.floor(Math.random() * commandReactionEmojis.length)];
}

function createCommandHandler({ sock, config: suppliedConfig, botSettings: suppliedSettings, downloadMediaMessage, logger } = {}) {
  if (!sock) throw new Error("Pass your target bot's existing sock into createCommandHandler().");
  const activeConfig = suppliedConfig || config;
  const settingsStore = suppliedSettings || botSettings;
  const settingsKey = String(activeConfig.ownerNumber || "").replace(/\D/g, "");
  const savedSettings = settingsStore.get(settingsKey) || {};
  const runtimeConfig = {
    ...activeConfig,
    ownerNumber: activeConfig.ownerNumber,
    prefix: savedSettings.prefix || activeConfig.prefix || ".",
    mode: savedSettings.botMode || activeConfig.mode || "public",
    ownerName: activeConfig.ownerName
  };
  const botJid = String(sock.user?.id || runtimeConfig.ownerNumber || "").split(":")[0];
  const antiGroupStatus = new Set();
  const antiSticker = new Set();
  const antiLinkMode = new Map();
  const antiLinkWarns = new Map();
  const warnCounts = new Map();
  const welcomeGroups = new Set();
  const goodbyeGroups = new Set();

  // Welcome/goodbye listener uses the same persistent settings store as commands.
  // Baileys participant updates can contain JIDs or participant objects depending on version.
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const groupJid = String(update?.id || update?.jid || "");
      if (!groupJid.endsWith("@g.us")) return;
      const action = String(update?.action || "").toLowerCase();
      const isJoin = ["add", "invite"].includes(action);
      const isLeave = ["remove", "leave"].includes(action);
      if (!isJoin && !isLeave) return;
      const groupSettings = settingsStore.get(settingsKey)?.groups?.[groupJid] || {};
      if (!(isJoin ? groupSettings.welcome : groupSettings.goodbye)) return;
      let metadata;
      try { metadata = await sock.groupMetadata(groupJid); } catch (e) {
        console.error("[welcome-goodbye] group metadata failed:", e?.message || e);
      }
      const groupName = metadata?.subject || "Group";
      const count = metadata?.participants?.length ?? "N/A";
      const participants = Array.isArray(update?.participants) ? update.participants : [];
      for (const entry of participants) {
        const participant = typeof entry === "string" ? entry : (entry?.id || entry?.jid || entry?.participant || "");
        if (!participant) continue;
        const number = String(participant).split("@")[0].split(":")[0].replace(/\D/g, "");
        const user = number ? `@${number}` : "@member";
        const template = isJoin
          ? "🌸 হেইইই {user} 🥰💗 {userdp}\n\n🎀 Welcome to {groupname} 🫶✨\n\n💖 আমাদের ছোট্ট আড্ডার পরিবারে তোমাকে জানাই অনেক অনেক স্বাগতম! 🌷🥹\n\n😚 এখানে সবার সাথে গল্প করো, হাসি-মজা করো আর নতুন নতুন বন্ধু বানাও! 💕🤝\n\n🦋 আশা করি আমাদের সাথে তোমার প্রতিটা মুহূর্ত সুন্দর আর আনন্দে কাটবে! 🌈💝\n\n🙈 চুপচাপ থাকা চলবে না কিন্তু, সবার সাথে মিশে আড্ডা জমিয়ে তুলতে হবে! 😂💗\n\n🌹 Once Again, Welcome to Our Adda Family! 🫂💞\n\n✨ Stay Active • Keep Smiling • Spread Love ✨"
          : "🥀 *𝐆ᴏᴏᴅʙʏᴇ* 💔\n\n👤 𝐌ᴇᴍʙᴇʀ: {user}\n🏠 𝐆ʀᴏᴜᴘ: {group}\n👥 𝐌ᴇᴍʙᴇʀs: {count}\n\n💗 𝐖ᴇ ᴡɪʟʟ ᴍɪss ʏᴏᴜ!\n👑 *𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃*";
        const text = template.replace(/\{user\}/gi, user).replace(/\{groupname\}/gi, groupName).replace(/\{group\}/gi, groupName).replace(/\{count\}/gi, String(count)).replace(/\{userdp\}/gi, '').replace(/\{dp\}/gi, '');
        const mentions = participant ? [participant] : [];
        if (isJoin && /\{userdp\}/i.test(template)) {
          try {
            const pictureUrl = await sock.profilePictureUrl(participant, 'image');
            const response = await fetch(pictureUrl);
            if (!response.ok) throw new Error('Profile picture unavailable');
            const imageBuffer = Buffer.from(await response.arrayBuffer());
            await sock.sendMessage(groupJid, { image: imageBuffer, caption: text, mentions });
            continue;
          } catch (err) {
            // If no profile picture is available, send the welcome as plain text.
          }
        }
        await sock.sendMessage(groupJid, { text, mentions });
      }
    } catch (err) {
      console.error("[welcome-goodbye] participant event failed:", err?.stack || err?.message || err);
    }
  });
  const reactedCommandKeys = new Set();
  const moderatedMessageKeys = new Set();
  const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s]+|(?:chat\.whatsapp\.com|wa\.me|t\.me|telegram\.me|discord\.gg|bit\.ly|tinyurl\.com)\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|me|app|online|site|link|dev|co|in|info|biz|ly)\b(?:\/[^\s]*)?/i;

  function unwrapIncomingMessage(message) {
    let current = message;
    for (let i = 0; i < 12 && current; i++) {
      const next = current.ephemeralMessage?.message ||
        current.viewOnceMessage?.message ||
        current.viewOnceMessageV2?.message ||
        current.viewOnceMessageV2Extension?.message ||
        current.documentWithCaptionMessage?.message ||
        current.editedMessage?.message;
      if (!next) break;
      current = next;
    }
    return current || message || {};
  }

  function getIncomingText(message) {
    const m = unwrapIncomingMessage(message);
    return String(m.conversation || m.extendedTextMessage?.text ||
      m.imageMessage?.caption || m.videoMessage?.caption ||
      m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText ||
      m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.title ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId || "");
  }

  const contextInfo = {
    isForwarded: true,
    forwardingScore: 999,
    forwardedNewsletterMessageInfo: {
      newsletterJid: '120363429701595203@newsletter',
      newsletterName: '𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐌𝐎𝐃𝐙',
      serverMessageId: -1,
    },
  };
  const quotedContact = {
    key: { fromMe: false, participant: "919864401884@s.whatsapp.net", remoteJid: "status@broadcast" },
    message: { contactMessage: { displayName: "ყơųཞ ҳ ŋơცıɬą", vcard: [
      "BEGIN:VCARD", "VERSION:3.0", "N:;ყơųཞ ҳ ŋơცıɬą;;", "FN:ყơųཞ ҳ ŋơცıɬą",
      "item1.TEL;waid=919864401884:919864401884", "item1.X-ABLabel:WhatsApp", "END:VCARD"
    ].join("\n") } }
  };

const processCommandMessage = async (msg) => {
  try {
    if (!msg || !msg.key) return;
    console.log(`  MSG | chat: ${msg.key.remoteJid} | fromMe: ${msg.key.fromMe} | msgType: ${JSON.stringify(msg.message).slice(0, 150)}`);

    if (msg.key.remoteJid === "status@broadcast") return;

    // Moderation must inspect every group message, not only prefixed commands.
    const chatJid = msg.key.remoteJid || "";
    const isGroup = chatJid.endsWith("@g.us");
    const groupSettings = settingsStore.get(settingsKey)?.groups?.[chatJid] || {};
    const incomingMessage = unwrapIncomingMessage(msg.message);
    const incomingText = getIncomingText(msg.message);
    const messageKey = `${chatJid}:${msg.key.id || ""}:${msg.key.participant || ""}`;
    const isDuplicateModerationEvent = moderatedMessageKeys.has(messageKey);
    if (messageKey && !isDuplicateModerationEvent) {
      moderatedMessageKeys.add(messageKey);
      if (moderatedMessageKeys.size > 5000) moderatedMessageKeys.delete(moderatedMessageKeys.values().next().value);
    }

    if (isGroup && !msg.key.fromMe && !isDuplicateModerationEvent) {
      const antiStickerEnabled = groupSettings.antisticker === true || antiSticker.has(chatJid);
      if (antiStickerEnabled && incomingMessage.stickerMessage) {
        try {
          await sock.sendMessage(chatJid, { delete: msg.key });
          console.log(`[antisticker] Deleted sticker in ${chatJid}`);
        } catch (err) {
          console.error(`[antisticker] Could not delete sticker in ${chatJid}:`, err?.message || err);
        }
        return;
      }

      const antiLinkModeValue = groupSettings.antilink || antiLinkMode.get(chatJid);
      if (antiLinkModeValue && incomingText && LINK_PATTERN.test(incomingText)) {
        try {
          const metadata = await sock.groupMetadata(chatJid);
          const participants = metadata?.participants || [];
          const norm = value => String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
          const senderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
          const sender = participants.find(participant => participant.id === senderJid || participant.lid === senderJid || (norm(participant.id) && norm(participant.id) === norm(senderJid)) || (norm(participant.lid) && norm(participant.lid) === norm(senderJid)));
          const botJids = [sock.user?.id, sock.user?.lid, botJid].filter(Boolean);
          const bot = participants.find(participant => botJids.some(jid => participant.id === jid || participant.lid === jid || (norm(participant.id) && norm(participant.id) === norm(jid)) || (norm(participant.lid) && norm(participant.lid) === norm(jid))));
          const isAdmin = participant => participant?.admin === "admin" || participant?.admin === "superadmin";
          // Do not moderate group admins or the bot itself.
          const isBotSender = botJids.some(jid => norm(jid) && norm(jid) === norm(senderJid));
          if (sender && !isAdmin(sender) && !isBotSender && isAdmin(bot)) {
            await sock.sendMessage(chatJid, { delete: msg.key });
            console.log(`[antilink] Deleted link from ${senderJid} in ${chatJid}`);
            if (antiLinkModeValue === "kick") {
              await sock.groupParticipantsUpdate(chatJid, [sender.id || senderJid], "remove");
            } else if (antiLinkModeValue === "warn") {
              const warnKey = `${chatJid}:${sender.id || senderJid}`;
              const count = (antiLinkWarns.get(warnKey) || 0) + 1;
              if (count >= 3) {
                antiLinkWarns.delete(warnKey);
                await sock.groupParticipantsUpdate(chatJid, [sender.id || senderJid], "remove");
              } else {
                antiLinkWarns.set(warnKey, count);
                await sock.sendMessage(chatJid, { text: `⚠️ @${norm(sender.id || senderJid)} link warning ${count}/3.`, mentions: [sender.id || senderJid] });
              }
            }
            return;
          } else if (!isAdmin(bot)) {
            console.warn(`[antilink] Cannot delete: bot is not detected as group admin in ${chatJid}`);
          }
        } catch (err) {
          console.error(`[antilink] Moderation failed in ${chatJid}:`, err?.message || err);
        }
      }
    }

    // Do NOT ignore fromMe messages. This bot is commonly controlled from
    // the same WhatsApp account that is linked to the bot.
    const text = incomingText;
    console.log(`    text: "${text}"`);
    if (!text.startsWith(runtimeConfig.prefix)) {
      console.log("    -> no command prefix, ignored");
      return;
    }

    const command = text.slice(runtimeConfig.prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
    if (!command) return;
    console.log(`    -> COMMAND detected: ${command}`);

    // PRIVATE MODE: completely ignore commands from non-owner users.
    // This runs before reactions and command handlers, so there is NO response/reaction.
    const earlySenderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
    const earlyOwnerNumber = String(runtimeConfig.ownerNumber || "").replace(/\D/g, "");
    const earlySenderNumber = String(earlySenderJid).split("@")[0].split(":")[0].replace(/\D/g, "");
    const earlyIsOwner = msg.key.fromMe || (earlyOwnerNumber && earlySenderNumber === earlyOwnerNumber);
    if (runtimeConfig.mode === "private" && !earlyIsOwner && command !== "play" && command !== "song" && !["ship","love","truth","dare","8ball","joke","meme","quiz","dice","rps","guess"].includes(command)) {
      console.log(`    -> PRIVATE MODE: ignored .${command} from non-owner`);
      return;
    }

    // React to every prefixed group command with one random emoji.
    if (msg.key.remoteJid?.endsWith("@g.us")) {
      const reactionKey = `${msg.key.remoteJid}:${msg.key.id}:${msg.key.participant || ""}`;
      if (!reactedCommandKeys.has(reactionKey)) {
        reactedCommandKeys.add(reactionKey);
        if (reactedCommandKeys.size > 5000) {
          const firstKey = reactedCommandKeys.values().next().value;
          if (firstKey) reactedCommandKeys.delete(firstKey);
        }
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: getRandomCommandReaction(), key: msg.key }
          });
          console.log(`    ✅ RANDOM REACTION sent for .${command}`);
        } catch (reactionError) {
          console.log(`    ⚠️ Command reaction failed: ${reactionError?.message || reactionError}`);
        }
      }
    }

    const args = text.slice(runtimeConfig.prefix.length).trim().split(/\s+/).slice(1);
    const commandText = text.slice(runtimeConfig.prefix.length).trim();

    const normalizeJidNumber = (jid = "") =>
      String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");

    const findGroupParticipant = (participants = [], jid = "") => {
      const base = normalizeJidNumber(jid);
      return participants.find(p =>
        p.id === jid ||
        p.lid === jid ||
        normalizeJidNumber(p.id) === base ||
        normalizeJidNumber(p.lid) === base
      );
    };

    const findBotParticipant = (participants = []) => {
      const botIds = [
        sock.user?.id,
        sock.user?.lid,
        sock.user?.jid
      ].filter(Boolean);
      return participants.find(p =>
        botIds.some(id =>
          p.id === id ||
          p.lid === id ||
          normalizeJidNumber(p.id) === normalizeJidNumber(id) ||
          normalizeJidNumber(p.lid) === normalizeJidNumber(id)
        )
      );
    };



    let reply = "";
    let replyMentions = [];
    // Automation handlers reply immediately, so provide the shared vCard sender here.
    const replyWithContact = async (text) => {
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: String(text || "") },
        { quoted: quotedContact }
      );
    };
    const senderJidForCommand = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
    const ownerNumberForCommand = String(runtimeConfig.ownerNumber || "").replace(/\D/g, "");
    const isCommandOwner = msg.key.fromMe || (ownerNumberForCommand && normalizeJidNumber(senderJidForCommand) === ownerNumberForCommand);

    const sourceCommands = ["stupidcheck","uncleancheck","hotcheck","smartcheck","greatcheckcase","evilcheck","dogcheck","coolcheck","gaycheck","waifucheck","gali","roast","ship","hack","couple","flirt","compliment","tareef","respect","goodword","insult","8ball","coinflip","flip","dice","roll","rps","slot","guess","tictactoe","ttt","surrender","giveup","wcg","wordchain","laugh","shy","sad","moon","anger","happy","confused","heart","cool","fire","star","thumbsup","readmore","textreadmore","calc","calculate","tovn","read","sticker","take","steal","wm","swm","takefull","toimg","bass","blown","deep","earrape","fast","fat","nightcore","reverse","robot","slow","smooth","squirrel"];
    if (sourceCommands.includes(command)) {
      const sourceResult = await handleSourceCommand(command, args, { msg, sock, quotedContact, runtimeConfig });
      if (sourceResult?.mediaCommand) {
        const mediaResult = await handleMediaCommand(sourceResult.mediaCommand, { msg, sock, quotedContact, args });
        if (!mediaResult?.done) { reply = mediaResult?.text || "❌ Processing failed 🌸"; } else { reply = ""; }
      } else if (sourceResult?.action === "read") {
        try { await sock.readMessages([msg.key]); reply = `👀 **𝐑ᴇᴀᴅ** — 👤 ${String(msg.key.participant || msg.key.remoteJid || "").split("@")[0]}\n✅ **𝐌ᴀʀᴋᴇᴅ ᴀs ʀᴇᴀᴅ** 🌸`; } catch { reply = `👀 **𝐑ᴇᴀᴅ** — 👤 ${String(msg.key.participant || msg.key.remoteJid || "").split("@")[0]}\n❌ **𝐅ᴀɪʟᴇᴅ** 🌸`; }
      } else if (sourceResult) { reply = sourceResult.text || ""; replyMentions = Array.isArray(sourceResult.mentions) ? sourceResult.mentions : []; }
    } else if (["ship","love","truth","dare","8ball","joke","meme","quiz","dice","rps","guess"].includes(command)) {
      reply = await handleFunCommand(command, args, { msg, sock, quotedContact, config: activeConfig });
    } else if (command === "public") {
      if (!isCommandOwner) {
        reply = "👑 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 💗";
      } else if (runtimeConfig.mode === "public") {
        reply = "🌐 𝐁ᴏᴛ 𝐈s 𝐀ʟʀᴇᴀᴅʏ 𝐈ɴ 𝐏ᴜʙʟɪᴄ 𝐌ᴏᴅᴇ 💗";
      } else {
        runtimeConfig.mode = "public";
        settingsStore.update(botJid, s => ({ ...s, botMode: "public" }));
        reply = "🌐 𝐏ᴜʙʟɪᴄ 𝐌ᴏᴅᴇ 𝐄ɴᴀʙʟᴇᴅ 💗\n➤ 𝐁ᴏᴛ 𝐈s 𝐍ᴏᴡ 𝐏ᴜʙʟɪᴄ";
      }
    } else if (command === "private") {
      if (!isCommandOwner) {
        reply = "👑 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 💗";
      } else if (runtimeConfig.mode === "private") {
        reply = "🔒 𝐁ᴏᴛ 𝐈s 𝐀ʟʀᴇᴀᴅʏ 𝐈ɴ 𝐏ʀɪᴠᴀᴛᴇ 𝐌ᴏᴅᴇ 💗";
      } else {
        runtimeConfig.mode = "private";
        settingsStore.update(botJid, s => ({ ...s, botMode: "private" }));
        reply = "🔒 𝐏ʀɪᴠᴀᴛᴇ 𝐌ᴏᴅᴇ 𝐄ɴᴀʙʟᴇᴅ 💗\n➤ 𝐁ᴏᴛ 𝐈s 𝐍ᴏᴡ 𝐏ʀɪᴠᴀᴛᴇ";
      }
    } else if (command === "setprefix") {
      const senderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
      const ownerNumber = String(runtimeConfig.ownerNumber || "").replace(/\D/g, "");
      const senderNumber = normalizeJidNumber(senderJid);
      const isOwner = msg.key.fromMe || (ownerNumber && senderNumber === ownerNumber);

      if (!isOwner) {
        reply = "👑 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 💗";
      } else if (!args[0]) {
        reply = `⚠️ 𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐍ᴇᴡ 𝐏ʀᴇғɪx ➤ 𝐄xᴀᴍᴘʟᴇ : ${runtimeConfig.prefix}setprefix !`;
      } else if (args[0].length > 3) {
        reply = "⚠️ 𝐏ʀᴇғɪx 𝐌ᴜsᴛ 𝐁ᴇ 𝟏–𝟑 𝐂ʜᴀʀᴀᴄᴛᴇʀs";
      } else {
        runtimeConfig.prefix = args[0];
        settingsStore.update(botJid, s => ({ ...s, prefix: runtimeConfig.prefix }));
        reply = `👑 𝐏ʀᴇғɪx 𝐔ᴘᴅᴀᴛᴇᴅ 💗 ➤ 𝐍ᴇᴡ 𝐏ʀᴇғɪx : ${runtimeConfig.prefix}`;
      }
    } else if (command === "warn") {
      const jid = msg.key.remoteJid;
      if (!jid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(jid);
        const senderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || normalizeJidNumber(senderJid) === ownerNumber;
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const contextInfo =
            msg.message?.extendedTextMessage?.contextInfo ||
            msg.message?.imageMessage?.contextInfo ||
            msg.message?.videoMessage?.contextInfo ||
            msg.message?.documentMessage?.contextInfo ||
            msg.message?.buttonsResponseMessage?.contextInfo ||
            msg.message?.listResponseMessage?.contextInfo ||
            {};
          const quotedParticipant = contextInfo.participant || "";

          if (!quotedParticipant) {
            reply = "🌷 *𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐀ɴᴅ 𝐓ʏᴘᴇ .warn 💗*";
          } else {
            const target = findGroupParticipant(metadata.participants, quotedParticipant);
            if (!target) {
              reply = "🌷 *𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐀ɴᴅ 𝐓ʏᴘᴇ .warn 💗*";
            } else {
              const targetJid = target.id || quotedParticipant;
              const warnKey = `${jid}:${targetJid}`;
              const count = (warnCounts.get(warnKey) || 0) + 1;

              if (count >= 3) {
                const bot = findBotParticipant(metadata.participants);
                const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
                if (!botIsAdmin) {
                  warnCounts.set(warnKey, 2);
                  reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
                } else {
                  try {
                    await sock.groupParticipantsUpdate(jid, [targetJid], "remove");
                    warnCounts.delete(warnKey);
                    reply = `🥀 @${normalizeJidNumber(targetJid)} 𝐊ɪᴄᴋᴇᴅ — 𝟑 𝐖ᴀʀɴs 𝐂ᴏᴍᴘʟᴇᴛᴇ! 🥺💗`;
                    await sock.sendMessage(jid, { text: reply, mentions: [targetJid] }, { quoted: quotedContact });
                    return;
                  } catch (kickError) {
                    warnCounts.set(warnKey, 2);
                    reply = "🥀 *𝐊ɪᴄᴋ ғᴀɪʟᴇᴅ — 𝐓ʜᴇ 𝐌ᴇᴍʙᴇʀ 𝐌ᴀʏ 𝐁ᴇ 𝐀ᴅᴍɪɴ! 🥺💗*";
                  }
                }
              } else {
                warnCounts.set(warnKey, count);
                if (count === 1) {
                  reply = `⚠️ @${normalizeJidNumber(targetJid)} 𝐖ᴀʀɴ 𝟏 — 𝐏ʟᴇᴀsᴇ 𝐁ᴇ 𝐂ᴀʀᴇғᴜʟ! 🥺💗`;
                } else {
                  reply = `⚠️ @${normalizeJidNumber(targetJid)} 𝐖ᴀʀɴ 𝟐 — 𝐍ᴇxᴛ 𝐖ᴀʀɴ = 𝐊ɪᴄᴋ! 🥀💗`;
                }
              }
            }
          }
        }
      }
    } else if (command === "delete") {
      const jid = msg.key.remoteJid;
      if (!jid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(jid);
        const senderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || normalizeJidNumber(senderJid) === ownerNumber;
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const contextInfo =
            msg.message?.extendedTextMessage?.contextInfo ||
            msg.message?.imageMessage?.contextInfo ||
            msg.message?.videoMessage?.contextInfo ||
            msg.message?.documentMessage?.contextInfo ||
            msg.message?.buttonsResponseMessage?.contextInfo ||
            msg.message?.listResponseMessage?.contextInfo ||
            {};
          const quotedMessage = contextInfo.quotedMessage;
          const stanzaId = contextInfo.stanzaId;
          const quotedParticipant = contextInfo.participant || "";

          if (!quotedMessage || !stanzaId) {
            reply = "🌷 *𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐀ɴᴅ 𝐓ʏᴘᴇ .delete 💗*";
          } else {
            const bot = findBotParticipant(metadata.participants);
            const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
            if (!botIsAdmin) {
              reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
            } else {
              try {
                const deleteKey = {
                  remoteJid: jid,
                  fromMe: !!contextInfo.fromMe,
                  id: stanzaId
                };
                if (!contextInfo.fromMe && quotedParticipant) deleteKey.participant = quotedParticipant;
                await sock.sendMessage(jid, { delete: deleteKey });
                reply = "🗑️ *𝐌ᴇssᴀɢᴇ 𝐃ᴇʟᴇᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ! 🌷💗*";
              } catch (deleteError) {
                console.log(`    ⚠️ Delete command failed: ${deleteError?.message || deleteError}`);
                reply = "🥀 *𝐌ᴇssᴀɢᴇ 𝐃ᴇʟᴇᴛᴇ ғᴀɪʟᴇᴅ! 🥺💗*";
              }
            }
          }
        }
      }
    } else if (command === "ping") {
      const start = process.hrtime.bigint();
      await Promise.resolve();
      const speed = Number(process.hrtime.bigint() - start) / 1e6;
      reply = `*👀 Ꭾ❤️‍🩹ŇᎶ: ${speed.toFixed(0)} ๓Ş*`;
    } else if (command === "alive") {
      reply = `*╰┈➤ ❤️‍🩹ŁᏆᐯᎬ: 𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃 ⚡*\n*╰┈➤  𝐒ᴛᴀᴛᴜ𝐬: 𝐎ɴʟɪɴᴇ ⚡*`;
    } else if (command === "uptime") {
      const totalMinutes = Math.floor(process.uptime() / 60);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      reply = `*╰┈➤𝐔ᴘᴛɪᴍᴇ: ${days} 𝐃ʏ ${hours} 𝐇ʀ ${minutes} 𝐌ɴ*`;
    } else if (command === "jid") {
  try {
    const jidInput = args.join(" ").trim();

    if (!jidInput) {
      reply = `🔗 𝐉ɪᴅ: ${msg.key.remoteJid || "Unknown"}`;
    } else {
      const waGroupMatch = jidInput.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
      if (!waGroupMatch) {
        reply = "⚠️ 𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐕ᴀʟɪᴅ 𝐖ʜᴀᴛs𝐀ᴘᴘ 𝐆ʀᴏᴜᴘ 𝐋ɪɴᴋ";
      } else {
        const inviteCode = waGroupMatch[1];
        const info = await sock.groupGetInviteInfo(inviteCode);
        const groupJid = info?.id || info?.jid;

        reply = groupJid
          ? `🔗 𝐉ɪᴅ 💗\n➤ ${groupJid}`
          : "❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐆ᴇᴛ 𝐉ɪᴅ";
      }
    }
  } catch (jidError) {
    console.log(`    ⚠️ jid failed: ${jidError?.message || jidError}`);
    reply = "❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐆ᴇᴛ 𝐉ɪᴅ";
  }
} else if (command === "groupid") {
      reply = msg.key.remoteJid?.endsWith("@g.us")
        ? `*╰┈➤🎀𝐆ʀᴏᴜᴘ 𝐈ᴅ: ${msg.key.remoteJid}*`
        : `*╰┈➤🎀𝐆ʀᴏᴜᴘ 𝐈ᴅ: Group only*`;
    } else if (command === "userinfo") {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const targetJid = ctx.participant || msg.key.participant || msg.key.remoteJid || "";
      if (!targetJid) {
        reply = "⚠️ 𝐏ʟᴇᴀsᴇ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐔sᴇʀ'𝐬 𝐌ᴇssᴀɢᴇ";
      } else {
        const number = String(targetJid).split(":")[0].split("@")[0].replace(/\D/g, "") || "Unknown";
        const name = msg.pushName || "Unknown";
        reply = `👤 𝐔sᴇʀ 𝐈ɴғᴏ\n\n📛 𝐍ᴀᴍᴇ : ${name}\n🆔 𝐉ɪᴅ : ${targetJid}\n🌐 𝐍ᴜᴍʙᴇʀ : ${number}`;
      }
    } else if (command === "getbio") {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const targetJid = ctx.participant || msg.key.participant || msg.key.remoteJid || "";
      if (!targetJid) {
        reply = "⚠️ 𝐏ʟᴇᴀsᴇ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐔sᴇʀ";
      } else {
        try {
          const statusInfo = await sock.fetchStatus(targetJid);
          const bio = typeof statusInfo === "string" ? statusInfo : statusInfo?.status;
          reply = bio
            ? `📝 𝐔sᴇʀ 𝐁ɪᴏ 💗\n➤ ${bio}`
            : "📝 𝐔sᴇʀ 𝐁ɪᴏ 💗\n➤ 𝐍ᴏ 𝐁ɪᴏ 𝐅ᴏᴜɴᴅ";
        } catch (bioError) {
          console.log(`    ⚠️ getbio failed: ${bioError?.message || bioError}`);
          reply = "❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐆ᴇᴛ 𝐁ɪᴏ";
        }
      }
    } else if (command === "getpp") {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const targetJid = ctx.participant || msg.key.participant || msg.key.remoteJid || "";
      if (!targetJid) {
        reply = "⚠️ 𝐏ʟᴇᴀsᴇ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐔sᴇʀ";
      } else {
        try {
          const ppUrl = await sock.profilePictureUrl(targetJid, "image");
          if (!ppUrl) {
            reply = "❌ 𝐍ᴏ 𝐏ʀᴏғɪʟᴇ 𝐏ɪᴄᴛᴜʀᴇ 𝐅ᴏᴜɴᴅ";
          } else {
            await sock.sendMessage(
              msg.key.remoteJid,
              { image: { url: ppUrl }, caption: "🖼️ 𝐏ʀᴏғɪʟᴇ 𝐏ɪᴄᴛᴜʀᴇ 💗" },
              { quoted: quotedContact }
            );
            return;
          }
        } catch (ppError) {
          console.log(`    ⚠️ getpp failed: ${ppError?.message || ppError}`);
          reply = "❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐆ᴇᴛ 𝐏ʀᴏғɪʟᴇ 𝐏ɪᴄ";
        }
      }
    } else if (command === "welcome") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        await sock.sendMessage(msg.key.remoteJid, { text: "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀκѕ ιɴ gʀσυρѕ!*" }, { quoted: quotedContact });
        return;
      }
      const jid = msg.key.remoteJid;
      const metadata = await sock.groupMetadata(jid);
      const senderJid = msg.key.participant || msg.participant || "";
      const sender = findGroupParticipant(metadata.participants, senderJid);
      const senderIsOwner = msg.key.fromMe || String(sender?.id || "").split(":")[0].replace(/\D/g, "") === String(runtimeConfig.ownerNumber).replace(/\D/g, "");
      if (!senderIsOwner) {
        await sock.sendMessage(jid, { text: "👑 *Only owner can use this command.*" }, { quoted: quotedContact });
        return;
      }
      const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg === "off") {
        welcomeGroups.delete(jid);
        settingsStore.setGroup(settingsKey, "welcome", jid, false);
        await sock.sendMessage(jid, { text: "🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐎ғғ! 💗*" }, { quoted: quotedContact });
        return;
      }
      if (arg === "on") {
        welcomeGroups.add(jid);
        settingsStore.setGroup(settingsKey, "welcome", jid, true);
        await sock.sendMessage(jid, { text: "🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐎ɴ! 💗*" }, { quoted: quotedContact });
        return;
      }
      const welcomeStatus = settingsStore.get(settingsKey)?.groups?.[jid]?.welcome === true ? "ON 💗" : "OFF 🥀";
      await sock.sendMessage(jid, { text: `🌷 *𝐖ᴇʟᴄᴏᴍᴇ 𝐒ʏsᴛᴇᴍ*\n\n• .welcome on\n• .welcome off\n\n💗 𝐒ᴛᴀᴛᴜs: ${welcomeStatus}\n🌸 𝐃ᴇғᴀᴜʟᴛ: OFF` }, { quoted: quotedContact });
      return;
    } else if (command === "goodbye") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        await sock.sendMessage(msg.key.remoteJid, { text: "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀκѕ ιɴ gʀσυρѕ!*" }, { quoted: quotedContact });
        return;
      }
      const jid = msg.key.remoteJid;
      const metadata = await sock.groupMetadata(jid);
      const senderJid = msg.key.participant || msg.participant || "";
      const sender = findGroupParticipant(metadata.participants, senderJid);
      const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
      const isOwner = msg.key.fromMe || normalizeJidNumber(senderJid) === ownerNumber;
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "👑 *Only owner can use this command.*" }, { quoted: quotedContact });
        return;
      }
      const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg === "off") {
        goodbyeGroups.delete(jid);
        settingsStore.setGroup(settingsKey, "goodbye", jid, false);
        await sock.sendMessage(jid, { text: "🥀 *𝐆ᴏᴏᴅʙʏᴇ 𝐎ғғ! 💗*" }, { quoted: quotedContact });
        return;
      }
      if (arg === "on") {
        goodbyeGroups.add(jid);
        settingsStore.setGroup(settingsKey, "goodbye", jid, true);
        await sock.sendMessage(jid, { text: "🌷 *𝐆ᴏᴏᴅʙʏᴇ 𝐎ɴ! 💗*" }, { quoted: quotedContact });
        return;
      }
      const goodbyeStatus = settingsStore.get(settingsKey)?.groups?.[jid]?.goodbye === true ? "ON 💗" : "OFF 🥀";
      await sock.sendMessage(jid, { text: `🥀 *𝐆ᴏᴏᴅʙʏᴇ 𝐒ʏsᴛᴇᴍ*\n\n• .goodbye on\n• .goodbye off\n\n💗 𝐒ᴛᴀᴛᴜs: ${goodbyeStatus}\n🌸 𝐃ᴇғᴀᴜʟᴛ: OFF` }, { quoted: quotedContact });
      return;
    } else if (command === "tagall") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const mentions = metadata.participants.map(p => p.id);
          reply = `*╰┈➤🎀 𝐓ᴀɢ 𝐀ʟʟ*\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n\n${mentions.map(jid => `@${jid.split("@")[0].split(":")[0]}`).join("\n")}\n\n*╰┈➤💜 𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          } catch (e) {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          }
          return;
        }
      }
    } else if (command === "tagadmins") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
          const mentions = admins.map(p => p.id);
          if (!mentions.length) {
            reply = "*𝐍ᴏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐅ᴏᴜɴᴅ!👑💜*";
          } else {
            reply = `*𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐓ᴀɢɢᴇᴅ!👑💜*\n\n${mentions.map(jid => `👑 @${jid.split("@")[0].split(":")[0]}`).join("\n")}\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
            try { await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact }); }
            catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact }); }
            return;
          }
        }
      }
    } else if (command === "totag") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          const quotedParticipant = contextInfo?.participant || contextInfo?.quotedMessage?.extendedTextMessage?.contextInfo?.participant;
          if (!quotedParticipant) {
            reply = "*𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇᴍʙᴇʀ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👤🌷*";
          } else {
            const target = findGroupParticipant(metadata.participants, quotedParticipant);
            const targetJid = target?.id || quotedParticipant;
            const mentionNumber = targetJid.split("@")[0].split(":")[0];
            const mentions = [targetJid];
            reply = `*𝐌ᴇᴍʙᴇʀ 𝐓ᴀɢɢᴇᴅ!👤💜*\n\n👤 @${mentionNumber}\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
            try { await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact }); }
            catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact }); }
            return;
          }
        }
      }
    } else if (command === "everyone") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const mentions = metadata.participants.map(p => p.id);
          reply = `*𝐄ᴠᴇʀʏᴏɴᴇ 𝐓ᴀɢɢᴇᴅ!📢💜*\n\n${mentions.map(jid => `👤 @${jid.split("@")[0].split(":")[0]}`).join("\n")}\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          } catch (e) {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          }
          return;
        }
      }
    } else if (command === "admins") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
          const mentions = admins.map(p => p.id);
          reply = `*╰┈➤👑 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs*\n\n${mentions.map(jid => `@${jid.split("@")[0].split(":")[0]}`).join("\n")}\n\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*╰┈➤💜 𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          } catch (e) {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          }
          return;
        }
      }
    } else if (command === "kickall") {
      const jid = msg.key.remoteJid;
      if (!jid?.endsWith("@g.us")) {
        reply = "🥺💗 ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴏɴʟʏ ᴡᴏʀᴋs ɪɴ ɢʀᴏᴜᴘs 🌸 |";
      } else {
        const senderJid = msg.key.participant || msg.participant || msg.key.senderPn || msg.key.senderLid || "";
        const ownerNumber = String(runtimeConfig.ownerNumber || "").replace(/\D/g, "");
        const senderNumber = normalizeJidNumber(senderJid);
        const isOwner = Boolean(msg.key.fromMe) || (ownerNumber && senderNumber === ownerNumber);
        if (!isOwner) {
          reply = "🚫💗 ᴏɴʟʏ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ 🌸 |";
        } else {
          try {
            const metadata = await sock.groupMetadata(jid);
            const bot = findBotParticipant(metadata.participants || []);
            const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
            if (!botIsAdmin) {
              reply = "🥺💔 ʙᴏᴛ ᴍᴜsᴛ ʙᴇ ᴀɴ ᴀᴅᴍɪɴ ᴛᴏ ᴜsᴇ ᴋɪᴄᴋᴀʟʟ 🌸 |";
            } else {
              const targets = (metadata.participants || [])
                .filter((p) => {
                  const isAdmin = p.admin === "admin" || p.admin === "superadmin";
                  const pId = String(p.id || "");
                  const pLid = String(p.lid || "");
                  const botId = String(bot?.id || "");
                  const botLid = String(bot?.lid || "");
                  const isBot = Boolean(bot) && (
                    (botId && (pId === botId || normalizeJidNumber(pId) === normalizeJidNumber(botId))) ||
                    (botLid && (pLid === botLid || normalizeJidNumber(pLid) === normalizeJidNumber(botLid)))
                  );
                  return !isAdmin && !isBot && p.id;
                })
                .map((p) => p.id);
              if (!targets.length) {
                reply = "┏❐ 《 💗 𝐊𝐈𝐂𝐊𝐀𝐋𝐋 》 ❐\n┣◆ 🌸 𝐍ᴏ ɴᴏɴ-ᴀᴅᴍɪɴ ᴍᴇᴍʙᴇʀ ғᴏᴜɴᴅ\n┗❐";
              } else {
                await sock.groupParticipantsUpdate(jid, targets, "remove");
                reply = `┏❐ 《 💥 𝐊𝐈𝐂𝐊𝐀𝐋𝐋 》 ❐\n┣◆ 🦋 𝐑ᴇᴍᴏᴠᴇᴅ : ${targets.length} ᴍᴇᴍʙᴇʀ${targets.length === 1 ? "" : "s"}\n┣◆ ⚡ 𝐒ᴛᴀᴛᴜs : 𝐒ᴜᴄᴄᴇss\n┗❐`;
              }
            }
          } catch (kickAllError) {
            console.log(`    ⚠️ Kickall failed: ${kickAllError?.message || kickAllError}`);
            reply = "🥀💔 ᴋɪᴄᴋᴀʟʟ ғᴀɪʟᴇᴅ 🌸 |";
          }
        }
      }
    } else if (command === "kick") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || "";
            const targetJid = mentioned[0] || quotedParticipant || "";
            const targetNumber = targetJid.split("@")[0].split(":")[0].replace(/\D/g, "");
            const target = metadata.participants.find(p =>
              p.id === targetJid ||
              p.id?.split("@")[0].split(":")[0].replace(/\D/g, "") === targetNumber
            );

            if (!targetJid || !target) {
              reply = "*╰┈➤🥀 𝐑ᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇᴍʙᴇʀ ᴏʀ ᴛᴀɢ ᴛʜᴇᴍ ᴛᴏ ᴋɪᴄᴋ!*";
            } else {
              const targetIsAdmin = target.admin === "admin" || target.admin === "superadmin";
              const targetIsBot = !!bot && (target.id === bot.id || target.lid === bot.id || target.id === bot.lid || normalizeJidNumber(target.id) === normalizeJidNumber(bot.id) || normalizeJidNumber(target.lid) === normalizeJidNumber(bot.id));
              const targetIsOwner = target.id?.split("@")[0].split(":")[0].replace(/\D/g, "") === ownerNumber;

              if (targetIsBot) {
                reply = "*╰┈➤🥀 𝐈 ᴄᴀɴ'ᴛ ᴋɪᴄᴋ ᴍʏsᴇʟғ!*";
              } else if (targetIsOwner || targetIsAdmin) {
                reply = "*╰┈➤🥀 𝐀ᴅᴍɪɴ/𝐎ᴡɴᴇʀ ᴄᴀɴ'ᴛ ʙᴇ ᴋɪᴄᴋᴇᴅ!*";
              } else {
                try {
                  await sock.groupParticipantsUpdate(msg.key.remoteJid, [target.id], "remove");
                  reply = `*╰┈➤🥀 𝐊ɪᴄᴋᴇᴅ*\n*╰┈➤👤 @${target.id.split("@")[0].split(":")[0]}*\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n\n*╰┈➤💜 𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
                  try {
                    await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [target.id] }, { quoted: quotedContact });
                  } catch (e) {
                    await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [target.id] });
                  }
                  return;
                } catch (kickError) {
                  reply = `*╰┈➤🥀 𝐊ɪᴄᴋ ғᴀɪʟᴇᴅ: ${kickError?.message || "Unknown error"}*`;
                }
              }
            }
          }
        }
      }
    } else if (command === "add") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀκѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else if (!args[0]) {
            reply = `*╰┈➤📛 𝐔sᴀɢᴇ: ${runtimeConfig.prefix}add 917XXXXXXXXX*`;
          } else {
            const cleanNumber = String(args[0]).replace(/\D/g, "");
            if (!cleanNumber || cleanNumber.length < 7) {
              reply = "*╰┈➤📛 𝐈ɴᴠᴀʟɪᴅ 𝐍ᴜᴍʙᴇʀ!*";
            } else {
              const targetJid = `${cleanNumber}@s.whatsapp.net`;
              try {
                await sock.groupParticipantsUpdate(msg.key.remoteJid, [targetJid], "add");
                reply = `*╰┈➤🎀 𝐀ᴅᴅᴇᴅ: @${cleanNumber}*\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*`;
                try {
                  await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [targetJid] }, { quoted: quotedContact });
                } catch (e) {
                  await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [targetJid] });
                }
                return;
              } catch (addError) {
                reply = "*╰┈➤🥀 𝐀ᴅᴅ ғᴀɪʟᴇᴅ! 𝐏ʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ 𝐍ᴜᴍʙᴇʀ.*";
              }
            }
          }
        }
      }
    } else if (command === "unlock") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid =
          msg.key.participant ||
          msg.participant ||
          msg.key.senderPn ||
          msg.key.senderLid ||
          "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const botIds = [
          sock.user?.id,
          sock.user?.lid,
          sock.user?.jid
        ].filter(Boolean);
        const isBotAccount = botIds.some(id =>
          id === senderJid ||
          normalizeJidNumber(id) === senderNumber
        );
        const isOwner = Boolean(msg.key.fromMe) || senderNumber === ownerNumber || isBotAccount;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
          if (!botIsAdmin) {
            reply = "*вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!🏖️💜*";
          } else {
            try {
              await sock.groupSettingUpdate(msg.key.remoteJid, "unlocked");
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴇᴛᴛɪɴɢs 𝐔ɴʟᴏᴄᴋᴇᴅ!🔓💋❤️‍🩹*";
            } catch (e) {
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴇᴛᴛɪɴɢs 𝐔ɴʟᴏᴄᴋ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "setgpp") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!🏖️💜*";
          } else {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            const quotedMessage = contextInfo?.quotedMessage;
            const imageMessage = quotedMessage?.imageMessage;

            if (!imageMessage) {
              reply = "*𝐑ᴇᴘʟʏ ᴛᴏ ᴀɴ 𝐈ᴍᴀɢᴇ 𝐓ᴏ 𝐒ᴇᴛ 𝐆ʀᴏᴜᴘ 𝐃𝐏!🖼️🌷*";
            } else {
              try {
                if (typeof downloadMediaMessage !== "function") {
                  throw new Error("This command needs downloadMediaMessage supplied by your target bot.");
                }
                const mediaMsg = {
                  key: {
                    remoteJid: msg.key.remoteJid,
                    id: contextInfo?.stanzaId || msg.key.id,
                    participant: contextInfo?.participant || senderJid
                  },
                  message: { imageMessage }
                };

                const buffer = await downloadMediaMessage(
                  mediaMsg,
                  "buffer",
                  {},
                  {
                    logger: logger || console,
                    reuploadRequest: sock.updateMediaMessage
                  }
                );

                await sock.updateProfilePicture(msg.key.remoteJid, buffer);
                reply = "*𝐆ʀᴏᴜᴘ 𝐃𝐏 𝐔ᴘᴅᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🖼️💜*";
              } catch (e) {
                console.error("setgpp error:", e?.message || e);
                reply = "*𝐆ʀᴏᴜᴘ 𝐃𝐏 𝐔ᴘᴅᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "groupdp") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else {
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            const imageMessage = contextInfo?.quotedMessage?.imageMessage;
            if (!imageMessage) {
              reply = "*𝐑ᴇᴘʟʏ ᴛᴏ ᴀɴ 𝐈ᴍᴀɢᴇ ᴛᴏ 𝐒ᴇᴛ 𝐆ʀᴏᴜᴘ 𝐃𝐏!🖼️🌷*";
            } else {
              try {
                if (typeof downloadMediaMessage !== "function") {
                  throw new Error("This command needs downloadMediaMessage supplied by your target bot.");
                }
                const mediaMsg = {
                  key: {
                    remoteJid: msg.key.remoteJid,
                    id: contextInfo?.stanzaId || msg.key.id,
                    participant: contextInfo?.participant || senderJid
                  },
                  message: { imageMessage }
                };
                const buffer = await downloadMediaMessage(
                  mediaMsg,
                  "buffer",
                  {},
                  {
                    logger: logger || console,
                    reuploadRequest: sock.updateMediaMessage
                  }
                );
                await sock.updateProfilePicture(msg.key.remoteJid, buffer);
                reply = "*𝐆ʀᴏᴜᴘ 𝐃𝐏 𝐔ᴘᴅᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🖼️💜*";
              } catch (e) {
                console.error("groupdp error:", e?.message || e);
                reply = "*𝐆ʀᴏᴜᴘ 𝐃𝐏 𝐔ᴘᴅᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "subject") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
          } else if (!args.length) {
            reply = "*𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐍ᴇᴡ 𝐆ʀᴏᴜᴘ 𝐍ᴀᴍᴇ!🌷💜*";
          } else {
            try {
              await sock.groupUpdateSubject(msg.key.remoteJid, args.join(" "));
              reply = "*𝐆ʀᴏᴜᴘ 𝐍ᴀᴍᴇ 𝐔ᴘᴅᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🌸💜*";
            } catch (e) {
              console.error("subject error:", e?.message || e);
              reply = "*𝐆ʀᴏᴜᴘ 𝐍ᴀᴍᴇ 𝐔ᴘᴅᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "desc") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
          } else if (!args.length) {
            reply = "*𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐍ᴇᴡ 𝐆ʀᴏᴜᴘ 𝐃ᴇsᴄʀɪᴘᴛɪᴏɴ!🌷💜*";
          } else {
            try {
              await sock.groupUpdateDescription(msg.key.remoteJid, args.join(" "));
              reply = "*𝐆ʀᴏᴜᴘ 𝐃ᴇsᴄʀɪᴘᴛɪᴏɴ 𝐔ᴘᴅᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!📝💜*";
            } catch (e) {
              console.error("desc error:", e?.message || e);
              reply = "*𝐆ʀᴏᴜᴘ 𝐃ᴇsᴄʀɪᴘᴛɪᴏɴ 𝐔ᴘᴅᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "groupinfo") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const admins = metadata.participants.filter(p => p.admin === "admin" || p.admin === "superadmin");
          const groupOwner = metadata.owner || metadata.subjectOwner || "Unknown";
          const ownerTag = groupOwner && groupOwner.includes("@") ? `@${groupOwner.split("@")[0].split(":")[0]}` : groupOwner;
          const mentions = groupOwner && groupOwner.includes("@") ? [groupOwner] : [];
          reply = `*╰┈➤👥 𝐆ʀᴏᴜᴘ 𝐈ɴғᴏ*\n\n*╰┈➤🌸 𝐍ᴀᴍᴇ:* ${metadata.subject || "Unknown"}\n*╰┈➤🆔 𝐈ᴅ:* ${msg.key.remoteJid}\n*╰┈➤👑 𝐎ᴡɴᴇʀ:* ${ownerTag}\n*╰┈➤👥 𝐌ᴇᴍʙᴇʀs:* ${metadata.participants.length}\n*╰┈➤🛡️ 𝐀ᴅᴍɪɴs:* ${admins.length}\n\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*╰┈➤💜 𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          } catch (e) {
            await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
          }
          return;
        }
      }
    } else if (command === "invite") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
          } else {
            try {
              const inviteCode = await sock.groupInviteCode(msg.key.remoteJid);
              const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
              reply = `*𝐆ʀᴏᴜᴘ 𝐈ɴᴠɪᴛᴇ 𝐋ɪɴᴋ 𝐆ᴇɴᴇʀᴀᴛᴇᴅ!🔗💜*\n\n${inviteLink}`;
            } catch (e) {
              console.error("invite error:", e?.message || e);
              reply = "*𝐆ʀᴏᴜᴘ 𝐈ɴᴠɪᴛᴇ 𝐋ɪɴᴋ 𝐆ᴇɴᴇʀᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "revoke") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
          } else {
            try {
              await sock.groupRevokeInvite(msg.key.remoteJid);
              reply = "*𝐆ʀᴏᴜᴘ 𝐈ɴᴠɪᴛᴇ 𝐋ɪɴᴋ 𝐑ᴇᴠᴏᴋᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!♻️💜*";
            } catch (revokeError) {
              console.error("revoke error:", revokeError?.message || revokeError);
              reply = "*𝐆ʀᴏᴜᴘ 𝐈ɴᴠɪᴛᴇ 𝐋ɪɴᴋ 𝐑ᴇᴠᴏᴋᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "requests") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          try {
            const requests = await sock.groupRequestParticipantsList(msg.key.remoteJid);
            if (!requests || !requests.length) {
              reply = "*𝐍ᴏ 𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛs 𝐅ᴏᴜɴᴅ!📩💜*";
            } else {
              const mentions = requests.map(r => r.jid || r.id).filter(Boolean);
              const list = mentions.map(jid => `👤 @${jid.split("@")[0].split(":")[0]}`).join("\n");
              reply = `*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛs 📩💜*\n\n${list}\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*`;
              try {
                await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
              } catch (e) {
                await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions }, { quoted: quotedContact });
              }
              return;
            }
          } catch (e) {
            console.error("requests error:", e?.message || e);
            reply = "*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛs 𝐅ᴀɪʟᴇᴅ!🥀❤️‍🩹*";
          }
        }
      }
    } else if (command === "approve") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const jid = msg.key.remoteJid;
        const metadata = await sock.groupMetadata(jid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const context = msg.message?.extendedTextMessage?.contextInfo || {};
          const mentioned = context.mentionedJid || [];
          let target = mentioned[0] || "";
          if (!target && context.participant) target = context.participant;
          if (!target) {
            reply = "*𝐏ʟᴇᴀsᴇ 𝐌ᴇɴᴛɪᴏɴ 𝐀 𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐌ᴇᴍʙᴇʀ 𝐓ᴏ 𝐀ᴘᴘʀᴏᴠᴇ!📩🌷*";
          } else {
            const targetJid = target.includes("@") ? target : `${target}@s.whatsapp.net`;
            const bot = findBotParticipant(metadata.participants);
            const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
            if (!botIsAdmin) {
              reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
            } else {
              try {
                await sock.groupRequestParticipantsUpdate(jid, [targetJid], "approve");
                reply = `*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐀ᴘᴘʀᴏᴠᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!✅💜*\n\n👤 @${targetJid.split("@")[0].split(":")[0]}`;
                try {
                  await sock.sendMessage(jid, { text: reply, mentions: [targetJid] }, { quoted: quotedContact });
                } catch (e) {
                  await sock.sendMessage(jid, { text: reply, mentions: [targetJid] });
                }
                return;
              } catch (e) {
                console.error("approve error:", e?.message || e);
                reply = "*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐀ᴘᴘʀᴏᴠᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "reject") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const jid = msg.key.remoteJid;
        const metadata = await sock.groupMetadata(jid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const context = msg.message?.extendedTextMessage?.contextInfo || {};
          const mentioned = context.mentionedJid || [];
          let target = mentioned[0] || "";
          if (!target && context.participant) target = context.participant;
          if (!target) {
            reply = "*𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐎ʀ 𝐌ᴇɴᴛɪᴏɴ 𝐀 𝐌ᴇᴍʙᴇʀ 𝐓ᴏ 𝐑ᴇᴊᴇᴄᴛ!📩🌷*";
          } else {
            const targetJid = target.includes("@") ? target : `${target}@s.whatsapp.net`;
            const bot = findBotParticipant(metadata.participants);
            const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
            if (!botIsAdmin) {
              reply = "*𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!🏖️💜*";
            } else {
              try {
                await sock.groupRequestParticipantsUpdate(jid, [targetJid], "reject");
                reply = `*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐑ᴇᴊᴇᴄᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!❌💜*\n\n👤 @${targetJid.split("@")[0].split(":")[0]}`;
                try {
                  await sock.sendMessage(jid, { text: reply, mentions: [targetJid] }, { quoted: quotedContact });
                } catch (e) {
                  await sock.sendMessage(jid, { text: reply, mentions: [targetJid] });
                }
                return;
              } catch (e) {
                console.error("reject error:", e?.message || e);
                reply = "*𝐉ᴏɪɴ 𝐑ᴇǫᴜᴇsᴛ 𝐑ᴇᴊᴇᴄᴛ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "poll") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "*𝐎ɴʟʏ 𝐆ʀᴏᴜᴘ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else if (!args.length) {
          reply = `*𝐔sᴀɢᴇ: ${runtimeConfig.prefix}poll 𝐐ᴜᴇsᴛɪᴏɴ | 𝐎ᴘᴛɪᴏɴ𝟏 | 𝐎ᴘᴛɪᴏɴ𝟐 | ...* 📊🌷`;
        } else {
          const pollText = text.slice(runtimeConfig.prefix.length).trim().slice(command.length).trim();
          const parts = pollText.split("|").map(p => p.trim()).filter(Boolean);
          const question = parts[0];
          const options = parts.slice(1);

          if (!question || options.length < 2) {
            reply = `*𝐔sᴀɢᴇ: ${runtimeConfig.prefix}poll 𝐐ᴜᴇsᴛɪᴏɴ | 𝐎ᴘᴛɪᴏɴ𝟏 | 𝐎ᴘᴛɪᴏɴ𝟐 | ...* 📊🌷`;
          } else if (options.length > 12) {
            reply = "*𝐌ᴀxɪᴍᴜᴍ 𝟏𝟐 𝐎ᴘᴛɪᴏɴs 𝐀ʟʟᴏᴡᴇᴅ!📊🌷*";
          } else {
            try {
              await sock.sendMessage(
                msg.key.remoteJid,
                { poll: { name: question, values: options, selectableCount: 1 } },
                { quoted: quotedContact }
              );
              reply = "*𝐏ᴏʟʟ 𝐂ʀᴇᴀᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!📊💜*\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*";
            } catch (e) {
              console.error("poll error:", e?.message || e);
              reply = "*𝐏ᴏʟʟ 𝐂ʀᴇᴀᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "lock") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;

        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!🏖️💜*";
          } else {
            try {
              await sock.groupSettingUpdate(msg.key.remoteJid, "locked");
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴇᴛᴛɪɴɢs 𝐋ᴏᴄᴋᴇᴅ!🔐💜*";
            } catch (lockError) {
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴇᴛᴛɪɴɢs 𝐋ᴏᴄᴋ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "close") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
          if (!botIsAdmin) {
            reply = "*вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!🏖️💜*";
          } else {
            try {
              await sock.groupSettingUpdate(msg.key.remoteJid, "announcement");
              reply = "*𝐆ʀᴏᴜᴘ 𝐂ʟᴏsᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🔒❤️‍🩹*";
            } catch (e) {
              reply = "*𝐆ʀᴏᴜᴘ 𝐂ʟᴏsᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "open") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;

        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "*вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!🏖️💜*";
          } else {
            try {
              await sock.groupSettingUpdate(msg.key.remoteJid, "not_announcement");
              reply = "*𝐆ʀᴏᴜᴘ 𝐎ᴘᴇɴᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🌸💜*";
            } catch (openError) {
              reply = "*𝐆ʀᴏᴜᴘ 𝐎ᴘᴇɴ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "demote") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;

        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || "";
            const targetJid = mentioned[0] || quotedParticipant || "";
            const targetNumber = targetJid.split("@")[0].split(":")[0].replace(/\D/g, "");
            const target = metadata.participants.find(p =>
              p.id === targetJid ||
              p.id?.split("@")[0].split(":")[0].replace(/\D/g, "") === targetNumber
            );

            if (!targetJid || !target) {
              reply = "*𝐏ʟᴇᴀsᴇ 𝐑ᴇᴘʟʏ 𝐎ʀ 𝐌ᴇɴᴛɪᴏɴ 𝐀 𝐌ᴇᴍʙᴇʀ!🥀💜*";
            } else if (!(target.admin === "admin" || target.admin === "superadmin")) {
              reply = "*𝐌ᴇᴍʙᴇʀ 𝐈s 𝐀ʟʀᴇᴀᴅʏ 𝐍ᴏᴛ 𝐀ᴅᴍɪɴ!🥀💜*";
            } else if (target.admin === "superadmin") {
              reply = "*𝐆ʀᴏᴜᴘ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ'ᴛ 𝐁ᴇ 𝐃ᴇᴍᴏᴛᴇᴅ!👑🥀*";
            } else {
              try {
                await sock.groupParticipantsUpdate(msg.key.remoteJid, [target.id], "demote");
                reply = `*𝐀ᴅᴍɪɴ 𝐃ᴇᴍᴏᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🥀❤️‍🩹*\n\n👤 @${targetNumber}`;
                try {
                  await sock.sendMessage(
                    msg.key.remoteJid,
                    { text: reply, mentions: [target.id] },
                    { quoted: quotedContact }
                  );
                } catch (e) {
                  await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [target.id] });
                }
                return;
              } catch (demoteError) {
                reply = "*𝐃ᴇᴍᴏᴛᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "promote") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;

        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");

          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || "";
            const targetJid = mentioned[0] || quotedParticipant || "";
            const targetNumber = targetJid.split("@")[0].split(":")[0].replace(/\D/g, "");
            const target = metadata.participants.find(p =>
              p.id === targetJid ||
              p.id?.split("@")[0].split(":")[0].replace(/\D/g, "") === targetNumber
            );

            if (!targetJid || !target) {
              reply = "*𝐑ᴇᴘʟʏ ᴛᴏ ᴀ 𝐌ᴇᴍʙᴇʀ ᴏʀ 𝐓ᴀɢ 𝐓ʜᴇᴍ ᴛᴏ 𝐏ʀᴏᴍᴏᴛᴇ!👑💜*";
            } else if (target.admin === "admin" || target.admin === "superadmin") {
              reply = "*𝐌ᴇᴍʙᴇʀ 𝐀ʟʀᴇᴀᴅʏ 𝐀ᴅᴍɪɴ!👑💜*";
            } else {
              try {
                await sock.groupParticipantsUpdate(msg.key.remoteJid, [target.id], "promote");
                reply = `*𝐌ᴇᴍʙᴇʀ 𝐏ʀᴏᴍᴏᴛᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!👑💜*\n\n👤 @${targetNumber}`;
                try {
                  await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [target.id] }, { quoted: quotedContact });
                } catch (e) {
                  await sock.sendMessage(msg.key.remoteJid, { text: reply, mentions: [target.id] });
                }
                return;
              } catch (promoteError) {
                reply = "*𝐏ʀᴏᴍᴏᴛᴇ 𝐅ᴀɪʟᴇᴅ!🥀❤️‍🩹*";
              }
            }
          }
        }
      }
    } else if (command === "antilink") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*👑 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ! 💗*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        if (!isOwner) {
          reply = "*👑 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ! 💗*";
        } else {
          const action = commandText.slice(command.length).trim().toLowerCase();
          if (!action) {
            reply = `*🌷 𝐔sᴀɢᴇ: ${runtimeConfig.prefix}antilink warn on / kick / delete / off 💗*`;
          } else if (action === "warn on") {
            antiLinkMode.set(msg.key.remoteJid, "warn");
            settingsStore.setGroup(settingsKey, "antilink", msg.key.remoteJid, "warn");
            reply = "*🔗 𝐀ɴᴛɪʟɪɴᴋ 𝐖ᴀʀɴ 𝐌ᴏᴅᴇ 𝐄ɴᴀʙʟᴇᴅ! ⚠️💗*";
          } else if (action === "kick") {
            antiLinkMode.set(msg.key.remoteJid, "kick");
            settingsStore.setGroup(settingsKey, "antilink", msg.key.remoteJid, "kick");
            reply = "*🔗 𝐀ɴᴛɪʟɪɴᴋ 𝐊ɪᴄᴋ 𝐌ᴏᴅᴇ 𝐄ɴᴀʙʟᴇᴅ! 🥀💗*";
          } else if (action === "delete") {
            antiLinkMode.set(msg.key.remoteJid, "delete");
            settingsStore.setGroup(settingsKey, "antilink", msg.key.remoteJid, "delete");
            reply = "*🔗 𝐀ɴᴛɪʟɪɴᴋ 𝐃ᴇʟᴇᴛᴇ 𝐌ᴏᴅᴇ 𝐄ɴᴀʙʟᴇᴅ! 🗑️💗*";
          } else if (action === "off") {
            antiLinkMode.delete(msg.key.remoteJid);
            settingsStore.setGroup(settingsKey, "antilink", msg.key.remoteJid, false);
            for (const key of antiLinkWarns.keys()) if (key.startsWith(`${msg.key.remoteJid}:`)) antiLinkWarns.delete(key);
            reply = "*🔗 𝐀ɴᴛɪʟɪɴᴋ 𝐃ɪsᴀʙʟᴇᴅ! 🌷💗*";
          } else {
            reply = `*🌷 𝐔sᴀɢᴇ: ${runtimeConfig.prefix}antilink warn on / kick / delete / off 💗*`;
          }
        }
      }
    } else if (command === "antisticker") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");

        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const bot = findBotParticipant(metadata.participants);
          const botIsAdmin = !!bot && (bot.admin === "admin" || bot.admin === "superadmin");
          if (!botIsAdmin) {
            reply = "🏖️ *вσт мυѕт вє α∂мιɴ тσ υѕє тнιѕ ᴄσммαɴ∂!*";
          } else {
            const action = commandText.slice(command.length).trim().toLowerCase();
            if (action === "on") {
              antiSticker.add(msg.key.remoteJid);
              settingsStore.setGroup(settingsKey, "antisticker", msg.key.remoteJid, true);
              reply = "*𝐀ɴᴛɪ 𝐒ᴛɪᴄᴋᴇʀ 𝐄ɴᴀʙʟᴇᴅ!🛡️💜*";
            } else if (action === "off") {
              antiSticker.delete(msg.key.remoteJid);
              settingsStore.setGroup(settingsKey, "antisticker", msg.key.remoteJid, false);
              reply = "*𝐀ɴᴛɪ 𝐒ᴛɪᴄᴋᴇʀ 𝐃ɪsᴀʙʟᴇᴅ!🛡️💜*";
            } else {
              reply = `*𝐔sᴀɢᴇ: ${runtimeConfig.prefix}antisticker on/off 🌷💜*`;
            }
          }
        }
      }
    } else if (command === "antigm") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          const action = commandText.slice(command.length).trim().toLowerCase();
          if (action === "on") {
            antiGroupStatus.add(msg.key.remoteJid);
            settingsStore.setGroup(settingsKey, "antigm", msg.key.remoteJid, true);
            reply = "*𝐀ɴᴛɪ 𝐆ʀᴏᴜᴘ 𝐌ᴇssᴀɢᴇ 𝐄ɴᴀʙʟᴇᴅ!🛡️💜*";
          } else if (action === "off") {
            antiGroupStatus.delete(msg.key.remoteJid);
            settingsStore.setGroup(settingsKey, "antigm", msg.key.remoteJid, false);
            reply = "*𝐀ɴᴛɪ 𝐆ʀᴏᴜᴘ 𝐌ᴇssᴀɢᴇ 𝐃ɪsᴀʙʟᴇᴅ!🛡️💜*";
          } else {
            reply = `*𝐔sᴀɢᴇ: ${runtimeConfig.prefix}antigm on/off 🌷💜*`;
          }
        }
      }
    } else if (command === "vv") {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const quotedMessage = ctx.quotedMessage || null;

      if (!quotedMessage) {
        reply = `🥺💗 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴍᴇᴅɪᴀ 🌸 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻`;
      } else {
        try {
          let inner = quotedMessage;

          const wrapper =
            inner.viewOnceMessageV2 ||
            inner.viewOnceMessageV2Extension ||
            inner.viewOnceMessage;

          if (wrapper?.message) inner = wrapper.message;
          if (inner.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
          if (inner.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;

          let mediaType = null;
          let mediaMsg = null;

          if (inner.imageMessage) {
            mediaType = "image";
            mediaMsg = inner.imageMessage;
          } else if (inner.videoMessage) {
            mediaType = "video";
            mediaMsg = inner.videoMessage;
          } else if (inner.audioMessage) {
            mediaType = "audio";
            mediaMsg = inner.audioMessage;
          }

          if (!mediaMsg) {
            reply = `😔💔 ᴜɴsᴜᴘᴘᴏʀᴛᴇᴅ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴍᴇᴅɪᴀ 🌹 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ`;
          } else {
            await sock.sendMessage(msg.key.remoteJid, { react: { text: "⏳", key: msg.key } });

            const stream = await downloadContentFromMessage(mediaMsg, mediaType);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            const caption = mediaMsg.caption || "";

            if (mediaType === "image") {
              await sock.sendMessage(
                msg.key.remoteJid,
                { image: buffer, caption: caption || "📸💞 ᴠɪᴇᴡ ᴏɴᴄᴇ ɪᴍᴀɢᴇ ✓ 🌷 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻" },
                { quoted: quotedContact }
              );
            } else if (mediaType === "video") {
              await sock.sendMessage(
                msg.key.remoteJid,
                { video: buffer, caption: caption || "🎥💕 ᴠɪᴇᴡ ᴏɴᴄᴇ ᴠɪᴅᴇᴏ ✓ 🦋 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻", mimetype: mediaMsg.mimetype || "video/mp4" },
                { quoted: quotedContact }
              );
            } else {
              await sock.sendMessage(
                msg.key.remoteJid,
                { audio: buffer, mimetype: mediaMsg.mimetype || "audio/ogg; codecs=opus", ptt: !!mediaMsg.ptt },
                { quoted: quotedContact }
              );
            }

            await sock.sendMessage(msg.key.remoteJid, { react: { text: "💗", key: msg.key } });
            reply = mediaType === "image"
              ? `📸💗 ᴠɪᴇᴡ ᴏɴᴄᴇ ɪᴍᴀɢᴇ ✓ 🌸 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻`
              : mediaType === "video"
                ? `🎥💕 ᴠɪᴇᴡ ᴏɴᴄᴇ ᴠɪᴅᴇᴏ ✓ 🦋 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 💞`
                : `🎵💗 ᴠɪᴇᴡ ᴏɴᴄᴇ ᴀᴜᴅɪᴏ ✓ 🌷 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 💞`;
          }
        } catch (vvError) {
          console.log(`    ⚠️ VV command failed: ${vvError?.message || vvError}`);
          await sock.sendMessage(msg.key.remoteJid, { react: { text: "❌", key: msg.key } });
          reply = `🥺💔 ᴠɪᴇᴡ ᴏɴᴄᴇ ғᴀɪʟᴇᴅ 🌷 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ`;
        }
      }
    } else if (command === "url") {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const quotedMessage = ctx.quotedMessage || null;
      let mediaSource = quotedMessage;
      if (mediaSource?.ephemeralMessage?.message) mediaSource = mediaSource.ephemeralMessage.message;
      if (mediaSource?.viewOnceMessageV2?.message) mediaSource = mediaSource.viewOnceMessageV2.message;
      if (mediaSource?.viewOnceMessage?.message) mediaSource = mediaSource.viewOnceMessage.message;
      if (mediaSource?.viewOnceMessageV2Extension?.message) mediaSource = mediaSource.viewOnceMessageV2Extension.message;
      if (mediaSource?.documentWithCaptionMessage?.message) mediaSource = mediaSource.documentWithCaptionMessage.message;
      const mediaKey = mediaSource
        ? ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"].find(k => mediaSource[k])
        : null;

      if (!quotedMessage || !mediaKey) {
        reply = `🥺💗 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇᴅɪᴀ ᴡɪᴛʜ ${runtimeConfig.prefix}url 🌸 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻`;
      } else {
        try {
          await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⏳💞 ᴜᴘʟᴏᴀᴅɪɴɢ ᴍᴇᴅɪᴀ... 🦋 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 💗` },
            { quoted: quotedContact }
          );

          // Download the quoted media directly from its media node.
          let inner = quotedMessage;
          if (inner.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
          if (inner.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
          if (inner.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
          if (inner.viewOnceMessageV2Extension?.message) inner = inner.viewOnceMessageV2Extension.message;
          if (inner.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;

          const mediaNode = inner[mediaKey] || {};
          if (!mediaNode?.mediaKey) throw new Error("Quoted media data is unavailable");

          let mediaType = mediaKey.replace("Message", "");
          if (mediaType === "sticker") mediaType = "sticker";

          const stream = await downloadContentFromMessage(mediaNode, mediaType);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);
          if (!buffer.length) throw new Error("Empty media buffer");

          const mime = mediaNode.mimetype || "application/octet-stream";
          const ext = (mime.split("/")[1] || "bin").split(";")[0].replace(/[^a-z0-9]/gi, "") || "bin";
          const filename = `x-nobita.${ext}`;

          // Try several public uploaders. A failure on one service must not stop
          // the command before the remaining fallbacks are attempted.
          const uploaders = [
            {
              name: "Catbox",
              url: "https://catbox.moe/user/api.php",
              makeForm: () => {
                const form = new FormData();
                form.append("reqtype", "fileupload");
                form.append("fileToUpload", new Blob([buffer], { type: mime }), filename);
                return form;
              },
              parse: async (response) => {
                const text = (await response.text()).trim();
                return /^https?:\/\//i.test(text) ? text : "";
              }
            },
            {
              name: "Tmpfiles",
              url: "https://tmpfiles.org/api/v1/upload",
              makeForm: () => {
                const form = new FormData();
                form.append("file", new Blob([buffer], { type: mime }), filename);
                return form;
              },
              parse: async (response) => {
                const data = await response.json().catch(() => null);
                const u = data?.data?.url || "";
                return u ? u.replace("tmpfiles.org/", "tmpfiles.org/dl/") : "";
              }
            },
            {
              name: "Uguu",
              url: "https://uguu.se/upload.php",
              makeForm: () => {
                const form = new FormData();
                form.append("files[]", new Blob([buffer], { type: mime }), filename);
                return form;
              },
              parse: async (response) => {
                const data = await response.json().catch(() => null);
                return data?.files?.[0]?.url || "";
              }
            },
            {
              name: "0x0",
              url: "https://0x0.st",
              makeForm: () => {
                const form = new FormData();
                form.append("file", new Blob([buffer], { type: mime }), filename);
                return form;
              },
              parse: async (response) => {
                const text = (await response.text()).trim();
                return /^https?:\/\//i.test(text) ? text : "";
              }
            }
          ];

          let generatedUrl = "";
          let lastUploadError = "";

          for (const uploader of uploaders) {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 30000);
              try {
                const upload = await fetch(uploader.url, {
                  method: "POST",
                  body: uploader.makeForm(),
                  headers: { "User-Agent": "X-NOBITA-XD/1.0" },
                  signal: controller.signal
                });
                generatedUrl = await uploader.parse(upload);
                if (generatedUrl) {
                  console.log(`    ✅ ${uploader.name} upload successful: ${generatedUrl}`);
                  break;
                }
                lastUploadError = `${uploader.name}: HTTP ${upload.status}`;
                console.log(`    ⚠️ ${uploader.name} upload rejected: HTTP ${upload.status}`);
              } finally {
                clearTimeout(timer);
              }
            } catch (uploadError) {
              const cause = uploadError?.cause?.code || uploadError?.cause?.message || "";
              lastUploadError = `${uploader.name}: ${uploadError?.message || uploadError}${cause ? ` (${cause})` : ""}`;
              console.log(`    ⚠️ ${lastUploadError}`);
            }
          }

          if (!generatedUrl) {
            throw new Error(lastUploadError || "All uploaders failed");
          }

          reply = `🔗💗 ᴍᴇᴅɪᴀ ᴜʀʟ ɢᴇɴᴇʀᴀᴛᴇᴅ ✓ 🌹 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ 🫶🏻\n${generatedUrl}`;
        } catch (urlError) {
          console.log(`    ⚠️ URL command failed: ${urlError?.message || urlError}`);
          reply = `🥺💔 ᴍᴇᴅɪᴀ ᴜᴘʟᴏᴀᴅ ғᴀɪʟᴇᴅ 🌷 | 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗ᴅ`;
        }
      }
    } else if (command === "gstatus") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;

        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          const caption = commandText.slice(command.length).trim();
          const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
          let quotedMessage = ctx.quotedMessage;
          if (quotedMessage?.viewOnceMessageV2?.message) quotedMessage = quotedMessage.viewOnceMessageV2.message;
          if (quotedMessage?.viewOnceMessage?.message) quotedMessage = quotedMessage.viewOnceMessage.message;
          if (quotedMessage?.documentWithCaptionMessage?.message) quotedMessage = quotedMessage.documentWithCaptionMessage.message;
          const mediaKey = quotedMessage ? ["imageMessage","videoMessage","audioMessage","documentMessage","audioMessage"].find(k => quotedMessage[k]) : null;
          const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage"];

          if (!caption && !quotedMessage) {
            reply = `*𝐆ʀᴏᴜᴘ 𝐒ᴛᴀᴛᴜs 𝐔sᴀɢᴇ!🌷❤️‍🩹*\n\n*${runtimeConfig.prefix}gstatus 𝐘ᴏᴜʀ 𝐓ᴇxᴛ*`;
          } else {
            try {
              let storyData;
              if (quotedMessage && mediaTypes.includes(mediaKey)) {
                const quotedMsg = {
                  key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant || msg.key.participant },
                  message: quotedMessage
                };
                const buffer = await downloadMediaMessage(
                  quotedMsg,
                  "buffer",
                  {},
                  { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
                );
                if (mediaKey === "imageMessage") {
                  storyData = { image: buffer, caption: caption || quotedMessage.imageMessage?.caption || "" };
                } else if (mediaKey === "videoMessage") {
                  storyData = { video: buffer, caption: caption || quotedMessage.videoMessage?.caption || "" };
                } else if (mediaKey === "audioMessage") {
                  storyData = { audio: buffer, mimetype: quotedMessage.audioMessage?.mimetype || "audio/mp4", ptt: !!quotedMessage.audioMessage?.ptt };
                } else {
                  storyData = { document: buffer, mimetype: quotedMessage.documentMessage?.mimetype || "application/octet-stream", fileName: quotedMessage.documentMessage?.fileName || "file" };
                }
              } else {
                storyData = {
                  text: caption,
                  backgroundColor: Math.floor(Math.random() * 0xffffff),
                  font: 1
                };
              }

              if (typeof generateWAMessageContent !== "function" || typeof generateMessageID !== "function") {
                throw new Error("Installed Baileys version does not export the group-status message helpers");
              }
              if (typeof sock.waUploadToServer !== "function") {
                throw new Error("This Baileys socket does not expose waUploadToServer; group status cannot upload media/text");
              }
              const waMsgContent = await generateWAMessageContent(storyData, { upload: sock.waUploadToServer });
              await sock.relayMessage(
                msg.key.remoteJid,
                { groupStatusMessageV2: { message: waMsgContent.message || waMsgContent } },
                { messageId: generateMessageID() }
              );
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴛᴀᴛᴜs 𝐒ᴇᴛᴜᴘ 𝐃ᴏɴᴇ!💋❤️‍🩹*";
            } catch (gstatusError) {
              console.error("gstatus error:", gstatusError?.message || gstatusError);
              reply = "*𝐆ʀᴏᴜᴘ 𝐒ᴛᴀᴛᴜs 𝐒ᴇᴛᴜᴘ 𝐅ᴀɪʟᴇᴅ!🥀❤️‍🩹*";
            }
          }
        }
      }
    } else if (command === "leave") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "*𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs!🌨️❤️‍🩹*";
      } else {
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = normalizeJidNumber(senderJid);
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        if (!isOwner) {
          reply = "*𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ!👑💜*";
        } else {
          try {
            reply = "*𝐋ᴇғᴛ 𝐓ʜᴇ 𝐆ʀᴏᴜᴘ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ!🚪💜*\n\n*𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n*𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*";
            try {
              await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: quotedContact });
            } catch (e) {
              await sock.sendMessage(msg.key.remoteJid, { text: reply, ...(replyMentions.length ? { mentions: replyMentions } : {}) }, { quoted: quotedContact });
            }
            await sock.groupLeave(msg.key.remoteJid);
            return;
          } catch (leaveError) {
            console.error("leave error:", leaveError?.message || leaveError);
            reply = "*𝐆ʀᴏᴜᴘ 𝐋ᴇᴀᴠᴇ ғᴀɪʟᴇᴅ!🥀❤️‍🩹*";
          }
        }
      }
    } else if (command === "gmenu") {
      if (!msg.key.remoteJid?.endsWith("@g.us")) {
        reply = "🌨️ *тнιѕ ᴄσммαɴ∂ σɴℓу ωσʀкѕ ιɴ gʀσυρѕ!*";
      } else {
        const metadata = await sock.groupMetadata(msg.key.remoteJid);
        const senderJid = msg.key.participant || msg.participant || "";
        const senderNumber = senderJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        const ownerNumber = String(runtimeConfig.ownerNumber).replace(/\D/g, "");
        const isOwner = msg.key.fromMe || senderNumber === ownerNumber;
        const sender = findGroupParticipant(metadata.participants, senderJid);
        const senderIsAdmin = !!sender && (sender.admin === "admin" || sender.admin === "superadmin");
        if (!isOwner && !senderIsAdmin) {
          reply = "👑 *σɴℓу gʀσυρ α∂мιɴѕ ᴄαɴ υѕє тнιѕ ᴄσммαɴ∂.*";
        } else {
          reply = `*╰┈➤📋 𝐆ʀᴏᴜᴘ 𝐌ᴇɴᴜ*\n\n*╰┈➤💜 𝐗 𝐍ᴏʙɪᴛᴀ 𝐗𝐃*\n\n╰┈➤ ${runtimeConfig.prefix}tagall\n╰┈➤ ${runtimeConfig.prefix}admins\n╰┈➤ ${runtimeConfig.prefix}kick\n╰┈➤ ${runtimeConfig.prefix}add\n╰┈➤ ${runtimeConfig.prefix}gstatus\n╰┈➤ ${runtimeConfig.prefix}promote\n╰┈➤ ${runtimeConfig.prefix}demote\n╰┈➤ ${runtimeConfig.prefix}open\n╰┈➤ ${runtimeConfig.prefix}close\n╰┈➤ ${runtimeConfig.prefix}lock\n╰┈➤ ${runtimeConfig.prefix}unlock\n╰┈➤ ${runtimeConfig.prefix}setgpp\n╰┈➤ ${runtimeConfig.prefix}subject\n╰┈➤ ${runtimeConfig.prefix}desc\n╰┈➤ ${runtimeConfig.prefix}groupinfo\n╰┈➤ ${runtimeConfig.prefix}invite\n╰┈➤ ${runtimeConfig.prefix}revoke\n╰┈➤ ${runtimeConfig.prefix}requests\n╰┈➤ ${runtimeConfig.prefix}approve\n╰┈➤ ${runtimeConfig.prefix}reject\n╰┈➤ ${runtimeConfig.prefix}leave\n╰┈➤ ${runtimeConfig.prefix}poll\n╰┈➤ ${runtimeConfig.prefix}everyone\n╰┈➤ ${runtimeConfig.prefix}tagadmins\n╰┈➤ ${runtimeConfig.prefix}totag\n╰┈➤ ${runtimeConfig.prefix}groupdp\n\n*╰┈➤💜 𝐏ᴏᴡᴇʀᴇᴅ ʙʏ 𝐗 𝐍ᴏʙɪᴛᴀ*`;
        }
      }
    } else if (command === "play" || command === "song") {
      await handlePlaySong(sock, msg, args, quotedContact);
      return;
    } else if (command === "autotyping") {
      await automationCommand("autotyping", args, replyWithContact, isCommandOwner, settingsKey);
      return;
    } else if (command === "autoreact") {
      await autoreactCommand(args, replyWithContact, isCommandOwner, settingsKey);
      return;
    } else if (command === "autoread") {
      await automationCommand("autoread", args, replyWithContact, isCommandOwner, settingsKey);
      return;
    } else if (command === "autostoryview") {
      await automationCommand("autostoryview", args, replyWithContact, isCommandOwner, settingsKey);
      return;
    } else if (command === "owner") {
      reply = `*╰┈➤ 👑𝐎ᴡɴᴇʀ: ${runtimeConfig.ownerName}*`;
    } else if (command === "block" || command === "unblock") {
      if (!isCommandOwner) {
        reply = "🚫💗 ᴏɴʟʏ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ 🌸 |";
      } else {
        const blockContext = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || msg.message?.documentMessage?.contextInfo || msg.message?.audioMessage?.contextInfo || {};
        const quotedParticipant = blockContext.participant || "";
        const numberArg = args.find(a => /\d{5,}/.test(String(a))) || "";
        let targetJid = quotedParticipant;
        if (!targetJid && numberArg) {
          const targetNumber = String(numberArg).replace(/\D/g, "");
          if (targetNumber.length >= 5) targetJid = `${targetNumber}@s.whatsapp.net`;
        }
        if (!targetJid) {
          reply = `🥺💗 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ ᴏʀ ᴜsᴇ ${runtimeConfig.prefix}${command} <number> 🌸 |`;
        } else {
          try {
            const targetNumber = normalizeJidNumber(targetJid);
            if (targetNumber && targetNumber === ownerNumberForCommand) {
              reply = `⚠️💗 ᴏᴡɴᴇʀ ᴄᴀɴɴᴏᴛ ʙᴇ ${command === "block" ? "ʙʟᴏᴄᴋᴇᴅ" : "ᴜɴʙʟᴏᴄᴋᴇᴅ"} 🌷 |`;
            } else {
              await sock.updateBlockStatus(targetJid, command === "block" ? "block" : "unblock");
              reply = command === "block" ? "🔒💗 ᴜsᴇʀ ʙʟᴏᴄᴋᴇᴅ ✓ 🌸 |" : "🔓💗 ᴜsᴇʀ ᴜɴʙʟᴏᴄᴋᴇᴅ ✓ 🌸 |";
            }
          } catch (blockError) {
            console.log(`    ⚠️ ${command} failed: ${blockError?.message || blockError}`);
            reply = command === "block" ? "🥺💔 ᴜsᴇʀ ʙʟᴏᴄᴋ ғᴀɪʟᴇᴅ 🌹 |" : "🥺💔 ᴜsᴇʀ ᴜɴʙʟᴏᴄᴋ ғᴀɪʟᴇᴅ 🌹 |";
          }
        }
      }
    } else if (command === "bot" || command === "botlink") {
      reply = `💗 𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃\n\n🐰 𝐁𝐨𝐭 𝐏𝐚𝐢𝐫 𝐆𝐫𝐨𝐮𝐩\n💕 𝐉𝐨𝐢𝐧 𝐇𝐞𝐫𝐞 ↓\n\n🔗 https://t.me/pbv56NuNOhIzZjc9\n\n🌷 𝐏𝐚𝐢𝐫 𝐘𝐨𝐮𝐫 𝐁𝐨𝐭 ✨`;
    } else if (command === "menu") {
      const uptimeSec = Math.floor(process.uptime());
      const d = Math.floor(uptimeSec / 86400);
      const h = Math.floor((uptimeSec % 86400) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const used = process.memoryUsage().rss / 1024 / 1024;
      const total = 126 * 1024;
      const ramPct = Math.min(99, Math.max(1, Math.round((used / total) * 100)));
      const bar = "█".repeat(Math.round(ramPct / 10)) + "░".repeat(10 - Math.round(ramPct / 10));
      reply = `┏❐ 《 🌷 *𝐗 𝐍𝐎𝐁𝐈𝐓𝐀 𝐗𝐃* 🌷 》 ❐
┃ 👑 *ᴏᴡɴᴇʀ* : 𝐗 𝐍ᴏʙɪᴛᴀ
┃ ⚙️ *ᴍᴏᴅᴇ* : ${runtimeConfig.mode}
┃ 🖥️ *ʜᴏꜱᴛ* : Panel
┃ ⚡ *ꜱᴘᴇᴇᴅ* : -- ms
┃ 🔰 *ᴘʀᴇғɪx* : ${runtimeConfig.prefix}
┃ 🧠 *ᴄᴏʀᴇs* : ${require("os").cpus().length}
┃ ⏱️ *ᴜᴘᴛɪᴍᴇ* : ${d}d ${h}h ${m}m
┃ 📦 *ᴠᴇʀsɪᴏɴ* : 1.1.1
┃ 🔗 *ꜱᴇꜱꜱɪᴏɴ* : 1/15
┃ 💾 *ᴜꜱᴀɢᴇ* : ${used.toFixed(0)} MB of 126 GB
┃ 📊 *ʀᴀᴍ* : [${bar}] ${ramPct}%
┗❐

┏❐ 《 📋 *MENU* 》 ❐
┣◆ 🏓 ${runtimeConfig.prefix}ping
┣◆ 💚 ${runtimeConfig.prefix}alive
┣◆ ⏱️ ${runtimeConfig.prefix}uptime
┣◆ 📋 ${runtimeConfig.prefix}menu
┣◆ 👑 ${runtimeConfig.prefix}owner
┣◆ 🆔 ${runtimeConfig.prefix}groupid
┗❐

┏❐ 《 👑 *OWNER* 》 ❐
┣◆ ⚙️ ${runtimeConfig.prefix}setprefix

┣◆ 🌐 ${runtimeConfig.prefix}public
┣◆ 🔒 ${runtimeConfig.prefix}private
┣◆ 🚫 ${runtimeConfig.prefix}block
┣◆ ✅ ${runtimeConfig.prefix}unblock
┗❐

┏❐ 《 🎵 *PLAYLIST* 》 ❐
┣◆ 🎶 ${runtimeConfig.prefix}play
┣◆ 🎧 ${runtimeConfig.prefix}song
┗❐

┏❐ 《 👥 *GROUP* 》 ❐
┣◆ ⚡ ${runtimeConfig.prefix}kickall
┣◆ 📢 ${runtimeConfig.prefix}tagall
┣◆ 👮 ${runtimeConfig.prefix}admins
┣◆ 👢 ${runtimeConfig.prefix}kick
┣◆ ➕ ${runtimeConfig.prefix}add
┣◆ 📊 ${runtimeConfig.prefix}gstatus
┣◆ ⬆️ ${runtimeConfig.prefix}promote
┣◆ ⬇️ ${runtimeConfig.prefix}demote
┣◆ 🔓 ${runtimeConfig.prefix}open
┣◆ 🔒 ${runtimeConfig.prefix}close
┣◆ 🔐 ${runtimeConfig.prefix}lock
┣◆ 🔓 ${runtimeConfig.prefix}unlock
┣◆ 🖼️ ${runtimeConfig.prefix}setgpp
┣◆ ✏️ ${runtimeConfig.prefix}subject
┣◆ 📝 ${runtimeConfig.prefix}desc
┣◆ ℹ️ ${runtimeConfig.prefix}groupinfo
┣◆ 🔗 ${runtimeConfig.prefix}invite
┣◆ ♻️ ${runtimeConfig.prefix}revoke
┣◆ 📩 ${runtimeConfig.prefix}requests
┣◆ ✅ ${runtimeConfig.prefix}approve
┣◆ ❌ ${runtimeConfig.prefix}reject
┣◆ 🚪 ${runtimeConfig.prefix}leave
┣◆ 📢 ${runtimeConfig.prefix}everyone
┣◆ 👮 ${runtimeConfig.prefix}tagadmins
┣◆ 🏷️ ${runtimeConfig.prefix}totag
┣◆ 🖼️ ${runtimeConfig.prefix}groupdp
┣◆ 🛡️ ${runtimeConfig.prefix}antigm
┣◆ 🚫 ${runtimeConfig.prefix}antisticker
┣◆ 🔗 ${runtimeConfig.prefix}antilink
┣◆ 👋 ${runtimeConfig.prefix}welcome
┣◆ 🏃 ${runtimeConfig.prefix}goodbye
┣◆ ⚠️ ${runtimeConfig.prefix}warn
┣◆ 🗑️ ${runtimeConfig.prefix}delete
┗❐

┏❐ 《 🤖 *AUTOMATION* 》 ❐
┣◆ ⌨️ ${runtimeConfig.prefix}autotyping
┣◆ ❤️ ${runtimeConfig.prefix}autoreact
┣◆ 👀 ${runtimeConfig.prefix}autoread
┣◆ 📖 ${runtimeConfig.prefix}autostoryview
┗❐

┏❐ 《 🛠️ *TOOLS* 》 ❐
┣◆ 👁️ ${runtimeConfig.prefix}vv
┣◆ 🔗 ${runtimeConfig.prefix}url
┣◆ 🆔 ${runtimeConfig.prefix}jid
┣◆ 👤 ${runtimeConfig.prefix}userinfo
┣◆ 🖼️ ${runtimeConfig.prefix}getpp
┣◆ 📝 ${runtimeConfig.prefix}getbio
┣◆ 🤖 ${runtimeConfig.prefix}bot
┣◆ 🔗 ${runtimeConfig.prefix}botlink
┗❐

┏❐ 《 🎮 *FUN & GAMES* 》 ❐
┣◆ 💕 ${runtimeConfig.prefix}ship
┣◆ 💖 ${runtimeConfig.prefix}love
┣◆ ❓ ${runtimeConfig.prefix}truth
┣◆ 🔥 ${runtimeConfig.prefix}dare
┣◆ 🎱 ${runtimeConfig.prefix}8ball
┣◆ 😂 ${runtimeConfig.prefix}joke
┣◆ 🖼️ ${runtimeConfig.prefix}meme
┣◆ 🧠 ${runtimeConfig.prefix}quiz
┣◆ 🎲 ${runtimeConfig.prefix}dice
┣◆ ✊ ${runtimeConfig.prefix}rps
┣◆ 🔮 ${runtimeConfig.prefix}guess
┗❐

┏❐ 《 🧪 *CHECK ZONE* 》 ❐
┣◆ 🤪 ${runtimeConfig.prefix}stupidcheck
┣◆ 😈 ${runtimeConfig.prefix}uncleancheck
┣◆ 🔥 ${runtimeConfig.prefix}hotcheck
┣◆ 🧠 ${runtimeConfig.prefix}smartcheck
┣◆ 🌟 ${runtimeConfig.prefix}greatcheckcase
┣◆ 😈 ${runtimeConfig.prefix}evilcheck
┣◆ 🐶 ${runtimeConfig.prefix}dogcheck
┣◆ 😎 ${runtimeConfig.prefix}coolcheck
┣◆ 🌈 ${runtimeConfig.prefix}gaycheck
┣◆ 💕 ${runtimeConfig.prefix}waifucheck
┗❐

┏❐ 《 😂 *ROAST & REACTION* 》 ❐
┣◆ 🤬 ${runtimeConfig.prefix}gali
┣◆ 🔥 ${runtimeConfig.prefix}roast
┣◆ 🧑‍💻 ${runtimeConfig.prefix}hack
┣◆ 😂 ${runtimeConfig.prefix}laugh
┣◆ 🫣 ${runtimeConfig.prefix}shy
┣◆ 😢 ${runtimeConfig.prefix}sad
┣◆ 🌙 ${runtimeConfig.prefix}moon
┣◆ 😡 ${runtimeConfig.prefix}anger
┣◆ 😍 ${runtimeConfig.prefix}happy
┣◆ 😵 ${runtimeConfig.prefix}confused
┣◆ ❤️ ${runtimeConfig.prefix}heart
┣◆ 😎 ${runtimeConfig.prefix}cool
┣◆ 🔥 ${runtimeConfig.prefix}fire
┣◆ ⭐ ${runtimeConfig.prefix}star
┣◆ 👍 ${runtimeConfig.prefix}thumbsup
┗❐

┏❐ 《 💕 *SOCIAL* 》 ❐
┣◆ 💑 ${runtimeConfig.prefix}couple
┣◆ 😉 ${runtimeConfig.prefix}flirt
┣◆ 🥰 ${runtimeConfig.prefix}compliment
┣◆ 🌹 ${runtimeConfig.prefix}tareef
┣◆ 🤝 ${runtimeConfig.prefix}respect
┣◆ 💚 ${runtimeConfig.prefix}goodword
┣◆ 😤 ${runtimeConfig.prefix}insult
┗❐

┏❐ 《 🎲 *MINI GAMES* 》 ❐
┣◆ 🪙 ${runtimeConfig.prefix}coinflip
┣◆ 🔄 ${runtimeConfig.prefix}flip
┣◆ 🎲 ${runtimeConfig.prefix}roll
┣◆ 🎰 ${runtimeConfig.prefix}slot
┣◆ ❌ ${runtimeConfig.prefix}tictactoe
┣◆ ⭕ ${runtimeConfig.prefix}ttt
┣◆ 🏳️ ${runtimeConfig.prefix}surrender
┣◆ 🏃 ${runtimeConfig.prefix}giveup
┣◆ 🏆 ${runtimeConfig.prefix}wcg
┣◆ 🔤 ${runtimeConfig.prefix}wordchain
┗❐

┏❐ 《 📝 *TEXT TOOLS* 》 ❐
┣◆ 📖 ${runtimeConfig.prefix}readmore
┣◆ 📜 ${runtimeConfig.prefix}textreadmore
┣◆ 🧮 ${runtimeConfig.prefix}calc
┣◆ 🔢 ${runtimeConfig.prefix}calculate
┣◆ 🔄 ${runtimeConfig.prefix}tovn
┣◆ 📖 ${runtimeConfig.prefix}read
┗❐

┏❐ 《 🖼️ *MEDIA FUN* 》 ❐
┣◆ 🧩 ${runtimeConfig.prefix}sticker
┣◆ 🏷️ ${runtimeConfig.prefix}take
┣◆ 🥷 ${runtimeConfig.prefix}steal
┣◆ ✍️ ${runtimeConfig.prefix}wm
┣◆ 🖋️ ${runtimeConfig.prefix}swm
┣◆ 🏷️ ${runtimeConfig.prefix}takefull
┣◆ 🖼️ ${runtimeConfig.prefix}toimg
┗❐

┏❐ 《 🎧 *AUDIO FX* 》 ❐
┣◆ 🔊 ${runtimeConfig.prefix}bass
┣◆ 💥 ${runtimeConfig.prefix}blown
┣◆ 🌊 ${runtimeConfig.prefix}deep
┣◆ 📢 ${runtimeConfig.prefix}earrape
┣◆ ⚡ ${runtimeConfig.prefix}fast
┣◆ 🐘 ${runtimeConfig.prefix}fat
┣◆ 🌙 ${runtimeConfig.prefix}nightcore
┣◆ 🔄 ${runtimeConfig.prefix}reverse
┣◆ 🤖 ${runtimeConfig.prefix}robot
┣◆ 🐢 ${runtimeConfig.prefix}slow
┣◆ ✨ ${runtimeConfig.prefix}smooth
┣◆ 🐿️ ${runtimeConfig.prefix}squirrel
┗❐`
    } else {
      reply = `💗 Oops... Unknown Command 🦋\n❝ ${command} ❞ — Try ${runtimeConfig.prefix}menu 🌸`;
    }

    try {
      if (command === "menu" && fs.existsSync("./assets/x-nobita-xd-menu.jpg")) {
        await sock.sendMessage(
          msg.key.remoteJid,
          {
            image: fs.readFileSync("./assets/x-nobita-xd-menu.jpg"),
            caption: reply,
            contextInfo
          },
          { quoted: quotedContact }
        );
      } else {
        await sock.sendMessage(msg.key.remoteJid, { text: reply, ...(replyMentions.length ? { mentions: replyMentions } : {}) }, { quoted: quotedContact });
      }
    } catch (quoteError) {
      console.log(`    ⚠️ vCard quote failed, sending normal reply: ${quoteError?.message || quoteError}`);
      await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: quotedContact });
    }
    console.log(`    ✅ REPLIED to ${msg.key.remoteJid}`);
  } catch (err) {
    console.log(`    ❌ Error: ${err?.message || err}`);
  }
};

  return processCommandMessage;
}

module.exports = { createCommandHandler };
