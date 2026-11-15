import { NextRequest, NextResponse } from "next/server";
import { sameToken } from "@/lib/care-google";
import { googleConfig, syncCareCalendar } from "@/lib/care-google-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * POST /api/jobs/care-calendar-catch-up: the scheduled catch-up for the Google Calendar WRITE side
 * (care items -> the "Onyx care" calendar). A GitHub Actions schedule calls it every 6 hours with
 * the x-onyx-ci-token header. It runs exactly the sync that "Sync now" and every care-item save
 * run (syncCareCalendar in lib/care-google-server.ts): an item whose event is already right costs
 * no Google call, so a run with nothing to do is one token refresh. What it adds is a retry for a
 * sync that failed after a change (Google down, a timeout), and a fresh last_sync_at for the
 * /status Care Calendar card.
 *
 * Auth: the CI token, checked here as well as in middleware, so an owner session alone (a browser)
 * cannot trigger it. Reaching it from the schedule needs this ONE exact path in middleware's
 * isCiRoute(); until that line exists the schedule is turned away at the middleware and nothing
 * runs. The care routes themselves stay owner-session only.
 *
 * Answers counts and a short code only (never a token, never an item's label):
 *   200 {ran: false, reason: "not_set_up" | "not_connected"}   nothing to do; Google not called
 *   200 {ran: true, sync: {at, ok: true, created, updated, removed, unchanged, failed, error}}
 *   502 {ran: true, sync: {..., ok: false, error: "<code>"}}   the run failed; /status shows it red
 *   401 {error: "unauthorized"}                                 no or wrong CI token
 */
export async function POST(req: NextRequest) {
  const expected = process.env.ONYX_CI_TOKEN;
  const provided = req.headers.get("x-onyx-ci-token");
  if (!expected || !provided || !sameToken(provided, expected)) return answer({ error: "unauthorized" }, 401);
  if (!googleConfig()) return answer({ ran: false, reason: "not_set_up" });
  const sync = await syncCareCalendar();
  if (!sync) return answer({ ran: false, reason: "not_connected" });
  return answer({ ran: true, sync }, sync.ok ? 200 : 502);
}
