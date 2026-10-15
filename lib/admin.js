import { supabaseAdmin } from "@/lib/supabase";

// Verifies the bearer token belongs to a real, currently-signed-in Supabase
// user whose email is a row in the `admins` table. Never trust a
// client-supplied email/role — only the verified token's email counts.
// Admins are managed via the Telegram bot's /start menu (see
// app/api/telegram/webhook) or directly in Supabase — not an env var.
export async function requireAdmin(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, error: "missing access token" };

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: "invalid session" };

  const email = (data.user.email || "").toLowerCase();
  const { data: row } = await admin.from("admins").select("email").eq("email", email).maybeSingle();
  if (!row) return { ok: false, status: 403, error: "not an admin" };

  return { ok: true, user: data.user };
}
