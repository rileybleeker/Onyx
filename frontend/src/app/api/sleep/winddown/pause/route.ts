import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { checkPortionRequest } from "@/lib/delivery-portion";
import { MAX_WINDDOWN_BODY_BYTES, isMissingStorage, parsePauseBody, windDownRefusal } from "@/lib/sleep-winddown";
import { readJsonBody } from "@/lib/sleep-winddown-server";

export const dynamic = "force-dynamic";

/**
 * /api/sleep/winddown/pause (PROD-SLEEP-01): planned pauses. Paused nights are labelled and left out of every count.
 * POST  {start_date, end_date | null, today}: a pause from tonight or later (never on a night that passed), not
 *       overlapping another one (pds.sleep_winddown_add_pause).
 * PATCH {pause_id}: Resume. A pause that has not started is cancelled; a running one ends with last night, so
 *       tonight counts again; past nights keep their pause state (pds.sleep_winddown_end_pause + its guard).
 * Owner session only, same-origin JSON, at most 1 KB.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };

async function handle(req: NextRequest, method: "POST" | "PATCH") {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_WINDDOWN_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });
  const read = await readJsonBody(req, MAX_WINDDOWN_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parsePauseBody(read.body, method);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const b = parsed.value;
  const { data, error } = b.action === "add"
    ? await supabase.rpc("sleep_winddown_add_pause", { p_start: b.startDate, p_end: b.endDate, p_today: b.today })
    : await supabase.rpc("sleep_winddown_end_pause", { p_pause_id: b.pauseId });
  if (error) {
    const known = windDownRefusal(error);
    if (known) return NextResponse.json({ error: known.error, code: known.code }, { status: known.status, headers: NO_STORE });
    if (isMissingStorage(error)) return NextResponse.json({ error: "The wind-down streak isn't set up on the server yet.", code: "not_connected" }, { status: 503, headers: NO_STORE });
    console.error("[sleep winddown] pause write failed", error.code ?? "unexpected");
    return NextResponse.json({ error: "Not saved. Try again." }, { status: 500, headers: NO_STORE });
  }
  const p = (data ?? {}) as Record<string, unknown>;
  return NextResponse.json({ pause: { id: p.pause_id, startDate: p.start_date, endDate: p.end_date ?? null, removed: p.removed_at != null } }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  return handle(req, "POST");
}

export async function PATCH(req: NextRequest) {
  return handle(req, "PATCH");
}
