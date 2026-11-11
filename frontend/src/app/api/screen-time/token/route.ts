import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/screen-time/token
 *
 * Hands the Onyx CI token (ONYX_CI_TOKEN) to the logged-in user so the /install
 * page can copy it to the iPhone clipboard for the Screen Time app's one-time
 * setup — without the token travelling through email, chat or notes.
 * Session-only: normal middleware auth, deliberately NOT in isCiRoute()
 * (the token must never unlock the route that reveals it).
 */
export async function GET() {
  const token = process.env.ONYX_CI_TOKEN;
  if (!token) return NextResponse.json({ error: "ONYX_CI_TOKEN is not set" }, { status: 500 });
  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
