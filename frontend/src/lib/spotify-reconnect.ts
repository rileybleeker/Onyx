/**
 * Spotify reconnect: the pure pieces (no I/O, no secrets, safe to import in client code).
 *
 * Why this exists: since 2026-07-20 Spotify expires a refresh token 180 days after the user
 * authorized the app, however often it is refreshed. When that happens the hourly ETL and the
 * playlist tools stop until the owner authorizes again. The flow, driven from the Spotify card
 * on /status:
 *   1. GET  /api/spotify/auth-url  -> the authorize link + a state held in an httpOnly cookie
 *   2. Spotify redirects the new tab to SPOTIFY_REDIRECT_URI. Nothing listens there, so the tab
 *      shows a "could not connect" page whose address carries ?code=...&state=...
 *   3. the owner pastes that address into the card -> POST /api/spotify/exchange, which checks
 *      the state against the cookie, exchanges the code server-side, probes the new token and
 *      stores it in pds.ci_tokens (the same row the Python ETL reads).
 *
 * The token blob stored in pds.ci_tokens.token_data is TEXT holding JSON.stringify(blob, null, 2)
 * with exactly the keys of SpotifyTokenBlob below; spotify_etl.py reads the same keys.
 */

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";

/**
 * The ONE redirect URI, used for both the authorize link and the code exchange (Spotify requires
 * the two to be byte-identical and registered on the app). It is the address spotify_etl.py --auth
 * has always used. Never read it from the environment: a differing value breaks the exchange.
 */
export const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/callback";

/** Same scopes as SPOTIFY_SCOPES in spotify_etl.py. */
export const SPOTIFY_SCOPES = "user-read-recently-played playlist-modify-private";

/** Spotify's refresh-token lifetime, counted from the authorization (not from the last refresh). */
export const REFRESH_TOKEN_LIFETIME_DAYS = 180;
/** /status starts warning on this day after the authorization. */
export const RECONNECT_WARNING_DAY = 165;

export const STATE_COOKIE = "onyx_spotify_oauth_state";
export const STATE_COOKIE_PATH = "/api/spotify";
export const STATE_COOKIE_MAX_AGE_SECONDS = 600;

export const MAX_EXCHANGE_BODY_BYTES = 4096;
export const MAX_CODE_CHARS = 2048;
export const MAX_STATE_CHARS = 128;

/** The state is made here (newState), so its alphabet is known exactly. */
const STATE_CHARS = /^[A-Za-z0-9_-]+$/;
/**
 * Spotify does not document the alphabet of an authorization code, so this only refuses what a
 * code can never be: spaces, control characters and non-ASCII. The code is never echoed or logged;
 * it is only sent form-encoded to Spotify's token endpoint, which is the real judge of it.
 */
const CODE_CHARS = /^[!-~]+$/;
const DAY_SECONDS = 86_400;

export interface SpotifyTokenBlob {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  /** Epoch seconds of the last access-token refresh. */
  obtained_at: number;
  /** Epoch seconds of the authorization this refresh token came from. Absent on tokens minted before 2026-11-13. */
  authorized_at?: number;
}

// ---------------------------------------------------------------------------
// Fixed messages. Routes answer with a code + its message from this table and
// nothing else: never a token, the client secret, the code or Spotify's raw body.
// ---------------------------------------------------------------------------

export const RECONNECT_ERRORS = {
  missing_origin: "Request refused: no Origin header.",
  cross_origin: "Request refused: it did not come from this site.",
  bad_content_type: "Content-Type must be application/json.",
  body_too_large: "That is too long to be a Spotify callback address.",
  bad_body: "Send the pasted address as JSON: {\"callback\": \"...\"}.",
  empty_input: "Paste the address of the page that failed to load.",
  not_callback_address: "That is not the Spotify callback address. It starts with http://127.0.0.1:8888/callback?code=",
  spotify_denied: "Spotify did not authorize the app (the request was declined). Start again.",
  missing_code: "That address has no code in it. Copy the whole address from the tab that failed to load.",
  bad_code: "The code in that address is not a valid Spotify code. Copy the whole address again.",
  bad_state: "The state in that address is not valid. Start again.",
  no_state_cookie: "This reconnect was not started in this browser in the last 10 minutes. Start again.",
  state_mismatch: "That address belongs to a different reconnect attempt. Start again.",
  not_configured: "Spotify is not configured on the server (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).",
  code_rejected: "Spotify rejected the code: it expired or was already used. Start again.",
  spotify_unavailable: "Spotify did not answer. Press Finish again in a minute.",
  bad_token_response: "Spotify answered without a usable token. Start again.",
  missing_scope: "Spotify did not grant both permissions Onyx needs. Start again and approve them.",
  wrong_account: "This Spotify account cannot read listening history for the Onyx app. Nothing was changed.",
  probe_failed: "The new token could not be checked against Spotify. Nothing was changed. Start again.",
  store_failed: "The new token could not be saved. Nothing was changed. Start again.",
} as const;

