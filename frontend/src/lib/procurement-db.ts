import { createClient } from "@supabase/supabase-js";

/** Service-role client for the procurement API routes. Created per request so a missing env var is a handled 503, not a crashed import.
 *  Every /api route sits behind middleware.ts, which only lets the signed-in owner account through. */
export function procurementDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
