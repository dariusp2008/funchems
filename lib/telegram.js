const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOPIC_ID = process.env.TELEGRAM_TOPIC_ID || "";

async function call(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "relay error");
  return json.result;
}

// Posts a visitor's help-page message into the group. Server-only: the bot
// token must never reach the browser.
export async function sendHelpMessage(text) {
  const params = { chat_id: CHAT_ID, text: "Store chat: " + text };
  if (TOPIC_ID) params.message_thread_id = Number(TOPIC_ID);
  return call("sendMessage", params);
}

// Sends a message to any chat (group or private DM with the bot). Used by
// the webhook handler for the admin /start menu — separate from the
// group-scoped help relay above.
export async function tgSend(chatId, text, extra) {
  return call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

export async function tgEditMessage(chatId, messageId, text, extra) {
  return call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
}

export async function tgAnswerCallback(callbackQueryId, text, showAlert) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: !!showAlert });
}

// Pulls new messages posted in the group since `offset` (a Telegram
// update_id), scoped to the configured chat and, if set, the one topic.
export async function pullHelpMessages(offset) {
  const updates = await call("getUpdates", { offset, timeout: 0 });
  const rows = [];
  let nextOffset = offset;
  for (const u of updates) {
    nextOffset = u.update_id + 1;
    const msg = u.message || u.channel_post;
    if (!msg || !msg.text) continue;
    if (String(msg.chat && msg.chat.id) !== String(CHAT_ID)) continue;
    if (TOPIC_ID && String(msg.message_thread_id || "") !== String(TOPIC_ID)) continue;
    rows.push({
      updateId: u.update_id,
      text: msg.text,
      createdAt: new Date((msg.date || 0) * 1000).toISOString(),
    });
  }
  return { rows, nextOffset };
}