export type ReconnectErrorCode = keyof typeof RECONNECT_ERRORS;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Constant-time string comparison (no early exit on the first differing character). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidState(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= MAX_STATE_CHARS && STATE_CHARS.test(value);
}

export function isValidCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CODE_CHARS && CODE_CHARS.test(value);
}

/** 32 random bytes, base64url (43 characters). */
export function newState(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Authorize link
// ---------------------------------------------------------------------------

/** The authorize link. Holds the client id (public by design), the state, the scopes and the redirect; no secret. */
export function buildAuthorizeUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    state,
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// The pasted text
// ---------------------------------------------------------------------------

export type CallbackParse =
  | { ok: true; code: string; state: string | null }
  | { ok: false; error: ReconnectErrorCode };

function single(params: URLSearchParams, name: string): string | null | undefined {
  const all = params.getAll(name);
  if (all.length > 1) return undefined; // repeated parameter: refuse rather than pick one
  return all.length === 1 ? all[0] : null;
}

function fromParams(params: URLSearchParams): CallbackParse {
  if (params.has("error")) return { ok: false, error: "spotify_denied" };
  const code = single(params, "code");
  if (code === undefined) return { ok: false, error: "bad_code" };
  if (code === null || code === "") return { ok: false, error: "missing_code" };
  if (!isValidCode(code)) return { ok: false, error: "bad_code" };
  const state = single(params, "state");
  if (state === undefined) return { ok: false, error: "bad_state" };
  if (state === null || state === "" || !isValidState(state)) return { ok: false, error: "bad_state" };
  return { ok: true, code, state };
}

/**
 * Reads what the owner pasted. Accepted forms:
 *   - the full address of the tab that failed to load
 *       http://127.0.0.1:8888/callback?code=...&state=...
 *     also without the "http://" some address bars hide;
 *   - the query alone:  ?code=...&state=...  or  code=...&state=...
 *   - the bare code, with nothing else around it.
 * Every form that names its parameters must carry the state, so cutting "&state=..." (or the
 * address in front of "code=") off a paste never gets around the state check. The bare code is the
 * one form with no state to compare; the exchange route then relies on the state cookie being
 * present plus the account probe.
 * An address on any other host or path is refused: it is not this flow's callback.
 */
export function parseCallbackInput(input: unknown): CallbackParse {
  if (typeof input !== "string") return { ok: false, error: "empty_input" };
  const text = input.trim();
  if (!text) return { ok: false, error: "empty_input" };
  if (text.length > MAX_EXCHANGE_BODY_BYTES) return { ok: false, error: "body_too_large" };
  if (/\s/.test(text)) return { ok: false, error: "not_callback_address" };

  const bareRedirect = SPOTIFY_REDIRECT_URI.replace(/^http:\/\//, "");
  const asUrl = /^https?:\/\//i.test(text) ? text : text.startsWith(bareRedirect) ? `http://${text}` : null;
  if (asUrl) {
    let u: URL;
    try {
      u = new URL(asUrl);
    } catch {
      return { ok: false, error: "not_callback_address" };
    }
    if (`${u.origin}${u.pathname}` !== SPOTIFY_REDIRECT_URI || u.username || u.password) {
      return { ok: false, error: "not_callback_address" };
    }
    return fromParams(u.searchParams);
  }

  // The query alone. (A bare code may itself contain "=", so this needs a parameter name.)
  if (/(?:^|[?&#])(?:code|state|error)=/.test(text)) {
    const query = text.replace(/^[?#]/, "");
    const params = new URLSearchParams(query);
    if (!params.has("code") && !params.has("error")) return { ok: false, error: "missing_code" };
    return fromParams(params);
  }

  return isValidCode(text) ? { ok: true, code: text, state: null } : { ok: false, error: "bad_code" };
}

/** Body of POST /api/spotify/exchange: {"callback": "<pasted text>"} and nothing else. */
export function parseExchangeBody(body: unknown): CallbackParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "callback") return { ok: false, error: "bad_body" };
  const value = (body as { callback: unknown }).callback;
  if (typeof value !== "string") return { ok: false, error: "bad_body" };
  return parseCallbackInput(value);
}

// ---------------------------------------------------------------------------
// Request checks
// ---------------------------------------------------------------------------

type HeaderGetter = { get(name: string): string | null };

/**
 * Checks for POST /api/spotify/exchange before the body is read. The route is owner-session only
 * (middleware); this adds a same-origin check (a browser always sends Origin on a POST, so a missing
 * one is refused), a JSON content type and a small declared size. Returns null when it may proceed.
 */
export function checkExchangeRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: ReconnectErrorCode } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing_origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "cross_origin" };
  }
  // The host the browser addressed: Vercel's proxy sets x-forwarded-host; locally it is Host.
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross_origin" };
  if (headers.get("sec-fetch-site") && headers.get("sec-fetch-site") !== "same-origin") {
    return { status: 403, error: "cross_origin" };
  }

  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "bad_content_type" };

  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_EXCHANGE_BODY_BYTES)) {
    return { status: 413, error: "body_too_large" };
  }
  return null;
}

