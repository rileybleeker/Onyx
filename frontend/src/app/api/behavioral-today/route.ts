import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/behavioral-today
 *
 * Returns { behavioral_today: "YYYY-MM-DD" } per pds.behavioral_today_now()
 * — TZ-aware via user_tz_log (handles travel) and awake-tail-aware via the
 * -6h rule. Frontend pages use this to pre-fill date pickers with the day
 * Riley behaviorally considers "today" rather than ET-clock-today.
 *
 * Fallback: if the RPC fails, returns ET-clock-today (computed in JS — TZ
 * resolution requires a tz database which Edge runtime lacks; using the
 * Node runtime supabase client + Postgres function avoids that).
 */
export async function GET() {
  try {
    const { data, error } = await supabase.rpc("behavioral_today_now");
    if (error || !data) {
      const fallback = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      return NextResponse.json({ behavioral_today: fallback, fallback: true });
    }
    return NextResponse.json({ behavioral_today: data });
  } catch {
    const fallback = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return NextResponse.json({ behavioral_today: fallback, fallback: true });
  }
}
