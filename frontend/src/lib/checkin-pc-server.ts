import "server-only";
import { createClient } from "@supabase/supabase-js";
import { CHECKIN_PC_COLUMNS, parsePcActivityRow, type PcActivityDay } from "@/lib/checkin-pc-activity";

/**
 * Server-side read of ONE behavioral day of pds.pc_activity_daily for the /check-in pre-fills
 * (lib/checkin-pc-activity.ts). SERVICE ROLE ONLY: the pc_activity_* tables and this view have RLS on
 * with no grants to anon / authenticated (sql/pc_activity_schema.sql), so the browser can never query
 * them and this module must never be imported from a client component ("server-only" enforces that at
 * build time). The caller sits under the /api/habits/* owner session boundary.
 *
 * Fails open: any problem (missing view, missing row, no credentials) returns null and the questions
 * simply get no PC-activity pre-fill. A failure logs an error code only — never a row, a program name
 * or a number of minutes (the row is metadata, but the habit is the same as screen-time-server's).
 */
export async function loadPcActivityDay(date: string): Promise<PcActivityDay | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[checkin] pc_activity read failed", "not-configured");
    return null;
  }
  try {
    const supa = createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supa.from("pc_activity_daily").select(CHECKIN_PC_COLUMNS).eq("behavioral_date", date).maybeSingle();
    if (error) {
      // 42P01 / PGRST205 = the view is not applied yet: no pre-fill, never an error for the check-in.
      console.error("[checkin] pc_activity read failed", error.code ?? "unexpected");
      return null;
    }
    return parsePcActivityRow(data);
  } catch {
    console.error("[checkin] pc_activity read failed", "unexpected");
    return null;
  }
}
