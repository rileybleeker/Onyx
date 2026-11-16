import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { checkPortionRequest } from "@/lib/delivery-portion";
import { SLEEP_QUESTIONS } from "@/lib/checkin";
import { MAX_WINDDOWN_BODY_BYTES, isMissingStorage, parseRuleBody, windDownRefusal } from "@/lib/sleep-winddown";
import { readJsonBody, ruleFromRow } from "@/lib/sleep-winddown-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/sleep/winddown/rule (PROD-SLEEP-01): a new wind-down goal version, from tonight on. Body
 * {habit_page_id, target_time "HH:MM", wins_needed, window_nights, tz, today}: every value is Riley's choice (no
 * bedtime is assumed). Versions are append-only (pds.sleep_winddown_add_rule + its guard trigger), so earlier
 * nights keep the goal they had. The habit must be one Onyx knows and not a sleep question (those describe the
 * night after it ended, so "tonight" could never be answered). Owner session only, same-origin JSON, at most 1 KB.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_WINDDOWN_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });
  const read = await readJsonBody(req, MAX_WINDDOWN_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseRuleBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const b = parsed.value;

  const { data: map, error: mapErr } = await supabase.from("habit_name_map").select("habit_name").eq("notion_page_id", b.habitPageId).maybeSingle();
  if (mapErr) {
    console.error("[sleep winddown] rule: habit lookup failed", mapErr.code ?? "unexpected");
    return NextResponse.json({ error: "Not saved. Try again." }, { status: 500, headers: NO_STORE });
  }
  const name = (map as { habit_name?: string } | null)?.habit_name;
  if (!name) return NextResponse.json({ error: "That habit isn't in Onyx yet. Choose another one.", code: "habit_gone" }, { status: 409, headers: NO_STORE });
  if (SLEEP_QUESTIONS.has(name)) {
    return NextResponse.json({ error: "That is a sleep question (it describes the night after it ended). Choose an evening habit.", code: "sleep_question" }, { status: 400, headers: NO_STORE });
  }

  const { data, error } = await supabase.rpc("sleep_winddown_add_rule", {
    p_habit_page_id: b.habitPageId, p_target_time: b.targetTime, p_tz: b.tz,
    p_wins_needed: b.winsNeeded, p_window_nights: b.windowNights, p_today: b.today,
  });
  if (error) {
    const known = windDownRefusal(error);
    if (known) return NextResponse.json({ error: known.error, code: known.code }, { status: known.status, headers: NO_STORE });
    if (isMissingStorage(error)) return NextResponse.json({ error: "The wind-down streak isn't set up on the server yet.", code: "not_connected" }, { status: 503, headers: NO_STORE });
    console.error("[sleep winddown] rule write failed", error.code ?? "unexpected");
    return NextResponse.json({ error: "Not saved. Try again." }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ rule: ruleFromRow((data ?? {}) as Record<string, unknown>) }, { headers: NO_STORE });
}
