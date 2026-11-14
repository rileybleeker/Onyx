// Offline tests for the Spotify reconnect (2026-11-13): Spotify expires a refresh token 180 days
// after authorization, so /status offers a Reconnect that runs the OAuth code flow through two
// owner-session routes. The real source files are transpiled and run against a fake fetch and a
// fake Supabase client: no network, no database, no credentials. Every value is synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const CLIENT_ID = "synthetic-client-id";
const CLIENT_SECRET = "synthetic-client-secret";
const CODE = "AQD_synthetic-code_0123456789";
const ACCESS = "synthetic-access-token";
const REFRESH = "synthetic-refresh-token";
const ORIGIN = "https://onyx.example";
const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPE_FROM_SPOTIFY = "playlist-modify-private user-read-recently-played"; // Spotify's own order

// ----------------------------------------------------------------------------- fakes

/** Fake supabase-js client: one ci_tokens row, recorded upserts. */
function fakeDb({ stored = null, upsertError = null, readError = null } = {}) {
  const calls = { upserts: [], reads: 0 };
  const from = (table) => {
    const b = {
      select() { return b; },
      eq() { return b; },
      limit() { return b; },
      single() {
        calls.reads++;
        return Promise.resolve(stored === null ? { data: null, error: { code: "PGRST116" } } : { data: { token_data: stored }, error: null });
      },
      upsert(row) {
        calls.upserts.push({ table, row });
        return Promise.resolve({ error: upsertError ? { code: upsertError } : null });
      },
      then(resolve, reject) {
        calls.reads++;
        const res = readError ? { data: null, error: { code: readError } } : { data: stored === null ? [] : [{ token_data: stored }], error: null };
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return b;
  };
  return { client: { from }, calls };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const TOKEN_OK = { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH, scope: SCOPE_FROM_SPOTIFY };

/** Fake global fetch for accounts.spotify.com + api.spotify.com; records every call. */
function fakeSpotify({ token = jsonResponse(200, TOKEN_OK), probe = jsonResponse(200, { items: [] }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://accounts.spotify.com/api/token")) return typeof token === "function" ? token() : token;
    if (String(url).startsWith("https://api.spotify.com/v1/me/player/recently-played")) return typeof probe === "function" ? probe() : probe;
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

let db = fakeDb();
const stubs = {
  "@supabase/supabase-js": { createClient: () => ({ from: (t) => db.client.from(t) }) },
  "next/server": {
    NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, headers: (init && init.headers) || {} }) },
  },
  "@/lib/nyc": { getNycScoutFreshness: async () => ({ lastVerified: null, liveCount: 0 }) },
};

const lib = loadTs("lib/spotify-reconnect.ts", stubs);
const authUrlRoute = loadTs("app/api/spotify/auth-url/route.ts", stubs);
const exchangeRoute = loadTs("app/api/spotify/exchange/route.ts", stubs);
const server = loadTs("lib/spotify-server.ts", stubs);

function headersOf(map) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) };
}

function postReq({ body, cookie, headers = {} }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json", ...headers };
  if (cookie !== undefined) h.cookie = cookie;
  return { headers: headersOf(h), nextUrl: { origin: ORIGIN }, text: async () => text };
}

async function withEnv(fn, { fetchImpl, env = { SPOTIFY_CLIENT_ID: CLIENT_ID, SPOTIFY_CLIENT_SECRET: CLIENT_SECRET } } = {}) {
  const savedFetch = globalThis.fetch;
  const savedErr = console.error;
  const saved = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET };
  const logged = [];
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl || (async () => { throw new Error("no fetch expected"); });
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    globalThis.fetch = savedFetch;
    console.error = savedErr;
    for (const [k, v] of [["SPOTIFY_CLIENT_ID", saved.id], ["SPOTIFY_CLIENT_SECRET", saved.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/** Runs GET auth-url and returns {state, cookie} for a following exchange. */
async function startReconnect() {
  const { result } = await withEnv(() => authUrlRoute.GET({ headers: headersOf({ "sec-fetch-site": "same-origin" }) }));
  assert.equal(result.status, 200);
  const state = new URL(result.body.url).searchParams.get("state");
  const cookie = result.headers["Set-Cookie"].split(";")[0];
  return { state, cookie, res: result };
}

const SECRETS = [CLIENT_SECRET, ACCESS, REFRESH, CODE];
function assertNoSecrets(value, what) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of SECRETS) assert.equal(text.includes(s), false, `${what} must not contain ${s.split("-")[1]} material`);
}

// ----------------------------------------------------------------------------- pure: authorize link

test("authorize link: code flow, the one redirect constant, both scopes, the state, no secret", () => {
  const url = new URL(lib.buildAuthorizeUrl(CLIENT_ID, "s".repeat(43)));
  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(lib.SPOTIFY_REDIRECT_URI, REDIRECT);
  assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), ["playlist-modify-private", "user-read-recently-played"]);
  assert.equal(url.searchParams.get("state"), "s".repeat(43));
  assert.equal(url.searchParams.has("show_dialog"), false);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("scopes are the ones spotify_etl.py asks for", () => {
  const py = fs.readFileSync(path.join(SRC, "..", "..", "spotify_etl.py"), "utf8");
  const m = /SPOTIFY_SCOPES = "([^"]+)"/.exec(py);
  assert.ok(m);
  assert.deepEqual(lib.SPOTIFY_SCOPES.split(" ").sort(), m[1].split(" ").sort());
  assert.ok(py.includes(`"${REDIRECT}"`), "the Python default redirect is the same address");
});

test("newState: 43 url-safe characters, different every time", () => {
  const a = lib.newState();
  const b = lib.newState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(lib.isValidState(a), true);
});

// ----------------------------------------------------------------------------- pure: pasted text

test("pasted text: the full address gives code + state", () => {
  const state = "st".repeat(20);
  assert.deepEqual(lib.parseCallbackInput(`${REDIRECT}?code=${CODE}&state=${state}`), { ok: true, code: CODE, state });
  assert.deepEqual(lib.parseCallbackInput(`  ${REDIRECT}?state=${state}&code=${CODE}\n`), { ok: true, code: CODE, state }, "order and surrounding space do not matter");
  assert.deepEqual(lib.parseCallbackInput(`127.0.0.1:8888/callback?code=${CODE}&state=${state}`), { ok: true, code: CODE, state }, "an address bar that hides http://");
});

test("pasted text: the query alone or the bare code", () => {
  const state = "st".repeat(20);
  assert.deepEqual(lib.parseCallbackInput(`?code=${CODE}&state=${state}`), { ok: true, code: CODE, state });
  assert.deepEqual(lib.parseCallbackInput(`code=${CODE}&state=${state}`), { ok: true, code: CODE, state });
  // Every form that names its parameters must carry the state: cutting "&state=..." (or the address
  // in front of "code=") off a paste must not get around the state check. Only the bare code has none.
  assert.deepEqual(lib.parseCallbackInput(`code=${CODE}`), { ok: false, error: "bad_state" });
  assert.deepEqual(lib.parseCallbackInput(`?code=${CODE}`), { ok: false, error: "bad_state" });
  assert.deepEqual(lib.parseCallbackInput(`code=${CODE}&state=`), { ok: false, error: "bad_state" });
  assert.deepEqual(lib.parseCallbackInput(`${REDIRECT}?code=${CODE}`), { ok: false, error: "bad_state" });
  assert.deepEqual(lib.parseCallbackInput(CODE), { ok: true, code: CODE, state: null });
  // Spotify does not document a code's alphabet: anything printable goes through to Spotify, which decides.
  assert.deepEqual(lib.parseCallbackInput("AQpadded=="), { ok: true, code: "AQpadded==", state: null }, "a bare code with = in it is not a query");
  const odd = "AQ.x~y+z/w";
  assert.deepEqual(lib.parseCallbackInput(odd), { ok: true, code: odd, state: null });
  assert.deepEqual(lib.parseCallbackInput(`${REDIRECT}?code=${encodeURIComponent(odd)}&state=${state}`), { ok: true, code: odd, state });
});

