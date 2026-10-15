import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";

// Mirrors what the local db.push() used to do directly from the browser —
// moved server-side because writes need the service role key, which must
// never reach the client.
//
// The dashboard always sends each collection's *complete* current state (it
// keeps the full array in memory and pushes on every edit), so a row's
// absence from the payload means it was deleted client-side. replaceSet
// upserts what's there and removes anything else, so deletes actually stick
// instead of resurrecting on the next pull.
async function replaceSet(admin, table, rows, idCol) {
  if (!Array.isArray(rows)) return null;
  if (rows.length) {
    const { error } = await admin.from(table).upsert(rows, { onConflict: idCol });
    if (error) return error.message;
  }
  const keep = rows.map((r) => r[idCol]);
  const del = keep.length
    ? admin.from(table).delete().not(idCol, "in", `(${keep.join(",")})`)
    : admin.from(table).delete().not(idCol, "is", null);
  const { error } = await del;
  return error ? error.message : null;
}

export async function POST(request) {
  const check = await requireAdmin(request);
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error }, { status: check.status });
  }

  const body = await request.json();
  const { products, discounts, labReports, reviews, content } = body || {};
  const admin = supabaseAdmin();

  const jobs = [
    ["products", products, "cat"],
    ["discounts", discounts, "id"],
    ["lab_reports", labReports, "id"],
    ["reviews", reviews, "id"],
  ];
  for (const [table, rows, idCol] of jobs) {
    const error = await replaceSet(admin, table, rows, idCol);
    if (error) return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  if (Array.isArray(content) && content.length) {
    const { error } = await admin.from("content").upsert(content, { onConflict: "key" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
