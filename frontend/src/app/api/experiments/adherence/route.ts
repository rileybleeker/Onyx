import { NextRequest, NextResponse } from "next/server";
import { checkPortionRequest } from "@/lib/delivery-portion";
import { parseAdherenceRequest } from "@/lib/experiments";
import { loadAdherenceDay, recordAdherence } from "@/lib/experiments-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// An answer, a note of at most 500 characters (up to 4 bytes each in UTF-8) and the JSON around them.
const MAX_BODY_BYTES = 4096;

/**
 * GET  /api/experiments/adherence[?date=YYYY-MM-DD]
 * POST /api/experiments/adherence   { date?: "YYYY-MM-DD", answer: "yes" | "partly" | "no", note?: string }
 *
 * The check-in question of a running N-of-1 trial, "Followed today's arm?"
 * (docs/experiment-framework.md 4.5). The database answers for the behavioral today (no date) or
 * the day before, only while a trial runs, and only for a day whose arm Today has already shown:
 * { status: "open", arm, instruction, answer, note, ... }, "not_revealed" (open Today first), "none"
 * (no trial, the usual case) or "not_connected" (sql/experiment_adherence_reports_schema.sql not
 * applied). GET writes and stamps nothing. POST saves the answer, or answers 409 with the day's state
 * when there is nothing to answer.
 *
 * Owner session only: this path is deliberately NOT in isCiRoute() (middleware.ts), so the CI token
 * cannot read an arm or answer for Riley. POST also requires a same-origin JSON request (CSRF).
 */
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (date !== null && !DAY.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await loadAdherenceDay(date), { headers: NO_STORE });
  } catch (e) {
    // The message holds an error code at most; the answer itself is never logged.
    console.error("experiments/adherence GET failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "The trial question is unavailable" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400, headers: NO_STORE });
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseAdherenceRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  try {
    const state = await recordAdherence(parsed.value);
    if (state.status !== "open") {
      return NextResponse.json({ error: "There is no trial question to answer for this day.", state }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json(state, { headers: NO_STORE });
  } catch (e) {
    console.error("experiments/adherence POST failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "Couldn't save the answer. Try again." }, { status: 500, headers: NO_STORE });
  }
}