test("pasted text: refused forms, each with a fixed code", () => {
  const state = "st".repeat(20);
  const err = (input) => {
    const r = lib.parseCallbackInput(input);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(input)}`);
    assert.ok(lib.RECONNECT_ERRORS[r.error], `known error code for ${JSON.stringify(input)}`);
    return r.error;
  };
  assert.equal(err(""), "empty_input");
  assert.equal(err("   "), "empty_input");
  assert.equal(err(undefined), "empty_input");
  assert.equal(err(42), "empty_input");
  // another host, port, scheme or path is not this flow's callback
  assert.equal(err(`https://evil.example/callback?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`http://127.0.0.1:9999/callback?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`https://127.0.0.1:8888/callback?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`http://127.0.0.1:8888/other?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`http://127.0.0.1:8888/callback/?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`http://user@127.0.0.1:8888/callback?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`http://127.0.0.1:8888.evil.example/callback?code=${CODE}&state=${state}`), "not_callback_address");
  assert.equal(err(`https://accounts.spotify.com/authorize?client_id=x`), "not_callback_address");
  assert.equal(err(`${REDIRECT}?code=${CODE} extra`), "not_callback_address");
  // Spotify said no
  assert.equal(err(`${REDIRECT}?error=access_denied&state=${state}`), "spotify_denied");
  // a full address must carry its state
  assert.equal(err(`${REDIRECT}?code=${CODE}`), "bad_state");
  assert.equal(err(`${REDIRECT}?code=${CODE}&state=`), "bad_state");
  assert.equal(err(`${REDIRECT}?code=${CODE}&state=short`), "bad_state");
  assert.equal(err(`${REDIRECT}?code=${CODE}&state=${state}&state=${state}`), "bad_state");
  // code problems
  assert.equal(err(`${REDIRECT}?state=${state}`), "missing_code");
  assert.equal(err(`${REDIRECT}?code=&state=${state}`), "missing_code");
  assert.equal(err(`${REDIRECT}?code=has%20space&state=${state}`), "bad_code");
  assert.equal(err(`${REDIRECT}?code=${CODE}&code=${CODE}&state=${state}`), "bad_code");
  assert.equal(err(`${REDIRECT}?code=${"a".repeat(2049)}&state=${state}`), "bad_code");
  assert.equal(err("caf" + String.fromCharCode(233) + "-code"), "bad_code", "non-ASCII");
  assert.equal(err("code" + String.fromCharCode(7) + "bell"), "bad_code", "control character");
  assert.equal(err("two words"), "not_callback_address", "whitespace inside");
  assert.equal(err(`state=${state}`), "missing_code");
  assert.equal(err("a".repeat(5000)), "body_too_large");
});

test("exchange body: exactly {callback: string}", () => {
  assert.equal(lib.parseExchangeBody({ callback: CODE }).ok, true);
  for (const bad of [null, [], "x", 1, {}, { callback: 1 }, { callback: CODE, extra: 1 }, { code: CODE }, { code: CODE, state: "x" }]) {
    assert.deepEqual(lib.parseExchangeBody(bad), { ok: false, error: "bad_body" }, JSON.stringify(bad));
  }
});

// ----------------------------------------------------------------------------- pure: state + cookie

test("state check: cookie required; a pasted state must equal it; a bare code rides on the cookie", () => {
  const a = "a".repeat(43);
  const b = "b".repeat(43);
  assert.equal(lib.checkState(a, a), null);
  assert.equal(lib.checkState(a, b), "state_mismatch");
  assert.equal(lib.checkState(a, a.slice(0, 42) + "b"), "state_mismatch");
  assert.equal(lib.checkState(a, null), null);
  assert.equal(lib.checkState(null, a), "no_state_cookie");
  assert.equal(lib.checkState(null, null), "no_state_cookie");
  assert.equal(lib.checkState("", null), "no_state_cookie");
  assert.equal(lib.checkState("short", "short"), "no_state_cookie");
  assert.equal(lib.safeEqual("abc", "abc"), true);
  assert.equal(lib.safeEqual("abc", "abd"), false);
  assert.equal(lib.safeEqual("abc", "abcd"), false);
});

test("state cookie: httpOnly, Secure, SameSite=Strict, scoped to /api/spotify, 10 minutes", () => {
  const state = "c".repeat(43);
  const set = lib.stateCookieHeader(state);
  assert.equal(set.split(";")[0], `${lib.STATE_COOKIE}=${state}`);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/spotify", "Max-Age=600"]) assert.ok(set.includes(attr), attr);
  const clear = lib.clearStateCookieHeader();
  assert.ok(clear.startsWith(`${lib.STATE_COOKIE}=;`) && clear.includes("Max-Age=0") && clear.includes("Path=/api/spotify") && clear.includes("HttpOnly"));

  assert.equal(lib.readStateCookie(`a=1; ${lib.STATE_COOKIE}=${state}; b=2`), state);
  assert.equal(lib.readStateCookie(`${lib.STATE_COOKIE}=${state}`), state);
  assert.equal(lib.readStateCookie(null), null);
  assert.equal(lib.readStateCookie(""), null);
  assert.equal(lib.readStateCookie("other=1"), null);
  assert.equal(lib.readStateCookie(`${lib.STATE_COOKIE}=short`), null, "malformed value");
  assert.equal(lib.readStateCookie(`${lib.STATE_COOKIE}=${state}; ${lib.STATE_COOKIE}=${"d".repeat(43)}`), null, "sent twice");
  assert.equal(lib.readStateCookie(`x${lib.STATE_COOKIE}=${state}`), null, "a different cookie name");
});

// ----------------------------------------------------------------------------- pure: token blob

test("scopes: order-independent, both required", () => {
  assert.equal(lib.hasRequiredScopes("playlist-modify-private user-read-recently-played"), true);
  assert.equal(lib.hasRequiredScopes("user-read-recently-played playlist-modify-private"), true);
  assert.equal(lib.hasRequiredScopes("user-read-recently-played  playlist-modify-private user-read-email"), true);
  assert.equal(lib.hasRequiredScopes("user-read-recently-played"), false);
  assert.equal(lib.hasRequiredScopes("playlist-modify-private"), false);
  assert.equal(lib.hasRequiredScopes("user-read-recently-playedplaylist-modify-private"), false);
  assert.equal(lib.hasRequiredScopes(""), false);
  assert.equal(lib.hasRequiredScopes(undefined), false);
});

