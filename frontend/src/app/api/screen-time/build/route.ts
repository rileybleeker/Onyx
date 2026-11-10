import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const dynamic = "force-dynamic";

/**
 * GET /api/screen-time/build
 *
 * The newest signed build of the Onyx Screen Time iPhone app, as published by
 * .github/workflows/screentime-ios.yml (tools/screentime_ios/ci/publish_build.py)
 * to the PRIVATE storage bucket `ios-builds`. The repo is public, so the
 * install links never go into workflow logs or artifacts — this session-only
 * route (normal middleware auth, no CI-token carve-out) is the one place they
 * are readable. Consumed by the /install page.
 *
 * { build: null } = nothing published yet.
 */
export async function GET() {
  const { data, error } = await supabase.storage.from("ios-builds").download("screentime/latest.json");
  if (error || !data) {
    return NextResponse.json(
      { build: null, reason: error?.message ?? "No build published yet" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const build = JSON.parse(await data.text());
    return NextResponse.json({ build }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ build: null, reason: "latest.json is not valid JSON" }, { status: 500 });
  }
}
