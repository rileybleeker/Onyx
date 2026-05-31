import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/activities/exclude
 * Body: { source: "garmin" | "whoop", id: number, excluded?: boolean }
 *
 * Soft-deletes an activity by setting is_excluded=true on the row. Hourly
 * Garmin/WHOOP ETLs preserve the flag because is_excluded isn't in their
 * upsert payload — so a re-sync won't resurrect the row. Pass excluded=false
 * to restore.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    source?: "garmin" | "whoop";
    id?: number | string;
    excluded?: boolean;
  };
  if (body.source !== "garmin" && body.source !== "whoop") {
    return NextResponse.json({ error: "source must be 'garmin' or 'whoop'" }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "id must be a number" }, { status: 400 });
  }
  const excluded = body.excluded ?? true;

  const table = body.source === "garmin" ? "garmin_activities" : "whoop_workouts";
  const pk = body.source === "garmin" ? "activity_id" : "workout_id";

  const { data, error } = await supabase
    .from(table)
    .update({ is_excluded: excluded })
    .eq(pk, id)
    .select(pk)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "activity not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, source: body.source, id, excluded });
}