test("token blob: exactly the existing keys plus authorized_at, in the stored text format", () => {
  const blob = lib.buildTokenBlob({ ...TOKEN_OK, extra_field: "dropped" }, 1700000000.9);
  assert.deepEqual(Object.keys(blob), ["access_token", "token_type", "expires_in", "refresh_token", "scope", "obtained_at", "authorized_at"]);
  assert.deepEqual(blob, {
    access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH,
    scope: SCOPE_FROM_SPOTIFY, obtained_at: 1700000000, authorized_at: 1700000000,
  });
  assert.equal(Number.isInteger(blob.obtained_at) && Number.isInteger(blob.authorized_at), true);
  // TEXT column: pretty JSON, indent 2 (what json.dump(tokens, f, indent=2) writes in Python)
  const text = lib.serializeTokenBlob(blob);
  assert.equal(text, JSON.stringify(blob, null, 2));
  assert.ok(text.startsWith('{\n  "access_token": '));
  assert.deepEqual(JSON.parse(text), blob);

  assert.equal(lib.buildTokenBlob({ ...TOKEN_OK, refresh_token: undefined }, 1), null, "no refresh token");
  assert.equal(lib.buildTokenBlob({ ...TOKEN_OK, refresh_token: "" }, 1), null);
  assert.equal(lib.buildTokenBlob({ ...TOKEN_OK, access_token: 5 }, 1), null, "no access token");
  assert.equal(lib.buildTokenBlob(null, 1), null);
  assert.equal(lib.buildTokenBlob("x", 1), null);
  const defaults = lib.buildTokenBlob({ access_token: ACCESS, refresh_token: REFRESH }, 10);
  assert.equal(defaults.token_type, "Bearer");
  assert.equal(defaults.expires_in, 3600);
  assert.equal(defaults.scope, "");
});

test("newer-wins: a later authorization wins, then the later refresh (same rule as ci_token_helper.py)", () => {
  const n = lib.isNewerBlob;
  assert.equal(n({ authorized_at: 200, obtained_at: 200 }, { authorized_at: 100, obtained_at: 900 }), true);
  assert.equal(n({ authorized_at: 100, obtained_at: 900 }, { authorized_at: 200, obtained_at: 200 }), false, "old authorization, later refresh: loses");
  assert.equal(n({ obtained_at: 900 }, { authorized_at: 200, obtained_at: 200 }), false, "no authorized_at loses to one that has it");
  assert.equal(n({ authorized_at: 100, obtained_at: 300 }, { authorized_at: 100, obtained_at: 200 }), true);
  assert.equal(n({ authorized_at: 100, obtained_at: 200 }, { authorized_at: 100, obtained_at: 200 }), false, "equal is not newer");
  assert.equal(n({ obtained_at: 300 }, { obtained_at: 200 }), true, "legacy blobs compare on obtained_at");
  assert.equal(n({ obtained_at: "999", authorized_at: true }, { obtained_at: 1 }), false, "odd values count as unknown");
  const py = fs.readFileSync(path.join(SRC, "..", "..", "ci_token_helper.py"), "utf8");
  assert.ok(py.includes("def spotify_upload_decision(") && py.includes('local.get("authorized_at")'), "the Python twin exists");
});

// ----------------------------------------------------------------------------- pure: /status

test("needsSpotifyReconnect matches the ETL's sign-in-again messages and nothing else", () => {
  const py = fs.readFileSync(path.join(SRC, "..", "..", "spotify_etl.py"), "utf8");
  const m = /REAUTH_HOWTO = \(\s*((?:"[^"]*"\s*)+)\)/.exec(py);
  assert.ok(m, "REAUTH_HOWTO found in spotify_etl.py");
  const howto = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  assert.ok(howto.includes("/status") && howto.includes("Reconnect on the Spotify card"), "the heartbeat text points at the Reconnect control");
  assert.ok(py.includes('REAUTH_INSTRUCTIONS = f"Spotify refresh token rejected. {REAUTH_HOWTO}"'));
  // the heartbeat texts spotify_etl.py writes (formats copied from the source; see also the Python twin of this test)
  assert.equal(lib.needsSpotifyReconnect(`Spotify refresh token rejected. ${howto} (HTTP 400 invalid_grant: Refresh token expired)`), true);
  assert.equal(lib.needsSpotifyReconnect(`Spotify refresh token rejected. ${howto} (HTTP 400 invalid_grant: Refresh token revoked)`), true);
  assert.ok(py.includes('f"Spotify sign-in expires {when}, {lifetime}: {act}. {REAUTH_HOWTO}"'), "the expiring-soon heartbeat text");
  assert.ok(py.includes('f"Spotify sign-in expires {lifetime} and that day has already passed "'), "the expired heartbeat text");
  assert.equal(lib.needsSpotifyReconnect(`Spotify sign-in expires in 14 days, 180 days after it was made: reconnect by 2027-05-12 (Eastern time). ${howto}`), true);
  assert.equal(lib.needsSpotifyReconnect(`Hit Spotify 50-track recently-played cap — likely lost some plays; Spotify sign-in expires in 3 days, 180 days after it was made: reconnect by 2027-05-12 (Eastern time). ${howto}`), true);
  assert.equal(lib.needsSpotifyReconnect(`Spotify sign-in expires 180 days after it was made and that day has already passed (2027-05-13, Eastern time). ${howto}`), true);
  assert.ok(py.includes('f"No Spotify tokens at {SPOTIFY_TOKEN_FILE}. {REAUTH_HOWTO}"') && py.includes("holds no refresh token. {REAUTH_HOWTO}"));
  assert.equal(lib.needsSpotifyReconnect(`No Spotify tokens at /home/runner/.spotify_tokens.json. ${howto}`), true);
  assert.equal(lib.needsSpotifyReconnect(`Spotify token file /home/runner/.spotify_tokens.json holds no refresh token. ${howto}`), true);
  assert.equal(lib.needsSpotifyReconnect(howto), false, "the how-to alone is not the trigger");
  assert.equal(lib.needsSpotifyReconnect("Spotify rejected the app credentials (HTTP 400 invalid_client). Check the SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET secrets against the app at developer.spotify.com/dashboard."), false, "wrong app credentials are not a sign-in problem");
  assert.equal(lib.needsSpotifyReconnect("Spotify token refresh failed: connection refused"), false, "an outage is not a sign-in problem");
  // the text the pre-2026-11-13 ETL wrote (still in sync_log until the next run)
  assert.equal(lib.needsSpotifyReconnect('Spotify refresh token rejected. Re-run `python spotify_etl.py --auth` locally then `python ci_token_helper.py upload spotify`. (HTTP 400: {"error":"invalid_grant","error_description":"Refresh token revoked"})'), true);
  assert.equal(lib.needsSpotifyReconnect('{"error":"invalid_grant"}'), true);
  assert.equal(lib.needsSpotifyReconnect("Refresh token revoked"), true);
  assert.equal(lib.needsSpotifyReconnect("refresh token has been expired"), true);

  assert.equal(lib.needsSpotifyReconnect("Hit Spotify 50-track recently-played cap — likely lost some plays"), false);
  assert.equal(lib.needsSpotifyReconnect("Server error '503 Service Unavailable' for url 'https://api.spotify.com/v1/me/player/recently-played'"), false);
  assert.equal(lib.needsSpotifyReconnect("HTTP 429 Too Many Requests"), false);
  assert.equal(lib.needsSpotifyReconnect(""), false);
  assert.equal(lib.needsSpotifyReconnect(null), false);
  assert.equal(lib.needsSpotifyReconnect(undefined), false);
});

test("reconnect-by date: nothing before day 165, then the last full ET day before expiry", () => {
  const DAY = 86400;
  const at = Date.UTC(2026, 10, 14, 4, 30) / 1000; // 2026-11-13 23:30 ET
  const data = JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, obtained_at: at + 5, authorized_at: at }, null, 2);
  // expiry = at + 180 d = 2027-05-13 04:30 UTC = 2027-05-13 00:30 EDT; one day earlier = 2027-05-12 00:30 EDT
  assert.equal(lib.reconnectByDate(at), "2027-05-12");
  assert.equal(lib.spotifyReconnectBy(data, (at + 164 * DAY + DAY - 1) * 1000), null, "day 164, last second");
  assert.equal(lib.spotifyReconnectBy(data, (at + 165 * DAY) * 1000), "2027-05-12", "day 165");
  assert.equal(lib.spotifyReconnectBy(data, (at + 200 * DAY) * 1000), "2027-05-12", "still shown after expiry");
  assert.equal(lib.spotifyReconnectBy(data, at * 1000), null, "just authorized");
  // unknown authorization time: no warning, never a guess
  const far = (at + 400 * DAY) * 1000;
  assert.equal(lib.spotifyReconnectBy(JSON.stringify({ refresh_token: REFRESH, obtained_at: at }), far), null);
  assert.equal(lib.spotifyReconnectBy(JSON.stringify({ authorized_at: "soon" }), far), null);
  assert.equal(lib.spotifyReconnectBy(JSON.stringify({ authorized_at: -5 }), far), null);
  assert.equal(lib.spotifyReconnectBy("not json", far), null);
  assert.equal(lib.spotifyReconnectBy(null, far), null);
  assert.equal(lib.spotifyReconnectBy(undefined, far), null);
  assert.equal(lib.spotifyReconnectBy({ authorized_at: at }, far), null, "only the stored TEXT form is read");
  assert.equal(lib.formatReconnectDate("2027-05-12"), "May 12, 2027");
  // The autumn clock change: a sign-in at 00:30 ET on 2027-05-12 expires at 23:30 EST on 2027-11-07
  // (180 x 24 h is 23:30 on the 25-hour day). The last full day in time is Nov 6, not the expiry day.
  const autumn = Date.UTC(2027, 4, 12, 4, 30) / 1000;
  assert.equal(lib.reconnectByDate(autumn), "2027-11-06");
  assert.equal(lib.reconnectByDate(Date.UTC(2027, 4, 12, 3, 59) / 1000), "2027-11-06");
  assert.equal(lib.REFRESH_TOKEN_LIFETIME_DAYS, 180);
  assert.equal(lib.RECONNECT_WARNING_DAY, 165);
});

