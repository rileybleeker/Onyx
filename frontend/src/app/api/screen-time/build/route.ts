import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BUILD_VARIANTS, resolveBuildVariant } from "@/lib/install-builds";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const dynamic = "force-dynamic";

/**
 * GET /api/screen-time/build[?variant=focus]
 *
 * The newest signed build of the Onyx iPhone app, as published by
 * tools/screentime_ios/ci/publish_build.py to the PRIVATE storage bucket
 * `ios-builds`:
 *   (no variant)     screentime/latest.json, from .github/workflows/screentime-ios.yml
 *   ?variant=focus   screentime-focus/latest.json, from .github/workflows/focus-ios-signed.yml
 * Any other variant value is a 400. The repo is public, so the install links
 * never go into workflow logs or artifacts — this session-only route (normal
 * middleware auth, no CI-token carve-out) is the one place they are readable.
 * Consumed by the /install page.
 *
 * { build: null } = nothing published yet.
 */
export async function GET(req: NextRequest) {
  const variant = resolveBuildVariant(req.nextUrl.searchParams.get("variant"));
  if (!variant) {
    return NextResponse.json(
      { build: null, reason: "Unknown variant (omit it, or use variant=focus)" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { data, error } = await supabase.storage.from("ios-builds").download(BUILD_VARIANTS[variant].path);
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
