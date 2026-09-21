import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";

// Mirrors what the local db.push() used to do directly from the browser —
// moved server-side because writes need the service role key, which must
// never reach the client. Only products/discounts for now, matching the
// dashboard's current sync scope.
export async function POST(request) {
  const check = await requireAdmin(request);
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error }, { status: check.status });
  }

  const body = await request.json();
  const { products, discounts } = body || {};
  const admin = supabaseAdmin();

  if (Array.isArray(products) && products.length) {
    const { error } = await admin.from("products").upsert(products);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (Array.isArray(discounts) && discounts.length) {
    const { error } = await admin.from("discounts").upsert(discounts);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