// ----------------------------------------------------------------------------- request checks

test("warning line: names the date until it passes, then says the authorization ran out", () => {
  const noon = (ymd) => Date.parse(`${ymd}T16:00:00Z`); // 11 AM / noon ET
  assert.equal(lib.reconnectWarningText("2027-05-12", noon("2027-05-01")), "Spotify's authorization runs out soon. Reconnect by May 12, 2027 to keep the sync running.");
  assert.equal(lib.reconnectWarningText("2027-05-12", noon("2027-05-12")), "Spotify's authorization runs out soon. Reconnect by May 12, 2027 to keep the sync running.");
  assert.equal(lib.reconnectWarningText("2027-05-12", noon("2027-05-13")), "Spotify's authorization runs out today. Reconnect now to keep the sync running.");
  assert.equal(lib.reconnectWarningText("2027-05-12", noon("2027-06-01")), "Spotify's authorization has run out. Reconnect to restart the sync.");
  // ET, not UTC: 02:00 UTC on May 13 is still May 12 in Atlanta.
  assert.ok(lib.reconnectWarningText("2027-05-12", Date.parse("2027-05-13T02:00:00Z")).includes("Reconnect by May 12, 2027"));
  assert.equal(lib.shiftDay("2027-03-14", -1), "2027-03-13");
  assert.equal(lib.shiftDay("2027-01-01", -1), "2026-12-31");
});

test("exchange request checks: same origin, JSON, small", () => {
  const ok = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json; charset=utf-8", "content-length": "200" };
  assert.equal(lib.checkExchangeRequest(headersOf(ok), ORIGIN), null);
  assert.equal(lib.checkExchangeRequest(headersOf({ ...ok, "sec-fetch-site": "same-origin" }), ORIGIN), null);
  assert.equal(lib.checkExchangeRequest(headersOf({ ...ok, host: "internal:3000", "x-forwarded-host": "onyx.example" }), "http://internal:3000"), null, "behind the proxy");
  const refused = (h, origin = ORIGIN) => lib.checkExchangeRequest(headersOf(h), origin);
  assert.deepEqual(refused({ ...ok, origin: undefined }), { status: 403, error: "missing_origin" });
  assert.deepEqual(refused({ ...ok, origin: "https://evil.example" }), { status: 403, error: "cross_origin" });
  assert.deepEqual(refused({ ...ok, origin: "null" }), { status: 403, error: "cross_origin" });
  assert.deepEqual(refused({ ...ok, "sec-fetch-site": "cross-site" }), { status: 403, error: "cross_origin" });
  assert.deepEqual(refused({ ...ok, "sec-fetch-site": "same-site" }), { status: 403, error: "cross_origin" });
  assert.deepEqual(refused({ ...ok, "content-type": "text/plain" }), { status: 415, error: "bad_content_type" });
  assert.deepEqual(refused({ ...ok, "content-type": "application/x-www-form-urlencoded" }), { status: 415, error: "bad_content_type" });
  assert.deepEqual(refused({ ...ok, "content-length": "4097" }), { status: 413, error: "body_too_large" });
  assert.deepEqual(refused({ ...ok, "content-length": "abc" }), { status: 413, error: "body_too_large" });
  assert.equal(lib.MAX_EXCHANGE_BODY_BYTES, 4096);
});

// ----------------------------------------------------------------------------- GET /api/spotify/auth-url

test("auth-url: answers the authorize link and sets the same state in the cookie; no secret", async () => {
  const { state, res } = await startReconnect();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body).sort(), ["ok", "url"]);
  const url = new URL(res.body.url);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(res.headers["Set-Cookie"], lib.stateCookieHeader(state));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assertNoSecrets(res.body, "auth-url body");
  assertNoSecrets(res.headers, "auth-url headers");
  const again = await startReconnect();
  assert.notEqual(again.state, state, "a fresh state per link");
  assert.equal(authUrlRoute.dynamic, "force-dynamic");
});

test("auth-url: refused when another site caused the request; 500 with a fixed message when not configured", async () => {
  for (const site of ["cross-site", "same-site", "none"]) {
    const { result } = await withEnv(() => authUrlRoute.GET({ headers: headersOf({ "sec-fetch-site": site }) }));
    assert.equal(result.status, 403, site);
    assert.equal(result.body.code, "cross_origin");
    assert.equal(result.headers["Set-Cookie"], undefined, "no cookie is set");
  }
  const noHeader = await withEnv(() => authUrlRoute.GET({ headers: headersOf({}) }));
  assert.equal(noHeader.result.status, 200, "a client that sends no Sec-Fetch-Site still needs the owner session (middleware)");

  for (const env of [{}, { SPOTIFY_CLIENT_ID: CLIENT_ID }, { SPOTIFY_CLIENT_SECRET: CLIENT_SECRET }]) {
    const { result } = await withEnv(() => authUrlRoute.GET({ headers: headersOf({}) }), { env });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { ok: false, code: "not_configured", error: lib.RECONNECT_ERRORS.not_configured });
    assert.equal(result.headers["Set-Cookie"], undefined);
    assertNoSecrets(result.body, "not-configured body");
  }
});

