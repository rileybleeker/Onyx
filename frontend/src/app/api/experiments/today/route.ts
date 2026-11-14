import { NextResponse } from "next/server";
import { loadExperimentToday } from "@/lib/experiments-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/experiments/today
 * Today's arm of the running N-of-1 trial, for the Today card (docs/experiment-framework.md 4.4):
 * { status: "active", arm, instruction, dayNumber, nDays, ... }, or "none" when no trial is
 * registered (the usual case), "upcoming" before its first day, "paused", or "not_connected"
 * until sql/experiment_framework_schema.sql is applied.
 *
 * Owner session only: this path is deliberately NOT in isCiRoute() (middleware.ts), so the CI
 * token cannot read an arm. It can only ever return the current behavioral day's arm. There is
 * no POST: a trial is created and started with experiment_admin.py, never from the app.
 */
export async function GET() {
  try {
    return NextResponse.json(await loadExperimentToday(), { headers: NO_STORE });
  } catch (e) {
    // The message holds an error code at most; the answer itself is never logged.
    console.error("experiments/today failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "Experiment arm is unavailable" }, { status: 500, headers: NO_STORE });
  }
}
