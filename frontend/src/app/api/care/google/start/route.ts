import { NextRequest } from "next/server";
import { CALLBACK_PATH, OAUTH_COOKIE, OAUTH_COOKIE_SECONDS, buildAuthUrl, oauthCookieValue, pkceChallenge, randomToken } from "@/lib/care-google";
import { googleConfig } from "@/lib/care-google-server";
import { careJson, readCareBody } from "@/lib/care-items-server";

export const dynamic = "force-dynamic";

// POST /api/care/google/start: Riley pressed "Connect Google Calendar". Owner session only
// (middleware), same origin. Answers {url}: Google's consent page for the ONE scope
// (calendar.app.created), with a fresh state and PKCE challenge. The state and the PKCE
// verifier go into a short-lived httpOnly cookie that only the callback path receives.
// Makes no call to Google itself. 409 when the Google credentials are not set up.
export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, null);
  if (!read.ok) return read.response;
  const config = googleConfig();
  if (!config) return careJson({ error: "not_configured" }, 409);

  const state = randomToken(32);
  const verifier = randomToken(48);
  const url = buildAuthUrl({
    clientId: config.clientId,
    redirectUri: `${req.nextUrl.origin}${CALLBACK_PATH}`,
    state,
    challenge: await pkceChallenge(verifier),
  });
  const res = careJson({ url });
  res.cookies.set(OAUTH_COOKIE, oauthCookieValue(state, verifier), {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax", // sent on the top-level redirect back from Google, not on cross-site subrequests
    path: CALLBACK_PATH,
    maxAge: OAUTH_COOKIE_SECONDS,
  });
  return res;
}