// ----------------------------------------------------------------------------- POST /api/spotify/exchange

test("exchange: the full address is exchanged, probed and stored; the answer carries no token", async () => {
  const { state, cookie } = await startReconnect();
  db = fakeDb({ stored: JSON.stringify({ refresh_token: "old-dead-refresh", obtained_at: 5 }, null, 2) });
  const spotify = fakeSpotify();
  const before = Math.floor(Date.now() / 1000);
  const { result: res, logged } = await withEnv(
    () => exchangeRoute.POST(postReq({ body: { callback: `${REDIRECT}?code=${CODE}&state=${state}` }, cookie: `sb-x=1; ${cookie}` })),
    { fetchImpl: spotify.fetchImpl },
  );
  const after = Math.floor(Date.now() / 1000);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ["authorized_at", "ok", "reconnect_by"]);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.authorized_at >= before && res.body.authorized_at <= after);
  assert.equal(res.body.reconnect_by, lib.reconnectByDate(res.body.authorized_at));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Set-Cookie"], lib.clearStateCookieHeader(), "the state is single use");
  assertNoSecrets(res.body, "exchange body");
  assertNoSecrets(res.headers, "exchange headers");
  assertNoSecrets(logged.join("\n"), "server log");

  // 1: the code exchange. Same redirect constant as the authorize link, Basic auth, form body.
  assert.equal(spotify.calls.length, 2);
  const [tokenCall, probeCall] = spotify.calls;
  assert.equal(tokenCall.url, "https://accounts.spotify.com/api/token");
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(tokenCall.init.headers.Authorization, "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"));
  const form = new URLSearchParams(String(tokenCall.init.body));
  assert.deepEqual(Object.fromEntries(form), { grant_type: "authorization_code", code: CODE, redirect_uri: REDIRECT });
  assert.equal(form.get("redirect_uri"), new URL(lib.buildAuthorizeUrl(CLIENT_ID, state)).searchParams.get("redirect_uri"), "byte-identical to the authorize link's");
  // 2: one recently-played read with the new access token.
  assert.equal(probeCall.url, "https://api.spotify.com/v1/me/player/recently-played?limit=1");
  assert.equal(probeCall.init.headers.Authorization, `Bearer ${ACCESS}`);

  // 3: stored in the existing shape + authorized_at.
  assert.equal(db.calls.upserts.length, 1);
  const { table, row } = db.calls.upserts[0];
  assert.equal(table, "ci_tokens");
  assert.deepEqual(Object.keys(row).sort(), ["service", "token_data", "updated_at"]);
  assert.equal(row.service, "spotify");
  assert.ok(!Number.isNaN(Date.parse(row.updated_at)));
  assert.equal(typeof row.token_data, "string");
  const blob = JSON.parse(row.token_data);
  assert.deepEqual(Object.keys(blob), ["access_token", "token_type", "expires_in", "refresh_token", "scope", "obtained_at", "authorized_at"]);
  assert.equal(row.token_data, JSON.stringify(blob, null, 2));
  assert.equal(blob.access_token, ACCESS);
  assert.equal(blob.refresh_token, REFRESH);
  assert.equal(blob.authorized_at, res.body.authorized_at);
  assert.equal(blob.obtained_at, blob.authorized_at);
  assert.equal(lib.hasRequiredScopes(blob.scope), true);
});

test("exchange: a bare code works with the cookie and is refused without it", async () => {
  const { cookie } = await startReconnect();
  db = fakeDb();
  const spotify = fakeSpotify();
  const ok = await withEnv(() => exchangeRoute.POST(postReq({ body: { callback: CODE }, cookie })), { fetchImpl: spotify.fetchImpl });
  assert.equal(ok.result.status, 200);
  assert.equal(db.calls.upserts.length, 1);

  db = fakeDb();
  const none = await withEnv(() => exchangeRoute.POST(postReq({ body: { callback: CODE } })));
  assert.equal(none.result.status, 400);
  assert.equal(none.result.body.code, "no_state_cookie");
  assert.equal(db.calls.upserts.length, 0);
});

test("exchange: state problems stop before Spotify is called, and burn the cookie", async () => {
  const { state, cookie } = await startReconnect();
  const other = "z".repeat(43);
  const cases = [
    ["a state that is not the cookie's", { callback: `${REDIRECT}?code=${CODE}&state=${other}` }, cookie, "state_mismatch"],
    ["no cookie at all", { callback: `${REDIRECT}?code=${CODE}&state=${state}` }, undefined, "no_state_cookie"],
    ["an unrelated cookie only", { callback: `${REDIRECT}?code=${CODE}&state=${state}` }, "sb-x=1", "no_state_cookie"],
    ["a malformed cookie value", { callback: `${REDIRECT}?code=${CODE}&state=short` + "x".repeat(20) }, `${lib.STATE_COOKIE}=short`, "no_state_cookie"],
  ];
  for (const [name, body, ck, code] of cases) {
    db = fakeDb();
    const { result } = await withEnv(() => exchangeRoute.POST(postReq({ body, cookie: ck }))); // any fetch would throw
    assert.equal(result.status, 400, name);
    assert.deepEqual(result.body, { ok: false, code, error: lib.RECONNECT_ERRORS[code] }, name);
    assert.equal(result.headers["Set-Cookie"], lib.clearStateCookieHeader(), name);
    assert.equal(db.calls.upserts.length, 0, name);
    assertNoSecrets(result.body, name);
  }
});

test("exchange: request-shape refusals never read the paste, call Spotify or touch the cookie", async () => {
  const { state, cookie } = await startReconnect();
  const good = { callback: `${REDIRECT}?code=${CODE}&state=${state}` };
  const cases = [
    ["no Origin", postReq({ body: good, cookie, headers: { origin: undefined } }), 403, "missing_origin"],
    ["cross-origin", postReq({ body: good, cookie, headers: { origin: "https://evil.example" } }), 403, "cross_origin"],
    ["cross-site fetch metadata", postReq({ body: good, cookie, headers: { "sec-fetch-site": "cross-site" } }), 403, "cross_origin"],
    ["form post", postReq({ body: good, cookie, headers: { "content-type": "application/x-www-form-urlencoded" } }), 415, "bad_content_type"],
    ["declared too large", postReq({ body: good, cookie, headers: { "content-length": "99999" } }), 413, "body_too_large"],
    ["actually too large", postReq({ body: { callback: "a".repeat(5000) }, cookie }), 413, "body_too_large"],
    ["too large in bytes, not characters", postReq({ body: JSON.stringify({ callback: "é".repeat(2100) }), cookie }), 413, "body_too_large"],
    ["not JSON", postReq({ body: "callback=x", cookie }), 400, "bad_body"],
    ["wrong keys", postReq({ body: { code: CODE, state }, cookie }), 400, "bad_body"],
    ["an address that is not the callback", postReq({ body: { callback: `https://evil.example/callback?code=${CODE}&state=${state}` }, cookie }), 400, "not_callback_address"],
    ["Spotify said no", postReq({ body: { callback: `${REDIRECT}?error=access_denied&state=${state}` }, cookie }), 400, "spotify_denied"],
    ["empty paste", postReq({ body: { callback: "  " }, cookie }), 400, "empty_input"],
  ];
  for (const [name, req, status, code] of cases) {
    db = fakeDb();
    const { result } = await withEnv(() => exchangeRoute.POST(req)); // any fetch would throw
    assert.equal(result.status, status, name);
    assert.deepEqual(result.body, { ok: false, code, error: lib.RECONNECT_ERRORS[code] }, name);
    assert.equal(result.headers["Set-Cookie"], undefined, `${name}: the cookie is left alone so the right address can still be pasted`);
    assert.equal(result.headers["Cache-Control"], "no-store", name);
    assert.equal(db.calls.upserts.length, 0, name);
    assertNoSecrets(result.body, name);
  }
});

