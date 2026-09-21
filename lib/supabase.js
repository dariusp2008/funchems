import { createClient } from "@supabase/supabase-js";

// Browser-safe client: public URL + anon key only, respects row-level security.
export function supabaseBrowser() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

// Server-only client: service role key, bypasses RLS. Never import this from
// client components — it must only run inside API routes / server actions.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