/**
 * Check for GET /api/spotify/auth-url. A same-origin GET carries no Origin header, so this reads
 * Sec-Fetch-Site (sent by every current browser): a request another site caused is refused, so it
 * cannot replace the state cookie of a reconnect in progress. Returns null when it may proceed.
 */
export function checkAuthUrlRequest(headers: HeaderGetter): { status: number; error: ReconnectErrorCode } | null {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { status: 403, error: "cross_origin" };
  return null;
}

// ---------------------------------------------------------------------------
// State cookie
// ---------------------------------------------------------------------------

const COOKIE_ATTRS = `Path=${STATE_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

export function stateCookieHeader(state: string): string {
  return `${STATE_COOKIE}=${state}; Max-Age=${STATE_COOKIE_MAX_AGE_SECONDS}; ${COOKIE_ATTRS}`;
}

export function clearStateCookieHeader(): string {
  return `${STATE_COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`;
}

/** The state cookie's value from a Cookie request header, or null when absent or malformed. */
export function readStateCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== STATE_COOKIE) continue;
    if (found !== null) return null; // sent twice: refuse rather than pick one
    found = part.slice(eq + 1).trim();
  }
  return isValidState(found) ? found : null;
}

/**
 * The state check at exchange time. The callback never reaches Onyx, so the state cannot be checked
 * on the redirect; it is checked here against the cookie set when the authorize link was made.
 *   - no (valid) cookie: refused. The reconnect was not started in this browser, or it is over 10 minutes old.
 *   - the pasted address or query carries a state: it must equal the cookie (constant-time).
 *   - a bare code carries none (parseCallbackInput gives a null state for that form only):
 *     accepted on the cookie alone.
 */
export function checkState(cookieState: string | null, pastedState: string | null): ReconnectErrorCode | null {
  if (!isValidState(cookieState)) return "no_state_cookie";
  if (pastedState === null) return null;
  return safeEqual(cookieState, pastedState) ? null : "state_mismatch";
}

// ---------------------------------------------------------------------------
// Token blob
// ---------------------------------------------------------------------------

/** True when every scope Onyx needs was granted. Spotify returns them in its own order. */
export function hasRequiredScopes(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return SPOTIFY_SCOPES.split(" ").every((s) => granted.has(s));
}

/**
 * Turns Spotify's authorization_code token response into the blob stored in pds.ci_tokens:
 * exactly the existing keys plus authorized_at. Returns null when the response is not usable
 * (no refresh token, no access token).
 */
export function buildTokenBlob(tokenResponse: unknown, nowSec: number): SpotifyTokenBlob | null {
  if (!tokenResponse || typeof tokenResponse !== "object") return null;
  const r = tokenResponse as Record<string, unknown>;
  if (typeof r.access_token !== "string" || !r.access_token) return null;
  if (typeof r.refresh_token !== "string" || !r.refresh_token) return null;
  const expires = Number(r.expires_in);
  const now = Math.floor(nowSec);
  return {
    access_token: r.access_token,
    token_type: typeof r.token_type === "string" && r.token_type ? r.token_type : "Bearer",
    expires_in: Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 3600,
    refresh_token: r.refresh_token,
    scope: typeof r.scope === "string" ? r.scope : "",
    obtained_at: now,
    authorized_at: now,
  };
}

/** The exact text written to pds.ci_tokens.token_data (same as json.dump(tokens, indent=2) in Python). */
export function serializeTokenBlob(blob: SpotifyTokenBlob): string {
  return JSON.stringify(blob, null, 2);
}

function epoch(value: unknown): number {
  const n = Number(value);
  return typeof value === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Newer-wins: may `candidate` replace `stored` in pds.ci_tokens? A later authorization always wins;
 * within one authorization the later refresh wins. Mirrors spotify_upload_decision in
 * ci_token_helper.py. Used by the refresh path so a blob loaded before a reconnect is never written
 * back over the reconnect's token.
 */
export function isNewerBlob(candidate: { authorized_at?: unknown; obtained_at?: unknown }, stored: { authorized_at?: unknown; obtained_at?: unknown }): boolean {
  const ca = epoch(candidate.authorized_at);
  const sa = epoch(stored.authorized_at);
  if (ca !== sa) return ca > sa;
  return epoch(candidate.obtained_at) > epoch(stored.obtained_at);
}

/**
 * Should the refresh path write `candidate` over the stored row? `stored` is the parsed stored blob,
 * or null/undefined/non-object when the row is missing or unreadable (then: write). False when the
 * candidate is not newer (isNewerBlob), and false when the same authorization's refresh token was
 * rotated elsewhere (stored token differs from the one this call loaded) and Spotify returned no new
 * one (candidate still carries the loaded token): writing would put the old token over the rotated one.
 */
export function shouldWriteBack(
  candidate: { authorized_at?: unknown; obtained_at?: unknown; refresh_token?: unknown },
  loadedRefreshToken: string,
  stored: { authorized_at?: unknown; obtained_at?: unknown; refresh_token?: unknown } | null | undefined,
): boolean {
  if (!stored || typeof stored !== "object") return true;
  if (!isNewerBlob(candidate, stored)) return false;
  if (
    epoch(stored.authorized_at) === epoch(candidate.authorized_at) &&
    stored.refresh_token !== loadedRefreshToken &&
    candidate.refresh_token === loadedRefreshToken
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

/**
 * True when the Spotify card's message means "sign in again": the refresh token is dead (expired
 * after 180 days, revoked or otherwise refused), is about to expire, or there is no usable token.
 * Keys on the texts spotify_etl.py writes to its heartbeat ("Spotify refresh token rejected ...",
 * "Spotify sign-in expires in N days ...", "No Spotify tokens at ...", "... holds no refresh
 * token") and on Spotify's invalid_grant. Wrong app credentials (invalid_client) are not a
 * sign-in problem and do not match. tests/test_ci_token_spotify_guard.py checks this pattern
 * against the real Python strings.
 */
export function needsSpotifyReconnect(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return /refresh token (?:was |is |has been )?(?:rejected|expired|revoked)|invalid_grant|sign-in expires|no spotify tokens|holds no refresh token/i.test(errorMessage);
}

/** authorized_at (epoch seconds) from the token_data text, or null when unknown. Reads nothing else. */
export function authorizedAtFromTokenData(tokenData: unknown): number | null {
  if (typeof tokenData !== "string") return null;
  try {
    const parsed = JSON.parse(tokenData) as { authorized_at?: unknown } | null;
    const at = parsed && typeof parsed === "object" ? epoch(parsed.authorized_at) : 0;
    return at > 0 ? Math.floor(at) : null;
  } catch {
    return null;
  }
}

const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The Eastern-time calendar day (YYYY-MM-DD) of an instant. */
export function etDay(ms: number): string {
  return ET_DAY.format(new Date(ms));
}

/** A calendar day moved by whole days: pure date arithmetic, so clock changes cannot shift it. */
export function shiftDay(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/**
 * The last full Eastern-time day on which a reconnect is still in time: the calendar day (ET) on
 * which the refresh token expires, minus one calendar day. YYYY-MM-DD. (Not "expiry minus 24
 * hours": on the 25-hour day the clocks go back that can land on the expiry day itself.)
 * reauth_warning in spotify_etl.py prints the same day in its heartbeat text.
 */
export function reconnectByDate(authorizedAtSec: number): string {
  return shiftDay(etDay((authorizedAtSec + REFRESH_TOKEN_LIFETIME_DAYS * DAY_SECONDS) * 1000), -1);
}

/**
 * The reconnect-by date to show on /status, or null. Null until day 165 after the authorization and
 * when the authorization time is unknown. The date is the only token-derived value that may leave
 * the server through the cacheable /api/status response.
 */
export function spotifyReconnectBy(tokenData: unknown, nowMs: number): string | null {
  const at = authorizedAtFromTokenData(tokenData);
  if (at === null) return null;
  if (nowMs / 1000 < at + RECONNECT_WARNING_DAY * DAY_SECONDS) return null;
  return reconnectByDate(at);
}

/**
 * The warning line on the Spotify card. `reconnectBy` is the last full ET day in time, so the token
 * runs out during the day after it; from then on the line says so instead of naming a past date.
 */
export function reconnectWarningText(reconnectBy: string, nowMs: number): string {
  const today = etDay(nowMs);
  if (today <= reconnectBy) {
    return `Spotify's authorization runs out soon. Reconnect by ${formatReconnectDate(reconnectBy)} to keep the sync running.`;
  }
  if (today === shiftDay(reconnectBy, 1)) return "Spotify's authorization runs out today. Reconnect now to keep the sync running.";
  return "Spotify's authorization has run out. Reconnect to restart the sync.";
}