test("exchange: nothing is stored unless every step passed; errors are fixed strings", async () => {
  const cases = [
    ["code expired or reused", { token: jsonResponse(400, { error: "invalid_grant", error_description: `Invalid authorization code ${CODE}` }) }, 400, "code_rejected", 1],
    ["wrong client secret", { token: jsonResponse(400, { error: "invalid_client" }) }, 500, "not_configured", 1],
    ["Spotify 503 on the exchange", { token: jsonResponse(503, { error: "server_error" }) }, 502, "spotify_unavailable", 1],
    ["network error on the exchange", { token: () => { throw new Error(`boom ${CLIENT_SECRET}`); } }, 502, "spotify_unavailable", 1],
    ["no refresh token in the answer", { token: jsonResponse(200, { ...TOKEN_OK, refresh_token: undefined }) }, 502, "bad_token_response", 1],
    ["a scope is missing", { token: jsonResponse(200, { ...TOKEN_OK, scope: "user-read-recently-played" }) }, 400, "missing_scope", 1],
    ["probe 403 (account not allowed on the app)", { probe: jsonResponse(403, { error: { status: 403, message: "Forbidden" } }) }, 403, "wrong_account", 2],
    ["probe 401", { probe: jsonResponse(401, {}) }, 403, "wrong_account", 2],
    ["probe 503", { probe: jsonResponse(503, {}) }, 502, "probe_failed", 2],
    ["probe network error", { probe: () => { throw new Error("boom"); } }, 502, "probe_failed", 2],
  ];
  for (const [name, spotifyOpts, status, code, fetches] of cases) {
    const { state, cookie } = await startReconnect();
    db = fakeDb({ stored: JSON.stringify({ refresh_token: "working-old-refresh", obtained_at: 5 }) });
    const spotify = fakeSpotify(spotifyOpts);
    const { result, logged } = await withEnv(
      () => exchangeRoute.POST(postReq({ body: { callback: `${REDIRECT}?code=${CODE}&state=${state}` }, cookie })),
      { fetchImpl: spotify.fetchImpl },
    );
    assert.equal(result.status, status, name);
    assert.deepEqual(result.body, { ok: false, code, error: lib.RECONNECT_ERRORS[code] }, name);
    assert.equal(spotify.calls.length, fetches, name);
    assert.equal(db.calls.upserts.length, 0, `${name}: the stored token is untouched`);
    // Spotify not answering keeps the cookie: the message says to press Finish again.
    const expectedCookie = code === "spotify_unavailable" ? undefined : lib.clearStateCookieHeader();
    assert.equal(result.headers["Set-Cookie"], expectedCookie, name);
    assertNoSecrets(result.body, name);
    assertNoSecrets(logged.join("\n"), `${name} log`);
  }
});

test("exchange: after Spotify did not answer, pressing Finish again with the same paste works", async () => {
  const { state, cookie } = await startReconnect();
  db = fakeDb();
  const body = { callback: `${REDIRECT}?code=${CODE}&state=${state}` };
  const down = await withEnv(() => exchangeRoute.POST(postReq({ body, cookie })), { fetchImpl: fakeSpotify({ token: jsonResponse(503, {}) }).fetchImpl });
  assert.equal(down.result.body.code, "spotify_unavailable");
  assert.ok(lib.RECONNECT_ERRORS.spotify_unavailable.includes("Press Finish again"));
  const again = await withEnv(() => exchangeRoute.POST(postReq({ body, cookie })), { fetchImpl: fakeSpotify().fetchImpl });
  assert.equal(again.result.status, 200);
  assert.equal(db.calls.upserts.length, 1);
  assert.equal(again.result.headers["Set-Cookie"], lib.clearStateCookieHeader(), "cleared once it is used");
});

test("exchange: a query pasted without its state is refused before Spotify is called", async () => {
  const { cookie } = await startReconnect();
  db = fakeDb();
  const { result } = await withEnv(() => exchangeRoute.POST(postReq({ body: { callback: `code=${CODE}` }, cookie }))); // any fetch would throw
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "bad_state");
  assert.equal(db.calls.upserts.length, 0);
});

test("exchange: missing server config is a 500 before Spotify is called; a failed save is a 500", async () => {
  const { state, cookie } = await startReconnect();
  db = fakeDb();
  const noEnv = await withEnv(
    () => exchangeRoute.POST(postReq({ body: { callback: `${REDIRECT}?code=${CODE}&state=${state}` }, cookie })),
    { env: { SPOTIFY_CLIENT_ID: CLIENT_ID } },
  );
  assert.equal(noEnv.result.status, 500);
  assert.equal(noEnv.result.body.code, "not_configured");
  assert.equal(db.calls.upserts.length, 0);

  const next = await startReconnect();
  db = fakeDb({ upsertError: "42501" });
  const spotify = fakeSpotify();
  const failed = await withEnv(
    () => exchangeRoute.POST(postReq({ body: { callback: `${REDIRECT}?code=${CODE}&state=${next.state}` }, cookie: next.cookie })),
    { fetchImpl: spotify.fetchImpl },
  );
  assert.equal(failed.result.status, 500);
  assert.deepEqual(failed.result.body, { ok: false, code: "store_failed", error: lib.RECONNECT_ERRORS.store_failed });
  assertNoSecrets(failed.result.body, "store-failed body");
  assertNoSecrets(failed.logged.join("\n"), "store-failed log");
});

// ----------------------------------------------------------------------------- refresh path (spotify-server.ts)

