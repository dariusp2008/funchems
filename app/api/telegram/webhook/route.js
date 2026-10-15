import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { tgSend, tgEditMessage, tgAnswerCallback } from "@/lib/telegram";

function generatePassword() {
  return randomBytes(9).toString("base64url");
}

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
    const newEmail = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!newEmail || !newEmail.includes("@")) {
      await tgSend(chatId, "Usage:\n/addadmin email@example.com\n\nThey get dashboard access right away. They link their own Telegram with /link once they DM this bot.");
      return;
    }

    let loginNote;
    const password = generatePassword();
    const { error: createError } = await db.auth.admin.createUser({
      email: newEmail,
      password,
      email_confirm: true,
    });
    if (!createError) {
      loginNote = `\nLogin: ${newEmail} / ${password}\n(have them change the password after first login)`;
    } else if (/already|exists|registered/i.test(createError.message)) {
      loginNote = "\nThey already have a login — use their existing password, or reset it from the dashboard.";
    } else {
      await tgSend(chatId, `Error creating login: ${createError.message}`);
      return;
    }

    const { error } = await db.from("admins").upsert(
      { email: newEmail, added_by: requesterEmail },
      { onConflict: "email", ignoreDuplicates: false }
    );
    await tgSend(chatId, error ? `Error: ${error.message}` : `Added ${newEmail} as admin.${loginNote}\nThey should DM me /link ${newEmail} to unlock this menu too.`);
    return;
  }

  if (text.startsWith("/link")) {
    const email = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!email || !email.includes("@")) {
      await tgSend(chatId, "Usage: /link email@example.com");
      return;
    }
    const { data: row } = await db.from("admins").select("id, telegram_id").eq("email", email).maybeSingle();
    if (!row) {
      await tgSend(chatId, "No admin with that email.");
      return;
    }
    if (row.telegram_id && row.telegram_id !== fromId) {
      await tgSend(chatId, "That email is already linked to someone else.");
      return;
    }
    await db.from("admins").update({ telegram_id: fromId }).eq("id", row.id);
    await tgSend(chatId, `Linked. Send /start to open the admin menu.`);
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
    await tgSend(chatId, "Send:\n/addadmin email@example.com\n\nThey get dashboard access right away. They link their own Telegram later with /link email@example.com.");
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
