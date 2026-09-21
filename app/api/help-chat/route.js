import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendHelpMessage, pullHelpMessages } from "@/lib/telegram";

// Backs the help-page chat widget. The relay bot's token lives only in
// server env vars — the browser talks to this route, never to the bot API
// directly, and never sees "Telegram" anywhere in the response.
export async function GET() {
  const admin = supabaseAdmin();

  const { data: last } = await admin
    .from("help_chat_messages")
    .select("update_id")
    .not("update_id", "is", null)
    .order("update_id", { ascending: false })
    .limit(1)
    .maybeSingle();

  try {
    const { rows } = await pullHelpMessages(last ? last.update_id + 1 : undefined);
    if (rows.length) {
      await admin.from("help_chat_messages").upsert(
        rows.map((r) => ({ update_id: r.updateId, from_role: "support", text: r.text, created_at: r.createdAt })),
        { onConflict: "update_id" }
      );
    }
  } catch (e) {
    // keep the panel usable if the relay is briefly unreachable
  }

  const { data, error } = await admin
    .from("help_chat_messages")
    .select("id,from_role,text,created_at")
    .order("id", { ascending: true })
    .limit(100);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, messages: data || [] });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "empty message" }, { status: 400 });

  try {
    await sendHelpMessage(text);
  } catch (e) {
    return NextResponse.json({ ok: false, error: "delivery failed" }, { status: 502 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("help_chat_messages")
    .insert({ from_role: "visitor", text })
    .select("id,from_role,text,created_at")
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, message: data });
}