test("refresh path: keeps authorized_at, and never writes an old blob over a newer authorization", async () => {
  const refreshOk = jsonResponse(200, { access_token: "synthetic-access-2", token_type: "Bearer", expires_in: 3600, scope: SCOPE_FROM_SPOTIFY });
  const old = { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH, scope: SCOPE_FROM_SPOTIFY, obtained_at: 1000, authorized_at: 900 };

  // normal: same authorization, later refresh -> written back with every key kept
  db = fakeDb({ stored: JSON.stringify(old, null, 2) });
  let spotify = fakeSpotify({ token: refreshOk });
  let run = await withEnv(() => server.getSpotifyAccessToken(), { fetchImpl: spotify.fetchImpl });
  assert.equal(run.result, "synthetic-access-2");
  assert.equal(new URLSearchParams(String(spotify.calls[0].init.body)).get("grant_type"), "refresh_token");
  assert.equal(db.calls.upserts.length, 1);
  const saved = JSON.parse(db.calls.upserts[0].row.token_data);
  assert.equal(saved.authorized_at, 900, "authorized_at survives the refresh");
  assert.equal(saved.refresh_token, REFRESH);
  assert.ok(saved.obtained_at > 1000);

  // a reconnect stored a newer authorization between this call's load and its save
  const reconnected = { ...old, refresh_token: "synthetic-new-refresh", obtained_at: 2_000_000_000_000, authorized_at: 2_000_000_000_000 };
  let reads = 0;
  const racing = fakeDb({ stored: JSON.stringify(old) });
  const realFrom = racing.client.from;
  racing.client.from = (t) => {
    const b = realFrom(t);
    const then = b.then;
    b.then = (res, rej) => { reads++; return Promise.resolve({ data: [{ token_data: JSON.stringify(reconnected) }], error: null }).then(res, rej); };
    void then;
    return b;
  };
  db = racing;
  spotify = fakeSpotify({ token: refreshOk });
  run = await withEnv(() => server.getSpotifyAccessToken(), { fetchImpl: spotify.fetchImpl });
  assert.equal(run.result, "synthetic-access-2", "the call still gets its access token");
  assert.equal(reads, 1, "the stored row is re-read before the write-back");
  assert.equal(db.calls.upserts.length, 0, "the old blob is not written over the reconnect's token");

  // a dead refresh token: a clear pointer to /status, no Spotify body, nothing written
  db = fakeDb({ stored: JSON.stringify(old) });
  spotify = fakeSpotify({ token: jsonResponse(400, { error: "invalid_grant", error_description: "Refresh token expired" }) });
  await assert.rejects(
    withEnv(() => server.getSpotifyAccessToken(), { fetchImpl: spotify.fetchImpl }),
    (e) => /refresh token rejected/i.test(e.message) && e.message.includes("/status") && !e.message.includes(REFRESH),
  );
  assert.equal(db.calls.upserts.length, 0);

  // not configured: fails before any network call
  db = fakeDb({ stored: JSON.stringify(old) });
  await assert.rejects(withEnv(() => server.getSpotifyAccessToken(), { env: {} }), /not configured/);
});

// ----------------------------------------------------------------------------- browser-side helpers

test("browser helpers: a signed-out redirect or HTML answer reads as an expired session; errors come from the fixed table", async () => {
  const html = { ok: true, status: 200, redirected: true, headers: { get: () => "text/html; charset=utf-8" }, json: async () => { throw new Error("not json"); } };
  assert.deepEqual(await lib.requestAuthorizeUrl(async () => html), { ok: false, message: lib.SESSION_EXPIRED_MESSAGE });
  assert.deepEqual(await lib.submitCallback(async () => html, CODE), { ok: false, message: lib.SESSION_EXPIRED_MESSAGE });
  assert.deepEqual(await lib.submitCallback(async () => ({ ...html, redirected: false }), CODE), { ok: false, message: lib.SESSION_EXPIRED_MESSAGE });

  const good = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}`;
  assert.deepEqual(await lib.requestAuthorizeUrl(async () => jsonResponse(200, { ok: true, url: good })), { ok: true, url: good });
  for (const bad of ["https://evil.example/authorize?x=1", "javascript:alert(1)", "https://accounts.spotify.com.evil.example/authorize?x", undefined]) {
    const r = await lib.requestAuthorizeUrl(async () => jsonResponse(200, { ok: true, url: bad }));
    assert.equal(r.ok, false, `only Spotify's authorize page is ever linked (${bad})`);
  }
  const serverSaid = await lib.requestAuthorizeUrl(async () => jsonResponse(500, { ok: false, code: "not_configured", error: "<b>something else</b>" }));
  assert.deepEqual(serverSaid, { ok: false, message: lib.RECONNECT_ERRORS.not_configured }, "text comes from the table by code, not from the response");
  const unknown = await lib.submitCallback(async () => jsonResponse(500, { ok: false, code: "constructor", error: "x" }), CODE);
  assert.equal(unknown.ok, false);
  assert.ok(!unknown.message.includes("function"), "an unknown code falls back to a generic message");
  assert.equal((await lib.requestAuthorizeUrl(async () => { throw new Error("offline"); })).ok, false);

  // a paste that cannot be a callback is answered locally, without a request
  let called = 0;
  const local = await lib.submitCallback(async () => { called++; return html; }, "https://evil.example/?code=x");
  assert.deepEqual(local, { ok: false, message: lib.RECONNECT_ERRORS.not_callback_address });
  assert.equal(called, 0);

  // the request the component sends
  const sent = [];
  const done = await lib.submitCallback(async (url, init) => { sent.push({ url, init }); return jsonResponse(200, { ok: true, authorized_at: 1, reconnect_by: "2027-05-12" }); }, `  ${CODE} `);
  assert.deepEqual(done, { ok: true, reconnectBy: "2027-05-12" });
  assert.equal(sent[0].url, "/api/spotify/exchange");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(sent[0].init.body), { callback: CODE });
  assert.deepEqual(await lib.submitCallback(async () => jsonResponse(200, { ok: true, reconnect_by: "<img>" }), CODE), { ok: true, reconnectBy: null });
});

// ----------------------------------------------------------------------------- /api/status

