import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing access token" }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // Verify the token belongs to a real, currently-signed-in user before
  // deleting anything — never trust a client-supplied user id/email here.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return NextResponse.json({ ok: false, error: "invalid session" }, { status: 401 });
  }

  const { error } = await admin.auth.admin.deleteUser(userData.user.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
