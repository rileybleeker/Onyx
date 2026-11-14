import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { FocusUnlockError, loadUnlockStatus } from "@/lib/focus-unlock-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/focus/unlock-status
 *
 * Asked by the Onyx Focus iPhone app (tools/screentime_ios) with the x-onyx-ci-token header: this is
 * ONE exact path in middleware's isCiRoute(), never /api/focus/*. The owner session works too (the
 * /install settings card shows the same answer).
 *
 * Answers { behavioral_date, rule, config_present, habits: [{ name, done }], habits_done }:
 * the habits Riley chose in Onyx (pds.focus_unlock_config) and whether pds.habit_journal has
 * answer 'Yes' for each on the current behavioral day (pds.behavioral_today_now()). Nothing else is
 * read or returned: no other habits, no history, no notes. Read-only.
 *
 * Any failure answers 500 with a step name only. The phone treats every failure as "unknown" and
 * falls back to its time-only rule, so an error here can never keep apps blocked past the unlock time.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function GET() {
  try {
    const status = await loadUnlockStatus(supabase);
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const step = e instanceof FocusUnlockError ? e.step : "unexpected";
    console.error("focus unlock-status failed:", step);
    return NextResponse.json({ error: "status unavailable", step }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
