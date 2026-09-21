import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";

export async function POST(request) {
  const check = await requireAdmin(request);
  return NextResponse.json({ isAdmin: check.ok });
}
