import { NextRequest, NextResponse } from "next/server";
import {
  MAX_EXCHANGE_BODY_BYTES,
  RECONNECT_ERRORS,
  buildTokenBlob,
  checkExchangeRequest,
  checkState,
  clearStateCookieHeader,
  hasRequiredScopes,
  parseExchangeBody,
  readStateCookie,
  reconnectByDate,
  type ReconnectErrorCode,
} from "@/lib/spotify-reconnect";
import { exchangeAuthorizationCode, probeRecentlyPlayed, storeSpotifyTokens } from "@/lib/spotify-server";

export const dynamic = "force-dynamic";

// POST /api/spotify/exchange   body {"callback": "<the pasted address, or the bare code>"}
// Step 2 of the Spotify reconnect on /status (see lib/spotify-reconnect.ts). Owner session only:
// normal middleware auth, deliberately NOT in isCiRoute().
// Order: same-origin + JSON + size checks -> parse the pasted text -> state against the httpOnly
// cookie (the cookie is cleared from here on: one attempt per authorize link) -> exchange the code
// server-side -> require a refresh token and both scopes -> one recently-played call with the new
// token -> store the blob in pds.ci_tokens. Nothing is stored unless every step passed, so a wrong
// account or a half-finished attempt never replaces a working token.
// One exception to "cleared from here on": when Spotify's token endpoint did not answer (network
// error or 5xx) the cookie is kept, because the answer tells the owner to press Finish again and
// that only works while the cookie is there. The state was already checked, the cookie still ends
// after its 10 minutes, and a code Spotify did consume is refused on the retry (code_rejected).
// The answer is {ok, authorized_at, reconnect_by} or {ok:false, code, error} with a fixed message.
// It never carries a token, the client secret, the code or Spotify's own response.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, code: ReconnectErrorCode, clearCookie = false) {
  const headers: Record<string, string> = clearCookie ? { ...NO_STORE, "Set-Cookie": clearStateCookieHeader() } : NO_STORE;
  return NextResponse.json({ ok: false, code, error: RECONNECT_ERRORS[code] }, { status, headers });
}

export async function POST(req: NextRequest) {
  const refused = checkExchangeRequest(req.headers, req.nextUrl.origin);
  if (refused) return fail(refused.status, refused.error);

  let text: string;
  try {
    text = await req.text();
  } catch {
    return fail(400, "bad_body");
  }
  if (new TextEncoder().encode(text).length > MAX_EXCHANGE_BODY_BYTES) return fail(413, "body_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "bad_body");
  }
  const parsed = parseExchangeBody(body);
  // A paste that is not a callback at all leaves the cookie alone, so the right address can still be pasted.
  if (!parsed.ok) return fail(400, parsed.error);

  const stateError = checkState(readStateCookie(req.headers.get("cookie")), parsed.state);
  if (stateError) return fail(400, stateError, true);

  const exchanged = await exchangeAuthorizationCode(parsed.code);
  if (!exchanged.ok) {
    const status = exchanged.reason === "not_configured" ? 500 : exchanged.reason === "code_rejected" ? 400 : 502;
    return fail(status, exchanged.reason, exchanged.reason !== "spotify_unavailable");
  }

  const blob = buildTokenBlob(exchanged.token, Date.now() / 1000);
  if (!blob) return fail(502, "bad_token_response", true);
  if (!hasRequiredScopes(blob.scope)) return fail(400, "missing_scope", true);

  const probe = await probeRecentlyPlayed(blob.access_token);
  if (probe === "forbidden") return fail(403, "wrong_account", true);
  if (probe !== "ok") return fail(502, "probe_failed", true);

  if (!(await storeSpotifyTokens(blob))) return fail(500, "store_failed", true);

  const authorizedAt = blob.authorized_at as number;
  return NextResponse.json(
    { ok: true, authorized_at: authorizedAt, reconnect_by: reconnectByDate(authorizedAt) },
    { headers: { ...NO_STORE, "Set-Cookie": clearStateCookieHeader() } },
  );
}