function statusDb(tokenData, spotifyBeat) {
  const reads = [];
  const from = (table) => {
    const q = { table, eq: {} };
    const b = {
      select() { return b; },
      eq(col, val) { q.eq[col] = val; return b; },
      not() { return b; },
      gte() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve, reject) {
        reads.push(q);
        let data = [];
        if (table === "ci_tokens") data = tokenData === null ? [] : [{ token_data: tokenData }];
        else if (table === "sync_log" && !q.eq.source && !q.eq.data_type) data = spotifyBeat ? [spotifyBeat] : [];
        else if (table === "spotify_plays") data = [{ played_date_et: new Date().toISOString().slice(0, 10) }];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { client: { from }, reads };
}

async function statusWith(tokenData, beat) {
  const fake = statusDb(tokenData, beat);
  const route = loadTs("app/api/status/route.ts", { ...stubs, "@supabase/supabase-js": { createClient: () => fake.client } });
  const res = await route.GET();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { body: res.body, reads: fake.reads, headers: res.headers };
}

test("/api/status: only the reconnect-by date leaves the server, and only from day 165", async () => {
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const beat = { source: "spotify", data_type: "plays", status: "success", sync_start: new Date().toISOString(), records_synced: 3, duration_seconds: 2, error_message: null };
  const blob = (authorizedAt) => JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH, scope: SCOPE_FROM_SPOTIFY, obtained_at: now, authorized_at: authorizedAt }, null, 2);

  const fresh = await statusWith(blob(now - 30 * DAY), beat);
  assert.equal(fresh.body.sources.spotify.reconnectBy, null);
  assert.equal(fresh.body.sources.spotify.status, "success");
  assert.equal(fresh.body.sources.spotify.cadence, "Hourly :50");
  assert.ok(fresh.reads.some((q) => q.table === "ci_tokens" && q.eq.service === "spotify"), "reads the spotify row only");
  assert.equal(fresh.reads.filter((q) => q.table === "ci_tokens").length, 1);

  const at = now - 170 * DAY;
  const due = await statusWith(blob(at), beat);
  assert.equal(due.body.sources.spotify.reconnectBy, lib.reconnectByDate(at));
  assert.match(due.body.sources.spotify.reconnectBy, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(due.body.sources.spotify.status, "partial", "a healthy card reads Degraded from day 165");
  assert.equal(due.body.sources.spotify.errorMessage, null);
  assert.ok(String(due.headers["Cache-Control"]).includes("s-maxage"), "this response is cacheable, hence the next checks");
  const text = JSON.stringify(due.body);
  assertNoSecrets(text, "/api/status");
  for (const leak of ["access_token", "refresh_token", "token_data", "authorized_at", "obtained_at", String(at)]) {
    assert.equal(text.includes(leak), false, `/api/status must not carry ${leak}`);
  }
  for (const [key, card] of Object.entries(due.body.sources)) {
    if (key !== "spotify") assert.equal(card.reconnectBy, undefined, `${key} has no reconnectBy`);
  }

  // a failed card stays failed (the warning never softens an error)
  const dead = await statusWith(blob(at), { ...beat, status: "failed", error_message: "Spotify refresh token rejected (HTTP 400)" });
  assert.equal(dead.body.sources.spotify.status, "failed");
  assert.equal(lib.needsSpotifyReconnect(dead.body.sources.spotify.errorMessage), true);

  // unknown authorization time (today's token) or no row: no warning, status untouched
  for (const data of [JSON.stringify({ refresh_token: REFRESH, obtained_at: now }), "not json", null]) {
    const r = await statusWith(data, beat);
    assert.equal(r.body.sources.spotify.reconnectBy, null);
    assert.equal(r.body.sources.spotify.status, "success");
  }
});

// ----------------------------------------------------------------------------- source guards

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("the two routes are owner-session only: never in the CI-token carve-out", () => {
  const mw = read("middleware.ts");
  const carveOut = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("const PUBLIC_MANIFEST"));
  assert.ok(carveOut.length > 100);
  assert.equal(carveOut.includes("/api/spotify"), false, "isCiRoute must not admit /api/spotify/*");
  assert.equal(/PUBLIC_MANIFEST = [^\n]*spotify/.test(mw), false);
  for (const rel of ["app/api/spotify/auth-url/route.ts", "app/api/spotify/exchange/route.ts"]) {
    const src = read(rel);
    assert.equal(/ONYX_CI_TOKEN|x-onyx-ci-token/.test(src.replace(/\/\/[^\n]*/g, "")), false, `${rel} does not read the CI token`);
    assert.ok(src.includes('export const dynamic = "force-dynamic"'), `${rel} is never cached`);
    assert.equal(/SPOTIFY_REDIRECT_URI\s*=|process\.env\.SPOTIFY_REDIRECT_URI/.test(src), false, `${rel} does not define or read another redirect`);
  }
  assert.equal(/process\.env\.SPOTIFY_REDIRECT_URI/.test(read("lib/spotify-server.ts") + read("lib/spotify-reconnect.ts")), false, "one hard-coded redirect, never from env");
  assert.equal((read("lib/spotify-reconnect.ts").match(/http:\/\/127\.0\.0\.1:8888\/callback"/g) || []).length, 1, "defined once");
  // the pure module is imported by a client component: it must hold no secret access
  assert.equal(/process\.env|SUPABASE_SERVICE_ROLE_KEY|CLIENT_SECRET/.test(read("lib/spotify-reconnect.ts").replace(/RECONNECT_ERRORS = \{[\s\S]*?\} as const;/, "")), false);
});

test("/status shows the Reconnect control on the Spotify card for a rejected token or a due date", () => {
  const page = read("app/status/page.tsx");
  assert.ok(page.includes('import SpotifyReconnect from "@/components/SpotifyReconnect"'));
  assert.ok(/sourceKey === "spotify" && \(needsSpotifyReconnect\(info\.errorMessage\) \|\| info\.reconnectBy\)/.test(page));
  const comp = read("components/SpotifyReconnect.tsx");
  assert.ok(comp.startsWith('"use client";'));
  assert.ok(comp.includes('target="_blank"') && comp.includes('rel="noopener noreferrer"'), "the authorize link opens in a new tab");
  assert.ok(comp.includes("Paste the address of the page that failed to load"));
  assert.equal(/spotify-server|SUPABASE|process\.env/.test(comp), false, "the component never touches server code or env");
});

test("the Reconnect control renders its first step and the warning date", () => {
  const { renderToStaticMarkup } = require("react-dom/server");
  const { createElement } = require("react");
  const Comp = loadTs("components/SpotifyReconnect.tsx", stubs).default;
  const plain = renderToStaticMarkup(createElement(Comp, {}));
  assert.ok(plain.includes("Reconnect Spotify"));
  assert.equal(plain.includes("spotify-reconnect-warning"), false);
  assert.equal(plain.includes("accounts.spotify.com"), false, "no link until the server has set the state cookie");
  const warned = renderToStaticMarkup(createElement(Comp, { reconnectBy: "2027-05-12" }));
  assert.ok(warned.includes("Reconnect by May 12, 2027"));
});

// ----------------------------------------------------------------------------- real next/server

test("the two routes under the real next/server classes: headers, cookie and body survive", async () => {
  const realNext = require("next/server");
  const real = { ...stubs, "next/server": realNext };
  const getRoute = loadTs("app/api/spotify/auth-url/route.ts", real);
  const postRoute = loadTs("app/api/spotify/exchange/route.ts", real);
  const spotify = fakeSpotify({
    token: () => new Response(JSON.stringify(TOKEN_OK), { status: 200, headers: { "content-type": "application/json" } }),
    probe: () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  db = fakeDb();
  await withEnv(async () => {
    const got = await getRoute.GET(new realNext.NextRequest(`${ORIGIN}/api/spotify/auth-url`, { headers: { "sec-fetch-site": "same-origin" } }));
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    const state = new URL((await got.json()).url).searchParams.get("state");
    const setCookie = got.headers.get("set-cookie");
    assert.equal(setCookie, lib.stateCookieHeader(state));

    const post = (headers) => new realNext.NextRequest(`${ORIGIN}/api/spotify/exchange`, {
      method: "POST",
      headers: { origin: ORIGIN, host: "onyx.example", "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: JSON.stringify({ callback: `${REDIRECT}?code=${CODE}&state=${state}` }),
    });
    const cross = await postRoute.POST(post({ origin: "https://evil.example", cookie: setCookie.split(";")[0] }));
    assert.equal(cross.status, 403);
    const noCookie = await postRoute.POST(post({}));
    assert.equal(noCookie.status, 400);
    assert.equal((await noCookie.json()).code, "no_state_cookie");
    assert.equal(spotify.calls.length, 0);

    const ok = await postRoute.POST(post({ cookie: `sb-session=1; ${setCookie.split(";")[0]}` }));
    const body = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.deepEqual(Object.keys(body).sort(), ["authorized_at", "ok", "reconnect_by"]);
    assert.equal(ok.headers.get("set-cookie"), lib.clearStateCookieHeader());
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(db.calls.upserts.length, 1);
    assertNoSecrets(JSON.stringify(body) + [...ok.headers.entries()].join("|"), "real-runtime answer");
  }, { fetchImpl: spotify.fetchImpl });
});
