# X NOBITA V1 XD — Multi-User Owner Pair Bot

Telegram-based WhatsApp pairing bot with per-Telegram-user ownership. Each WhatsApp number is assigned to the Telegram account that requested its pairing code. A different Telegram user cannot inspect or unpair that number.

## Requirements
- Node.js 20+
- Telegram bot token created with `@BotFather`
- WhatsApp account owner who can enter the pairing code in Linked Devices

## Setup
1. Extract the ZIP.
2. Copy `.env.example` to `.env` and put your own Telegram bot token in `BOT_TOKEN`.
3. Install and start:
   ```bash
   npm install
   npm run check
   npm start
   ```
4. Set `OFFICIAL_GROUP_ID` to the numeric chat ID of your official Telegram pairing group, `OFFICIAL_GROUP_LINK` to its invite link, and `ADMIN_IDS` to comma-separated numeric Telegram admin user IDs. Then open the bot in a private Telegram chat.

## Telegram commands
- `/start` — show menu
- `/pair 91XXXXXXXXXX` — pair a number; it becomes owned by your Telegram numeric user ID
- `/status`, `/uptime`, `/alive`, `/help`, `/Halp` — admin-only bot status/help commands
- `/unpair 91XXXXXXXXXX` — remove only a session you own
- `/settings [number]` — show settings for your own session(s)
- `/setsetting NUMBER prefix !` — set that session's WhatsApp command prefix
- `/setsetting NUMBER repliesEnabled false` — disable command replies for that session
- `/setsetting NUMBER repliesEnabled true` — enable command replies

Only the account that owns a number can read/change its settings or unpair it. The bot no longer uses a global `ADMIN_IDS` allow-list; each Telegram user may pair their own number.

## Isolation and storage
- `sessions/<number>/` contains Baileys credentials for that WhatsApp number.
- `data/owners.json` maps WhatsApp numbers to Telegram numeric user IDs.
- `data/settings.json` stores settings independently for each WhatsApp number.
- JSON files are written with restrictive file permissions where supported. Keep the entire `sessions/` and `data/` folders private and never publish them.
- Existing sessions created before this owner mapping was added do not automatically get an owner. Back up the folders before migrating and only add a verified owner mapping if you know who owns each session.

## WhatsApp commands
- `.menu`, `.ping`, `.alive`
- `.welcome on/off`, `.setwelcome`, `.getwelcome`, `.resetwelcome`
- `.goodbye on/off`, `.setgoodbye`, `.getgoodbye`, `.resetgoodbye`
- `.setprefix !` — change this WhatsApp session's prefix (owner account only)
- `.pair 91XXXXXXXXXX` — explains that pairing is managed through Telegram `/pair NUMBER`
- `.public` / `.private` — allow normal commands from everyone or restrict them to the paired account
- `.block 91XXXXXXXXXX` / `.unblock 91XXXXXXXXXX` — stop/restore bot command replies for that number; this does not block the person at WhatsApp level
- `.broadcast Your message` — sends to chats this session has seen and saved; delivery count reports successful send calls, not read receipts

Owner commands require a message sent by the paired WhatsApp account. Prefix and mode are stored per session. Telegram `/setsetting NUMBER prefix !` remains available too. `repliesEnabled` can be used to disable replies for that session.

## Important
This is a local single-process JSON storage implementation, not a multi-server database. Run one bot process against a given data/session directory. Anyone with server filesystem access can read session credentials; secure the host and backups. Pair only WhatsApp accounts you own or have permission to link. WhatsApp/Baileys compatibility may change; this package has syntax checks but has not been live-tested against your accounts or Telegram token.


## Troubleshooting WhatsApp commands
- Check the terminal for `[number] WhatsApp connected.` after pairing.
- Send `.ping` to the paired number's own WhatsApp **Message yourself** chat.
- This handler listens to both Baileys `notify` and `append` message upserts; terminal logs show the event type and extracted text.
- If there are no `messages.upsert` logs, check that the session is connected and the installed Baileys version is compatible. Do not share `sessions/`, `.env`, or pairing codes.
