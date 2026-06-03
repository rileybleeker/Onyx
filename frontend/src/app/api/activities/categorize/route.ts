import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

const ALLOWED_SPLITS = new Set(["leg", "pull", "push"]);

/**
 * POST /api/activities/categorize
 * Body: { source: "garmin" | "whoop", id: string | number, split_label: "leg" | "pull" | "push" | null }
 *
 * Sets the manual leg/pull/push split label on a strength session. Mirrors
 * /api/activities/exclude: writes split_label directly onto the underlying
 * garmin_activities / whoop_workouts row. The flag isn't in the Garmin/WHOOP ETL
 * upsert payloads, so hourly re-syncs preserve it. Pass split_label:null to clear.
 *
 * Note: whoop_workouts.workout_id is TEXT (not numeric), so the id is matched as
 * a string — do NOT Number() it (would NaN on a non-numeric WHOOP id).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    source?: "garmin" | "whoop";
    id?: number | string;
    split_label?: string | null;
  };

  if (body.source !== "garmin" && body.source !== "whoop") {
    return NextResponse.json({ error: "source must be 'garmin' or 'whoop'" }, { status: 400 });
  }
  if (body.id === undefined || body.id === null || String(body.id).length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const split_label = body.split_label ?? null;
  if (split_label !== null && !ALLOWED_SPLITS.has(split_label)) {
    return NextResponse.json(
      { error: "split_label must be 'leg', 'pull', 'push', or null" },
      { status: 400 },
    );
  }

  const table = body.source === "garmin" ? "garmin_activities" : "whoop_workouts";
  const pk = body.source === "garmin" ? "activity_id" : "workout_id";

  const { data, error } = await supabase
    .from(table)
    .update({ split_label })
    .eq(pk, String(body.id))
    .select(pk)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "activity not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, source: body.source, id: body.id, split_label });
}
