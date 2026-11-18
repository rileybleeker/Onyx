import { NextResponse, type NextRequest } from "next/server";
import { needsTrustStep, parseHello } from "@/lib/iphone-update";
import { recordHello } from "@/lib/iphone-update-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/screen-time/latest-build  { variant: "default" | "focus", app_version, build }
 *
 * The Onyx iPhone app's hello on every open. It is the 3rd EXACT-path CI-token route the app uses (after
 * /api/screen-time/usage and /api/apple-health/import; middleware isCiRoute(): never widen it to a prefix).
 * It records the installed version in pds.iphone_app_installs and answers
 * { version, build, install_url, needs_trust } for the ONE build to install (the Focus build when published, else
 * the Screen Time build). install_url is the same time-limited signed itms-services link /install shows the owner;
 * needs_trust is true only when that build is signed with a different certificate than the installed one (the one
 * case where iOS asks for a trust step in Settings). Both are null / false when nothing is published.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const hello = parseHello(body);
  if (!hello) return NextResponse.json({ error: "bad hello" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const latest = await recordHello(hello);
  if (latest === "error") return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    {
      version: latest?.version ?? null,
      build: latest?.build ?? null,
      install_url: latest?.installUrl ?? null,
      needs_trust: needsTrustStep({ version: hello.app_version, build: hello.build }, latest?.signingSince ?? null),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
