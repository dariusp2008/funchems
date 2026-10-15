import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { tgSend, tgEditMessage, tgAnswerCallback } from "@/lib/telegram";

// Telegram sends every update (DMs with the bot, button taps) here instead
// of us polling. Secured by the secret_token Telegram echoes back on every
// request, set when the webhook is registered with setWebhook.
function adminMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Admin", callback_data: "add_prompt" }],
        [{ text: "➖ Remove Admin", callback_data: "remove_list" }],
      ],
    },
  };
}

async function adminEmailFor(telegramId) {
  const db = supabaseAdmin();
  const { data } = await db
    .from("admins")
    .select("email")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return data?.email || null;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text = (msg.text || "").trim();
  const db = supabaseAdmin();

  if (text === "/start") {
    const email = await adminEmailFor(fromId);
    if (!email) {
      await tgSend(chatId, "Not authorized.");
      return;
    }
    await tgSend(chatId, `Admin menu (${email}):`, adminMenu());
    return;
  }

  if (text.startsWith("/addadmin")) {
    const requesterEmail = await adminEmailFor(fromId);
    if (!requesterEmail) {
      await tgSend(chatId, "Not authorized.");
      return;
    }
    const [newEmail, newTgId] = text.split(/\s+/).slice(1);
    if (!newEmail || !newTgId || !/^\d+$/.test(newTgId)) {
      await tgSend(chatId, "Usage:\n/addadmin email@example.com telegram_id\n\nGet telegram_id from @userinfobot.");
      return;
    }
    const { error } = await db.from("admins").upsert(
      { email: newEmail.toLowerCase(), telegram_id: Number(newTgId), added_by: requesterEmail },
      { onConflict: "email" }
    );
    await tgSend(chatId, error ? `Error: ${error.message}` : `Added ${newEmail} as admin.`);
  }
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const fromId = cq.from.id;
  const data = cq.data || "";
  const db = supabaseAdmin();

  const requesterEmail = await adminEmailFor(fromId);
  if (!requesterEmail) {
    await tgAnswerCallback(cq.id, "Not authorized.");
    return;
  }

  if (data === "add_prompt") {
    await tgAnswerCallback(cq.id);
    await tgSend(chatId, "Send:\n/addadmin email@example.com telegram_id\n\nGet telegram_id from @userinfobot.");
    return;
  }

  if (data === "remove_list") {
    await tgAnswerCallback(cq.id);
    const { data: admins } = await db.from("admins").select("id, email").order("email");
    if (!admins || !admins.length) {
      await tgSend(chatId, "No admins found.");
      return;
    }
    const keyboard = admins.map((a) => [{ text: `✕ ${a.email}`, callback_data: `remove:${a.id}` }]);
    await tgSend(chatId, "Tap to remove:", { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (data.startsWith("remove:")) {
    const id = data.slice("remove:".length);
    const { data: target } = await db.from("admins").select("email").eq("id", id).maybeSingle();
    if (!target) {
      await tgAnswerCallback(cq.id, "Already removed.");
      return;
    }
    const { count } = await db.from("admins").select("id", { count: "exact", head: true });
    if ((count || 0) <= 1) {
      await tgAnswerCallback(cq.id, "Can't remove the last admin.", true);
      return;
    }
    await db.from("admins").delete().eq("id", id);
    await tgAnswerCallback(cq.id, `Removed ${target.email}.`);
    await tgEditMessage(chatId, messageId, `Removed ${target.email}.`);
    return;
  }

  await tgAnswerCallback(cq.id);
}

export async function POST(request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = await request.json();

  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.error("telegram webhook error", e);
  }

  return NextResponse.json({ ok: true });
}
