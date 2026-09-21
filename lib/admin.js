import { supabaseAdmin } from "@/lib/supabase";

const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Verifies the bearer token belongs to a real, currently-signed-in Supabase
// user whose email is in the server-only ADMIN_EMAILS allowlist. Never trust
// a client-supplied email/role — only the verified token's email counts.
export async function requireAdmin(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, error: "missing access token" };

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: "invalid session" };

  const email = (data.user.email || "").toLowerCase();
  if (!adminEmails.includes(email)) return { ok: false, status: 403, error: "not an admin" };

  return { ok: true, user: data.user };
}
