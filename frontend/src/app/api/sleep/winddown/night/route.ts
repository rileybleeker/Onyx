import { createClient } from "@supabase/supabase-js";
import { after, NextRequest, NextResponse } from "next/server";
import { checkPortionRequest } from "@/lib/delivery-portion";
import { MAX_WINDDOWN_BODY_BYTES, isMissingStorage, parseNightBody, windDownRefusal } from "@/lib/sleep-winddown";
import { mirrorLastCompleted, readJsonBody, setNightResult } from "@/lib/sleep-winddown-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/sleep/winddown/night (PROD-SLEEP-01): one explicit answer for one night, from the wind-down button or
 * the "Did it / Didn't" rows. Body {night, answer: "Yes" | "No" | null, expect: "Yes" | "No" | "none", today}.
 * pds.sleep_winddown_set_night writes the chosen habit's pds.habit_journal row (the same row the check-in and
 * /habits write) in one locked transaction: a repeated request is a no-op (no double credit), a stored answer that
 * is not the `expect`ed one refuses (409 changed), a screen from an earlier day refuses (409 stale), and only
 * tonight and the two nights before can be answered here. Owner session only (never in isCiRoute()), same-origin
 * JSON, at most 1 KB. Notion "Last Completed" follows after the response, best effort.
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
  const parsed = parseNightBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const b = parsed.value;

  const { data, error } = await supabase.rpc("sleep_winddown_set_night", { p_night: b.night, p_answer: b.answer, p_expect: b.expect, p_today: b.today });
  if (error) {
    const known = windDownRefusal(error);
    if (known) return NextResponse.json({ error: known.error, code: known.code }, { status: known.status, headers: NO_STORE });
    if (isMissingStorage(error)) return NextResponse.json({ error: "The wind-down streak isn't set up on the server yet.", code: "not_connected" }, { status: 503, headers: NO_STORE });
    console.error("[sleep winddown] night write failed", error.code ?? "unexpected");
    return NextResponse.json({ error: "Not saved. Try again." }, { status: 500, headers: NO_STORE });
  }
  const result = setNightResult(data);
  if (!result) {
    console.error("[sleep winddown] night write: unexpected reply");
    return NextResponse.json({ error: "Not saved. Try again." }, { status: 500, headers: NO_STORE });
  }
  if (result.changed) after(() => mirrorLastCompleted(supabase, result, process.env.NOTION_API_KEY));
  return NextResponse.json({
    night: result.night, answer: result.answer, previous: result.previous, changed: result.changed,
    startedAt: result.startedAt, localTime: result.localTime,
  }, { headers: NO_STORE });
}