/** "May 11, 2027" from "2027-05-11". */
export function formatReconnectDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Browser side of the two calls (fetch is passed in, so this stays testable offline)
// ---------------------------------------------------------------------------

export const SESSION_EXPIRED_MESSAGE = "Your Onyx session has expired. Sign in again, then start the reconnect again.";
const GENERIC_FAILURE = "The reconnect did not finish. Start again.";

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; cache?: "no-store" }) => Promise<{
  ok: boolean;
  status: number;
  redirected?: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Reads one of the two routes' answers. A signed-out call to a session-only /api route is answered
 * with a redirect to the login page, which fetch follows to a 200 HTML document: that (and any
 * other non-JSON answer) is reported as an expired session. Error text always comes from
 * RECONNECT_ERRORS by code, never from the response body.
 */
async function readReconnectAnswer(res: Awaited<ReturnType<FetchLike>>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (res.redirected || !type.includes("application/json")) return { ok: false, message: SESSION_EXPIRED_MESSAGE };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: GENERIC_FAILURE };
  }
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (res.ok && b.ok === true) return { ok: true, body: b };
  const code = typeof b.code === "string" ? b.code : "";
  const known = Object.prototype.hasOwnProperty.call(RECONNECT_ERRORS, code) ? RECONNECT_ERRORS[code as ReconnectErrorCode] : null;
  return { ok: false, message: known ?? GENERIC_FAILURE };
}

