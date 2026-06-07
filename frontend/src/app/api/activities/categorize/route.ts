import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

// Canonical allowed values — must stay in sync with the DB CHECK constraints
// (sql/activity_muscle_groups.sql) and the frontend pill sets (/activities page).
const ALLOWED_SPLITS = new Set(["leg", "pull", "push"]);
const ALLOWED_MUSCLES = new Set([
  "chest", "back", "shoulders", "biceps", "triceps", "forearms",
  "quads", "hamstrings", "glutes", "calves", "core",
]);

/**
 * POST /api/activities/categorize
 * Body: {
 *   source: "garmin" | "whoop",
 *   id: string | number,
 *   split_labels?: string[],   // multi-select coarse split (⊆ leg/pull/push)
 *   muscle_groups?: string[],  // multi-select granular muscles (⊆ ALLOWED_MUSCLES)
 *   split_label?: string | null // legacy single-value form — accepted for BC
 * }
 *
 * Sets the manual strength tags on a workout. Mirrors /api/activities/exclude:
 * writes directly onto the underlying garmin_activities / whoop_workouts row.
 * Neither array is in the Garmin/WHOOP ETL upsert payloads, so hourly re-syncs
 * preserve them. The full array is sent on every save (idempotent set, not a diff);
 * an empty array clears the dimension (stored as NULL).
 *
 * split_labels is canonical; the legacy scalar split_label column is kept in sync
 * as split_labels[0] (primary split) so un-migrated readers + rollbacks stay safe.
 *
 * Note: whoop_workouts.workout_id is TEXT (not numeric), so the id is matched as a
 * string — do NOT Number() it (would NaN on a non-numeric WHOOP id).
 */

// Validate, lowercase, and de-duplicate an incoming tag array against an allow-set.
// Returns null on a non-array input; throws a string on an invalid element.
function cleanTags(input: unknown, allowed: Set<string>): string[] | null {
  if (input === undefined) return null;
  if (input === null) return [];
  if (!Array.isArray(input)) throw "must be an array";
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") throw "elements must be strings";
    const v = raw.toLowerCase();
    if (!allowed.has(v)) throw `invalid value '${raw}'`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    source?: "garmin" | "whoop";
    id?: number | string;
    split_labels?: unknown;
    muscle_groups?: unknown;
    split_label?: string | null;
  };

  if (body.source !== "garmin" && body.source !== "whoop") {
    return NextResponse.json({ error: "source must be 'garmin' or 'whoop'" }, { status: 400 });
  }
  if (body.id === undefined || body.id === null || String(body.id).length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Resolve split tags: prefer the array form; fall back to the legacy scalar.
  let splits: string[] | null;
  let muscles: string[] | null;
  try {
    splits = cleanTags(body.split_labels, ALLOWED_SPLITS);
    if (splits === null && body.split_label !== undefined) {
      splits = body.split_label ? cleanTags([body.split_label], ALLOWED_SPLITS) : [];
    }
    muscles = cleanTags(body.muscle_groups, ALLOWED_MUSCLES);
  } catch (msg) {
    return NextResponse.json({ error: `tag validation failed: ${msg}` }, { status: 400 });
  }

  if (splits === null && muscles === null) {
    return NextResponse.json(
      { error: "provide split_labels and/or muscle_groups (arrays)" },
      { status: 400 },
    );
  }

  // Build the patch — only touch dimensions that were provided. Empty array → NULL.
  const patch: Record<string, unknown> = {};
  if (splits !== null) {
    patch.split_labels = splits.length ? splits : null;
    patch.split_label = splits.length ? splits[0] : null; // legacy mirror = primary split
  }
  if (muscles !== null) {
    patch.muscle_groups = muscles.length ? muscles : null;
  }

  const table = body.source === "garmin" ? "garmin_activities" : "whoop_workouts";
  const pk = body.source === "garmin" ? "activity_id" : "workout_id";

  const { data, error } = await supabase
    .from(table)
    .update(patch)
    .eq(pk, String(body.id))
    .select("split_labels, muscle_groups, split_label")
    // maybeSingle (not single): a zero-match UPDATE returns {data:null,error:null}
    // so the 404 below is reachable — single() would surface a cryptic PGRST116 500.
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "activity not found" }, { status: 404 });
  }
  // Echo the PERSISTED row, not the request locals — so an un-patched dimension
  // reflects its real stored value instead of a misleading null on partial updates.
  return NextResponse.json({
    ok: true,
    source: body.source,
    id: body.id,
    split_labels: data.split_labels ?? [],
    muscle_groups: data.muscle_groups ?? [],
    split_label: data.split_label ?? null,
  });
}
