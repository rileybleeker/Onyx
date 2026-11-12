import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseActivityTarget } from "@/lib/activity-tags";

// POST /api/activities/suggest-tags/dismiss
// Body: { source: "garmin" | "whoop", id: string }
//
// Hides the tag suggestion for one activity for good: sets dismissed = true on its
// pds.activity_tag_suggestions row. The page calls it for "Dismiss" and, best-effort, after an
// "Accept" has been saved (so clearing the tags by hand later does not bring the old suggestion
// back). If the activity has no cache row (the cache write failed earlier) a tombstone row with
// empty arrays is stored instead, so the activity is not suggested again either.
//
// The upsert names only the key and `dismissed`, so an existing row keeps its arrays, confidence
// and model. Idempotent. Auth: the normal session middleware.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const target = parseActivityTarget(body);
  if (!target) {
    return NextResponse.json({ error: "source must be 'garmin' or 'whoop' and id must be valid" }, { status: 400 });
  }
  const { error } = await supabase
    .from("activity_tag_suggestions")
    .upsert({ source: target.source, activity_id: target.id, dismissed: true }, { onConflict: "source,activity_id" });
  if (error) {
    console.error("activity_tag_suggestions dismiss failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, source: target.source, id: target.id });
}