/** Step 1: asks the server for the authorize link (which also sets the state cookie). */
export async function requestAuthorizeUrl(fetchImpl: FetchLike): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl("/api/spotify/auth-url", { cache: "no-store" });
  } catch {
    return { ok: false, message: "Could not reach Onyx. Check the connection and try again." };
  }
  const answer = await readReconnectAnswer(res);
  if (!answer.ok) return answer;
  const url = answer.body.url;
  // Only ever link to Spotify's own authorize page.
  if (typeof url !== "string" || !url.startsWith(`${SPOTIFY_AUTHORIZE_URL}?`)) return { ok: false, message: GENERIC_FAILURE };
  return { ok: true, url };
}

/** Step 2: sends the pasted text. The server parses it again; the local parse only gives a faster answer. */
export async function submitCallback(fetchImpl: FetchLike, pasted: string): Promise<{ ok: true; reconnectBy: string | null } | { ok: false; message: string }> {
  const local = parseCallbackInput(pasted);
  if (!local.ok) return { ok: false, message: RECONNECT_ERRORS[local.error] };
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl("/api/spotify/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback: pasted.trim() }),
    });
  } catch {
    return { ok: false, message: "Could not reach Onyx. Check the connection and try again." };
  }
  const answer = await readReconnectAnswer(res);
  if (!answer.ok) return answer;
  const by = answer.body.reconnect_by;
  return { ok: true, reconnectBy: typeof by === "string" && /^\d{4}-\d{2}-\d{2}$/.test(by) ? by : null };
}
