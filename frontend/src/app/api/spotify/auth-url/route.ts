import { NextRequest, NextResponse } from "next/server";
import { RECONNECT_ERRORS, buildAuthorizeUrl, checkAuthUrlRequest, newState, stateCookieHeader, type ReconnectErrorCode } from "@/lib/spotify-reconnect";

export const dynamic = "force-dynamic";

// GET /api/spotify/auth-url
// Step 1 of the Spotify reconnect on /status (see lib/spotify-reconnect.ts). Owner session only:
// normal middleware auth, deliberately NOT in isCiRoute() - this flow mints and stores OAuth
// credentials, so the shared CI token must never reach it.
// Answers {url}: Spotify's authorize link for the Onyx app with a fresh state. The same state is
// set in an httpOnly cookie (10 minutes, Path=/api/spotify) and checked by POST /api/spotify/exchange.
// The link holds the client id (public by design) and never the client secret.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, code: ReconnectErrorCode) {
  return NextResponse.json({ ok: false, code, error: RECONNECT_ERRORS[code] }, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const refused = checkAuthUrlRequest(req.headers);
  if (refused) return fail(refused.status, refused.error);

  // Both are needed to finish (the exchange uses the secret), so say so before the owner signs in.
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId || !process.env.SPOTIFY_CLIENT_SECRET) return fail(500, "not_configured");

  const state = newState();
  return NextResponse.json(
    { ok: true, url: buildAuthorizeUrl(clientId, state) },
    { headers: { ...NO_STORE, "Set-Cookie": stateCookieHeader(state) } },
  );
}
