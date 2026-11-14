// Finds the chat IDs your Telegram bot can message, then sends a test to each.
//
// Usage:
//   1. Message your bot (any text), or add it to a group and send a message there.
//   2. TELEGRAM_BOT_TOKEN=123:abc node telegram-setup.js
//
// In groups, Telegram only shows the bot messages that start with "/" unless you turn off
// the bot's privacy mode (@BotFather → /setprivacy → Disable), so send "/start" in the group.

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN first.');
  process.exit(1);
}
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

(async () => {
  const me = await api('getMe');
  if (!me.ok) throw new Error(`Bad token: ${me.description}`);
  console.log(`Bot: @${me.result.username}`);

  const updates = await api('getUpdates');
  if (!updates.ok) throw new Error(updates.description);
  const chats = new Map();
  for (const u of updates.result) {
    const chat = (u.message || u.my_chat_member || u.channel_post || {}).chat;
    if (chat) chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' '));
  }
  if (!chats.size) {
    console.log(`No chats yet. Send @${me.result.username} a message (or "/start" in your group) and run this again.`);
    return;
  }
  for (const [id, name] of chats) {
    const r = await api('sendMessage', { chat_id: id, text: '✅ VOX agent test: Dune showtime alerts will arrive here.' });
    console.log(`${id}\t${name}\t${r.ok ? 'test sent' : 'send failed: ' + r.description}`);
  }
  console.log('\nPut the id(s) you want in the TELEGRAM_CHAT_ID secret (comma-separated for several).');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
