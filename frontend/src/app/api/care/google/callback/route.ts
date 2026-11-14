import { NextRequest, NextResponse } from "next/server";
import { CALLBACK_PATH, OAUTH_COOKIE, parseOauthCookie, sameToken } from "@/lib/care-google";
import { completeConnection, googleConfig, syncAfterWrite } from "@/lib/care-google-server";

export const dynamic = "force-dynamic";

// GET /api/care/google/callback: where Google sends Riley back after the consent page. Owner
// session only (middleware: without the Onyx login this never runs). Always answers with a
// redirect to /health?calendar=connected|denied|error (+ a short reason code), and always
// clears the sign-in cookie.
//
// Nothing is sent to Google unless the `state` in the URL equals the one in the cookie set by
// /api/care/google/start in this same browser. That ties the code to Riley's own Connect press.
export async function GET(req: NextRequest) {
  const back = (result: "connected" | "denied" | "error", reason?: string) => {
    const url = new URL("/health", req.nextUrl.origin);
    url.searchParams.set("calendar", result);
    if (reason) url.searchParams.set("reason", reason.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60));
    const res = NextResponse.redirect(url);
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(OAUTH_COOKIE, "", { httpOnly: true, secure: req.nextUrl.protocol === "https:", sameSite: "lax", path: CALLBACK_PATH, maxAge: 0 });
    return res;
  };

  if (!googleConfig()) return back("error", "not_configured");
  const pending = parseOauthCookie(req.cookies.get(OAUTH_COOKIE)?.value);
  if (!pending) return back("error", "no_pending_sign_in");
  const q = req.nextUrl.searchParams;
  const state = q.get("state");
  if (!state || !sameToken(state, pending.state)) return back("error", "state_mismatch");
  if (q.get("error")) return back("denied"); // Riley pressed Cancel on Google's page
  const code = q.get("code");
  if (!code || code.length > 2048) return back("error", "no_code");

  const done = await completeConnection({ code, verifier: pending.verifier, redirectUri: `${req.nextUrl.origin}${CALLBACK_PATH}` });
  if (!done.ok) {
    console.error("care calendar connect failed:", done.code);
    return back("error", done.code);
  }
  syncAfterWrite(); // first sync, after the redirect has gone out
  return back("connected");
}
