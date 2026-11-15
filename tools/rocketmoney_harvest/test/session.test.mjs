// Synthetic data only: this repository is public. No browser, no network. Cookie values never appear here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachReadOnlyGuard, chromeCandidates, createBrowser, launchOptions, plainChromeArgs, profileChangedAt, restoreSettingIsOn, ROCKET_MONEY_SITE, savedTabsPath } from "../lib/browser.mjs";
import { LOGIN_REASON } from "../lib/harvest-run.mjs";
import {
  classifyUrl,
  createLandingJudge,
  describeHop,
  KEEPALIVE_HOURS,
  loginReason,
  SIGNED_OUT_RECHECK_HOURS,
  SIGNIN_SERVICE_HOURS,
  scheduleWarning,
  sessionLine,
  signedInPatch,
  signedOutPatch,
  signInServiceNote,
  summarizeRoundTrip,
  summarizeSessionCookies,
  visitPlan,
} from "../lib/session.mjs";

const APP = "https://app.rocketmoney.com/net-worth";
const API_LOGIN = "https://client-api.rocketmoney.com/auth0/auth/oidc/login?redirect=https%3A%2F%2Fapp.rocketmoney.com%2Fnet-worth";
const SILENT = "https://auth.rocketaccount.com/authorize?client_id=abc&scope=openid&response_type=code&prompt=none&state=SECRETSTATE&nonce=SECRETNONCE";
const CALLBACK_REFUSED = "https://client-api.rocketmoney.com/auth0/auth/oidc/callback?error=login_required&error_description=Login%20required&state=SECRETSTATE";
const CALLBACK_OK = "https://client-api.rocketmoney.com/auth0/auth/oidc/callback?code=SECRETCODE&state=SECRETSTATE";
const FORCED = "https://auth.rocketaccount.com/authorize?client_id=abc&prompt=login&state=SECRETSTATE";
const LOGIN_SCREEN = "https://auth.rocketaccount.com/u/login?state=SECRETSTATE";
const BASE = LOGIN_REASON;

test("classifyUrl: the app, a screen that waits for a person, and the hops in between", () => {
  assert.equal(classifyUrl(APP), "app");
  assert.equal(classifyUrl("https://app.rocketmoney.com/settings/accounts"), "app");
  assert.equal(classifyUrl("https://app.rocketmoney.com/login"), "signin");
  assert.equal(classifyUrl(LOGIN_SCREEN), "signin");
  assert.equal(classifyUrl("https://auth.rocketaccount.com/u/mfa-sms-challenge?state=x"), "signin");
  // redirect hops are never a verdict
  assert.equal(classifyUrl(API_LOGIN), "transit");
  assert.equal(classifyUrl(SILENT), "transit");
  assert.equal(classifyUrl("https://auth.rocketaccount.com/authorize/resume?state=x"), "transit");
  assert.equal(classifyUrl(CALLBACK_OK), "transit");
  assert.equal(classifyUrl("about:blank"), "transit");
  assert.equal(classifyUrl("not a url"), "transit");
  // other hosts can be passed in (the stand-in site used to exercise the Chrome part)
  const hosts = { app: "localhost", api: "127.0.0.1", auth: "127.0.0.2" };
  assert.equal(classifyUrl("http://localhost:5000/net-worth", hosts), "app");
  assert.equal(classifyUrl("http://127.0.0.2:5000/u/login", hosts), "signin");
  assert.equal(classifyUrl("http://127.0.0.1:5000/auth0/auth/oidc/login", hosts), "transit");
});

test("describeHop keeps host, path and a plain error word, and nothing else from the address", () => {
  assert.deepEqual(describeHop(SILENT), { where: "auth.rocketaccount.com/authorize", error: null, silent: true });
  assert.deepEqual(describeHop(FORCED), { where: "auth.rocketaccount.com/authorize", error: null, silent: false });
  assert.deepEqual(describeHop(CALLBACK_REFUSED), { where: "client-api.rocketmoney.com/auth0/auth/oidc/callback", error: "login_required", silent: false });
  assert.deepEqual(describeHop(CALLBACK_OK), { where: "client-api.rocketmoney.com/auth0/auth/oidc/callback", error: null, silent: false });
  // an error value that is not a plain word is dropped, long ids in the path are masked
  assert.equal(describeHop("https://client-api.rocketmoney.com/cb?error=Some%20Text%20123").error, null);
  assert.equal(describeHop("https://app.rocketmoney.com/t/0123456789abcdefghijKLMN/x").where, "app.rocketmoney.com/t/~/x");
  assert.equal(describeHop("about:blank").where, "about");
  assert.equal(describeHop("::").where, "unreadable address");
  for (const url of [SILENT, CALLBACK_REFUSED, CALLBACK_OK, LOGIN_SCREEN]) assert.equal(JSON.stringify(describeHop(url)).includes("SECRET"), false);
});

test("summarizeRoundTrip: a refused silent renewal, a successful one, and a visit that never left the app", () => {
  const refused = summarizeRoundTrip([APP, API_LOGIN, SILENT, CALLBACK_REFUSED, API_LOGIN, FORCED, LOGIN_SCREEN].map(describeHop), LOGIN_SCREEN);
  assert.equal(refused.endedAt, "auth.rocketaccount.com/u/login");
  assert.equal(refused.hops, 7);
  assert.equal(refused.silentTried, true);
  assert.equal(refused.silentError, "login_required");
  assert.equal(refused.silentRenewed, false);
  assert.match(refused.path, /callback \(login_required\) > client-api/);
  assert.equal(refused.path.includes("SECRET"), false);

  const renewed = summarizeRoundTrip([APP, API_LOGIN, SILENT, CALLBACK_OK, APP].map(describeHop), APP);
  assert.equal(renewed.silentTried, true);
  assert.equal(renewed.silentError, null);
  assert.equal(renewed.silentRenewed, true);
  assert.equal(renewed.endedAt, "app.rocketmoney.com/net-worth");

  const alive = summarizeRoundTrip([describeHop(APP)], APP);
  assert.deepEqual([alive.silentTried, alive.silentRenewed, alive.hops], [false, false, 1]);
  assert.equal(summarizeRoundTrip(undefined, undefined).endedAt, null);
});

function judgeRun(steps, opts) {
  const judge = createLandingJudge(opts);
  let verdict;
  for (const [t, url, loaded = false] of steps) {
    verdict = judge.update({ url, t, loaded });
    if (verdict.status !== "waiting") return { ...verdict, t };
  }
  return verdict;
}

test("landing judge: data arriving is the only proof of being signed in, even right after a redirect", () => {
  assert.equal(judgeRun([[0, APP], [500, APP], [1000, APP, true]]).status, "signed_in");
  // the silent renewal: off the app for a couple of seconds, then back with data
  const renewed = judgeRun([[0, APP], [1500, API_LOGIN], [2000, SILENT], [2500, CALLBACK_OK], [3000, APP], [4500, APP, true]]);
  assert.deepEqual([renewed.status, renewed.t], ["signed_in", 4500]);
});

test("landing judge: a redirect hop is not 'signed out' (the old check judged the address 2.5 s after opening)", () => {
  // 2.5 s after opening, the page is at the sign-in service's /authorize: still waiting, not a verdict
  assert.equal(judgeRun([[0, APP], [2000, API_LOGIN], [2500, SILENT]]).status, "waiting");
  // a slow round trip that sits on redirect hops for 15 s is still not a verdict
  assert.equal(judgeRun([[0, APP], [1000, SILENT], [8000, CALLBACK_OK], [16000, API_LOGIN]]).status, "waiting");
});

test("landing judge: resting on a sign-in screen is 'login required', with where", () => {
  const v = judgeRun([[0, APP], [1500, API_LOGIN], [2000, LOGIN_SCREEN], [3500, LOGIN_SCREEN], [5000, LOGIN_SCREEN]]);
  assert.deepEqual(v, { status: "login_required", where: "auth.rocketaccount.com/u/login", t: 5000 });
  // a sign-in screen seen for less than 3 s is not enough
  assert.equal(judgeRun([[0, APP], [2000, LOGIN_SCREEN], [4500, LOGIN_SCREEN]]).status, "waiting");
});

test("landing judge: stuck on a hop, and data that never comes, are failures of their own (not 'login required')", () => {
  const stuck = judgeRun([[0, APP], [1000, API_LOGIN], [11000, API_LOGIN], [21000, API_LOGIN]]);
  assert.deepEqual([stuck.status, stuck.where], ["stuck", "client-api.rocketmoney.com/auth0/auth/oidc/login"]);
  const never = judgeRun([[0, APP], [20000, APP], [45000, APP]]);
  assert.deepEqual([never.status, never.t], ["timeout", 45000]);
  // moving between hops restarts the 20 s, but the visit as a whole still ends at 45 s
  const wander = judgeRun([[0, API_LOGIN], [15000, SILENT], [30000, API_LOGIN], [45000, SILENT]]);
  assert.equal(wander.status, "stuck");
  // timings can be shortened (the stand-in site does)
  assert.equal(judgeRun([[0, LOGIN_SCREEN], [300, LOGIN_SCREEN]], { signinRestMs: 200 }).status, "login_required");
});

const cookie = (name, domain, expires, httpOnly = true) => ({ name, domain, expires, httpOnly, value: "NEVER-READ" });
const NOW = Date.parse("2026-11-12T12:00:00Z");
const inMinutes = (m) => NOW / 1000 + m * 60;

test("summarizeSessionCookies: which cookies hold the sign-in, whether they die with the browser, minutes left; never a value", () => {
  const s = summarizeSessionCookies(
    [
      cookie("AWSALB", "client-api.rocketmoney.com", inMinutes(10080), false),
      cookie("tb.auth0.sid", ".rocketmoney.com", inMinutes(228)),
      cookie("browser_uid", ".rocketmoney.com", inMinutes(260000)),
      cookie("auth0", "auth.rocketaccount.com", -1),
      cookie("auth0_compat", "auth.rocketaccount.com", -1),
      cookie("did", "auth.rocketaccount.com", inMinutes(525600)),
      cookie("notice_behavior", ".app.rocketmoney.com", -1, false),
    ],
    NOW,
  );
  assert.deepEqual(s, {
    app: { name: "tb.auth0.sid", sessionOnly: false, minutesLeft: 228, guessed: false },
    signIn: { name: "auth0", sessionOnly: true, minutesLeft: null },
    browserSessionOnly: 3,
  });
  assert.equal(JSON.stringify(s).includes("NEVER-READ"), false);
  assert.equal(sessionLine(s), "session cookies: app tb.auth0.sid: 228 min left; sign-in service auth0: browser-session only; 3 browser-session cookie(s), gone when Chrome closes");
});

test("summarizeSessionCookies: an unknown session cookie name is guessed (and marked), noise is not; nothing found is said plainly", () => {
  const guessed = summarizeSessionCookies(
    [cookie("AWSALB", "client-api.rocketmoney.com", inMinutes(100)), cookie("auth_verification", ".rocketmoney.com", -1), cookie("new.session.name", "client-api.rocketmoney.com", inMinutes(60)), cookie("auth0", "auth.rocketaccount.com", inMinutes(4320))],
    NOW,
  );
  assert.deepEqual(guessed.app, { name: "new.session.name", sessionOnly: false, minutesLeft: 60, guessed: true });
  assert.deepEqual(guessed.signIn, { name: "auth0", sessionOnly: false, minutesLeft: 4320 });
  assert.match(sessionLine(guessed), /app new\.session\.name \(guessed\): 60 min left; sign-in service auth0: 4320 min left/);
  // a cookie with the right name on some other site is not it
  assert.equal(summarizeSessionCookies([cookie("tb.auth0.sid", ".example.com", inMinutes(5)), cookie("auth0", "auth.example.com", -1)], NOW).app, null);
  const none = summarizeSessionCookies([], NOW);
  assert.equal(sessionLine(none), "session cookies: app session cookie: not found; sign-in service cookie: not found; 0 browser-session cookie(s), gone when Chrome closes");
  assert.equal(sessionLine(null), "session cookies: not read");
  assert.equal(summarizeSessionCookies("garbage", NOW).app, null);
});

test("scheduleWarning: only when the app session would run out before the next 2-hour visit", () => {
  const withLeft = (m) => ({ app: { name: "x", sessionOnly: false, minutesLeft: m } });
  assert.equal(KEEPALIVE_HOURS, 2);
  assert.equal(scheduleWarning(withLeft(228)), null);
  assert.equal(scheduleWarning(withLeft(135)), null);
  assert.match(scheduleWarning(withLeft(134)), /^WARNING: the app session has 134 min left/);
  assert.equal(scheduleWarning({ app: { name: "x", sessionOnly: true, minutesLeft: null } }), null);
  assert.equal(scheduleWarning(null), null);
});

test("the keep-alive interval stays well inside both lifetimes: the app session (about 3 h 48 min) and the sign-in service's cookie (72 h)", () => {
  assert.equal(SIGNIN_SERVICE_HOURS, 72);
  assert.ok(KEEPALIVE_HOURS * 60 + 15 <= 228, "two-hourly visits fit inside the app session");
  assert.ok(KEEPALIVE_HOURS <= SIGNIN_SERVICE_HOURS / 12, "far inside the sign-in service's 72 h");
  // the signed-out back-off (20 h) is also inside 72 h, so a sign-in by hand is noticed while it still counts
  assert.ok(SIGNED_OUT_RECHECK_HOURS < SIGNIN_SERVICE_HOURS);
});

test("signInServiceNote: only when the sign-in service's cookie is browser-session only or has less than a day left", () => {
  const withSignIn = (signIn) => ({ app: null, signIn, browserSessionOnly: 0 });
  assert.equal(signInServiceNote(withSignIn({ name: "auth0", sessionOnly: false, minutesLeft: 4320 })), null);
  assert.equal(signInServiceNote(withSignIn({ name: "auth0", sessionOnly: false, minutesLeft: 24 * 60 })), null);
  assert.equal(signInServiceNote(withSignIn({ name: "auth0", sessionOnly: false, minutesLeft: 600 })), "NOTE: the sign-in service's cookie has 10 h left; after that a lapsed app session cannot be renewed without a sign-in");
  assert.match(signInServiceNote(withSignIn({ name: "auth0", sessionOnly: true, minutesLeft: null })), /^NOTE: the sign-in service's cookie is browser-session only here/);
  assert.equal(signInServiceNote(withSignIn(null)), null);
  assert.equal(signInServiceNote(null), null);
});

test("loginReason: says where it stopped, what the silent renewal answered and how old the sign-in was, within 200 characters", () => {
  const seen = { endedAt: "auth.rocketaccount.com/u/login", silentTried: true, silentError: "login_required" };
  const now = new Date("2026-11-13T12:20:00Z");
  const state = {
    signedInSince: "2026-11-12T04:16:00Z",
    lastSignedInAt: "2026-11-12T04:17:00Z",
    lastSession: { app: { name: "tb.auth0.sid", sessionOnly: false, minutesLeft: 228 }, signIn: { name: "auth0", sessionOnly: true, minutesLeft: null } },
  };
  const reason = loginReason(BASE, { seen, state, now });
  assert.equal(reason, `${BASE}; at auth.rocketaccount.com/u/login; silent renewal: login_required; last signed in 32.1 h ago; sign-in lasted 0 h; sign-in cookie was browser-session`);
  assert.ok(reason.length <= 200);
  assert.ok(reason.startsWith("login required")); // the /status card and the README key on these words

  // nothing known yet (first run on a fresh profile)
  assert.equal(loginReason(BASE, { seen: { endedAt: "auth.rocketaccount.com/u/login", silentTried: false }, state: {}, now }), `${BASE}; at auth.rocketaccount.com/u/login; never seen signed in`);
  // a silent renewal that got no answer at all
  assert.match(loginReason(BASE, { seen: { endedAt: "auth.rocketaccount.com/u/login", silentTried: true, silentError: null }, state: {}, now }), /silent renewal: no answer/);
  // no details at all: the fixed instruction alone
  assert.equal(loginReason(BASE, { state: { lastSignedInAt: "garbage" }, now }), `${BASE}; never seen signed in`);
  // a short base leaves room for the cookie facts; whatever does not fit is left out whole, never cut mid-word
  const long = loginReason("x", { seen, state, now });
  assert.match(long, /sign-in cookie was browser-session; app session had 228 min left then$/);
  // a persistent sign-in service cookie (as found on 2026-11-13) says how much it had left, and fits with the real addresses
  const persistent = loginReason(BASE, { seen, state: { ...state, lastSession: { ...state.lastSession, signIn: { name: "auth0", sessionOnly: false, minutesLeft: 4300 } } }, now });
  assert.match(persistent, /; sign-in cookie had 72 h left$/);
  assert.ok(persistent.length <= 200);
  // a state file from before this bookkeeping (only lastSuccessAt) still says how old the sign-in is
  assert.equal(loginReason(BASE, { seen: { endedAt: "auth.rocketaccount.com/u/login" }, state: { lastSuccessAt: "2026-11-12T12:20:00Z" }, now }), `${BASE}; at auth.rocketaccount.com/u/login; last signed in 24 h ago`);
  const tight = loginReason("x".repeat(150), { seen, state, now });
  assert.ok(tight.length <= 200);
  assert.match(tight, /; at auth\.rocketaccount\.com\/u\/login$/);
});

test("visitPlan: import after 20 hours, keep-alive in between, and no knocking on the sign-in page while signed out", () => {
  const now = new Date("2026-11-12T20:00:00Z");
  assert.equal(visitPlan({ state: {}, now }).mode, "full");
  assert.equal(visitPlan({ state: { lastAttemptAt: "garbage" }, now }).mode, "full");
  assert.deepEqual(visitPlan({ state: { lastAttemptAt: "2026-11-12T10:00:00Z" }, now }), { mode: "keepalive", hoursSince: 10 });
  assert.equal(visitPlan({ state: { lastAttemptAt: "2026-11-11T23:59:00Z" }, now }).mode, "full");
  assert.equal(visitPlan({ state: { lastAttemptAt: "2026-11-13T10:00:00Z" }, now }).mode, "full"); // clock moved backwards
  assert.equal(visitPlan({ state: { lastAttemptAt: "2026-11-12T19:00:00Z" }, now, force: true }).mode, "full");
  assert.equal(visitPlan({ state: { lastAttemptAt: "2026-11-12T19:00:00Z" }, now, dryRun: true }).mode, "full");

  const out = { signedOutSince: "2026-11-12T08:00:00Z", lastSignedOutCheckAt: "2026-11-12T16:00:00Z", lastVisitEndedAt: "2026-11-12T16:00:10Z", lastAttemptAt: null };
  assert.deepEqual(visitPlan({ state: out, now }), { mode: "skip", hoursSince: 4 });
  // the harvester's own writes at the end of its last visit do not count as "someone used the profile"
  assert.equal(visitPlan({ state: out, now, profileChangedAt: Date.parse("2026-11-12T16:00:40Z") }).mode, "skip");
  assert.equal(visitPlan({ state: out, now, profileChangedAt: Date.parse("2026-11-12T19:30:00Z") }).mode, "full");
  assert.equal(visitPlan({ state: out, now: new Date("2026-11-13T12:00:00Z") }).mode, "full"); // 20 h after the last check
  assert.equal(visitPlan({ state: out, now, force: true }).mode, "full");
  assert.equal(visitPlan({ state: { signedOutSince: "garbage" }, now }).mode, "full");
});

test("signedInPatch / signedOutPatch: the bookkeeping behind 'how long did the sign-in last'", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const endedAt = new Date("2026-11-12T12:00:09Z");
  const first = signedInPatch({}, { now, endedAt, session: null, seen: null });
  assert.deepEqual(first, {
    lastSignedInAt: "2026-11-12T12:00:00.000Z",
    lastVisitEndedAt: "2026-11-12T12:00:09.000Z",
    signedInSince: "2026-11-12T12:00:00.000Z",
    visitsSinceSignIn: 1,
    silentRenewals: 0,
    signedOutSince: null,
    lastSignedOutCheckAt: null,
    lastSession: null,
    keepaliveFailures: 0,
  });
  const next = signedInPatch({ ...first }, { now: new Date("2026-11-12T14:00:00Z"), endedAt, seen: { silentRenewed: true } });
  assert.deepEqual([next.signedInSince, next.visitsSinceSignIn, next.silentRenewals], ["2026-11-12T12:00:00.000Z", 2, 1]);
  // after a signed-out spell the count starts again
  const again = signedInPatch({ ...next, signedOutSince: "2026-11-13T00:00:00Z" }, { now: new Date("2026-11-13T09:00:00Z"), endedAt });
  assert.deepEqual([again.signedInSince, again.visitsSinceSignIn, again.silentRenewals], ["2026-11-13T09:00:00.000Z", 1, 0]);

  const out = signedOutPatch({ lastAttemptAt: "2026-11-12T03:00:00Z" }, { now, endedAt });
  assert.deepEqual(out, { signedOutSince: "2026-11-12T12:00:00.000Z", lastSignedOutCheckAt: "2026-11-12T12:00:00.000Z", lastVisitEndedAt: "2026-11-12T12:00:09.000Z", lastAttemptAt: null });
  // a second look while still signed out keeps the original "since"
  assert.equal(signedOutPatch({ signedOutSince: "2026-11-11T00:00:00.000Z" }, { now, endedAt }).signedOutSince, "2026-11-11T00:00:00.000Z");
});

test("Chrome is never asked to re-open the last tabs, is off-screen unless asked, and has no stealth flags", () => {
  const hidden = launchOptions();
  assert.equal(hidden.channel, "chrome");
  assert.equal(hidden.headless, false);
  assert.deepEqual(hidden.args, ["--window-position=-32000,-32000", "--window-size=1280,900"]);
  assert.deepEqual(launchOptions({ visible: true }).args, ["--window-size=1280,900"]);
  // the window a person signs in with is a plain Chrome on the same profile
  const args = plainChromeArgs("C:\\profiles\\rm", ROCKET_MONEY_SITE.startUrl);
  assert.equal(args[0], "--user-data-dir=C:\\profiles\\rm");
  assert.equal(args.at(-1), "https://app.rocketmoney.com/net-worth");
  for (const a of [...hidden.args, ...args]) assert.equal(/automation|webdriver|stealth|user-agent|headless|restore/i.test(a), false);
});

// --- the read-only guard is on before any page can load ---------------------------------------------------------
// A stand-in for Playwright that records the order of everything done to the browser. No Chrome is started.
// Its Net Worth page sends one mutation of its own and then the read the harvester waits for.
function fakeChromium({ events, netWorthBody = null }) {
  return {
    async launchPersistentContext(_profile, options) {
      events.push(["launch", options.args.join(" ")]);
      let routeHandler = null;
      let routeMatch = null;
      const pages = [];
      const makePage = () => {
        const handlers = {};
        let url = "about:blank";
        const page = {
          on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
          url: () => url,
          mainFrame: () => "main",
          async goto(to) {
            events.push(["goto", to]);
            url = to;
            if (!to.includes("/net-worth") || !netWorthBody) return;
            for (const body of ['{"query":"mutation Touch { touch }"}', '{"query":"query NetWorthQuery { viewer { id } }"}']) {
              const request = { method: () => "POST", postData: () => body, url: () => "https://client-api.rocketmoney.com/graphql", headers: () => ({}), isNavigationRequest: () => false, frame: () => "main" };
              let outcome = "continued";
              if (routeHandler && routeMatch(new URL(request.url()))) {
                await routeHandler({ request: () => request, abort: async () => { outcome = "aborted"; }, continue: async () => {} });
              }
              const kind = body.includes("mutation") ? "mutation" : "query";
              events.push(["api", kind, outcome]);
              if (outcome === "continued" && kind === "query") {
                for (const fn of handlers.response ?? []) await fn({ url: () => request.url(), request: () => request, json: async () => netWorthBody });
              }
            }
          },
          async waitForTimeout() {},
          async close() {
            const i = pages.indexOf(page);
            if (i >= 0) pages.splice(i, 1);
          },
          async evaluate() { return null; },
        };
        return page;
      };
      return {
        async route(match, handler) { events.push(["route"]); routeMatch = match; routeHandler = handler; },
        async newPage() { events.push(["newPage"]); const p = makePage(); pages.push(p); return p; },
        pages: () => [...pages],
        async cookies() { return []; },
        async close() { events.push(["close"]); },
      };
    },
  };
}
const NET_WORTH = { data: { viewer: { netWorth: { cash: [], creditCardDebts: [] } } } };
const kinds = (events) => events.map((e) => e[0]);

test("browser: the guard is the first thing attached after launch, and a mutation the app fires on load is aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-prof-"));
  try {
    const events = [];
    const logs = [];
    const browser = createBrowser({ chromium: fakeChromium({ events, netWorthBody: NET_WORTH }), profile: dir, log: (l) => logs.push(l), pollMs: 0 });
    const result = await browser.capture({ full: false });
    assert.equal(result.status, "ok");
    assert.deepEqual(kinds(events).slice(0, 2), ["launch", "route"], "nothing is opened before the guard");
    assert.deepEqual(events.filter((e) => e[0] === "api"), [["api", "mutation", "aborted"], ["api", "query", "continued"]]);
    assert.ok(logs.includes("blocked 1 mutation request(s) made by the page (read-only guard)"));
    assert.equal(/restore/.test(events[0][1]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachReadOnlyGuard: mutations (single or batched) are aborted, reads and other hosts pass", async () => {
  let match;
  let handler;
  const guard = await attachReadOnlyGuard({ route: async (m, h) => { match = m; handler = h; } }, "client-api.rocketmoney.com");
  assert.equal(match(new URL("https://client-api.rocketmoney.com/graphql")), true);
  assert.equal(match(new URL("https://app.rocketmoney.com/net-worth")), false);
  const send = async (method, body) => {
    let out = null;
    await handler({ request: () => ({ method: () => method, postData: () => body }), abort: async () => { out = "aborted"; }, continue: async () => { out = "continued"; } });
    return out;
  };
  assert.equal(await send("POST", '{"query":"mutation A { a }"}'), "aborted");
  assert.equal(await send("POST", '[{"query":"query Q { q }"},{"query":"mutation B { b }"}]'), "aborted");
  assert.equal(await send("POST", '{"query":"query Q { q }"}'), "continued");
  assert.equal(await send("GET", null), "continued");
  assert.equal(guard.blockedMutations, 2);
});

test("browser: a profile set to re-open its last tabs has them moved to the Recycle Bin BEFORE Chrome starts, and the setting is switched back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-prof-"));
  try {
    mkdirSync(savedTabsPath(dir), { recursive: true });
    writeFileSync(join(dir, "Default", "Secure Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
    const events = [];
    const cleared = [];
    const browser = createBrowser({
      chromium: fakeChromium({ events, netWorthBody: NET_WORTH }),
      profile: dir,
      pollMs: 0,
      clearSavedTabs: async (p) => { events.push(["clear"]); cleared.push(p); return true; },
    });
    assert.equal((await browser.capture({ full: false })).status, "ok");
    assert.deepEqual(cleared, [savedTabsPath(dir)]);
    assert.deepEqual(kinds(events).slice(0, 3), ["clear", "launch", "route"]);
    // the settings page is opened only after the guard, to switch 'On startup' back to the New Tab page
    const settings = events.findIndex((e) => e[0] === "goto" && e[1] === "chrome://settings/onStartup");
    assert.ok(settings > kinds(events).indexOf("route"));

    // If the saved tabs cannot be moved, Chrome is not started at all.
    const events2 = [];
    const refusing = createBrowser({ chromium: fakeChromium({ events: events2 }), profile: dir, clearSavedTabs: async () => false });
    await assert.rejects(refusing.capture({ full: false }), /could not be moved to the Recycle Bin; Chrome was not started/);
    assert.deepEqual(events2, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser: with Chrome's default start-up setting nothing is cleared and no settings page is opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-prof-"));
  try {
    mkdirSync(savedTabsPath(dir), { recursive: true });
    const events = [];
    let asked = 0;
    const browser = createBrowser({ chromium: fakeChromium({ events, netWorthBody: NET_WORTH }), profile: dir, pollMs: 0, clearSavedTabs: async () => { asked++; return true; } });
    assert.equal((await browser.capture({ full: false })).status, "ok");
    assert.equal(asked, 0);
    assert.equal(events.some((e) => e[0] === "goto" && e[1].startsWith("chrome://")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chromeCandidates and profileChangedAt", () => {
  const list = chromeCandidates({ ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" });
  assert.equal(list.length, 3);
  assert.match(list[0], /^C:\\PF[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
  assert.deepEqual(chromeCandidates({}), []);

  const dir = mkdtempSync(join(tmpdir(), "rm-prof-"));
  try {
    assert.equal(profileChangedAt(dir), null); // a profile Chrome never opened
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(join(dir, "Default", "Network", "Cookies"), "");
    const at = profileChangedAt(dir);
    assert.ok(typeof at === "number" && Math.abs(at - Date.now()) < 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreSettingIsOn reads the profile's 'Continue where you left off' setting from its settings files, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-prof-"));
  try {
    assert.equal(restoreSettingIsOn(dir), false); // no profile yet
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Normal" } }));
    assert.equal(restoreSettingIsOn(dir), false); // Chrome's default: open the New Tab page
    writeFileSync(join(dir, "Default", "Secure Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
    assert.equal(restoreSettingIsOn(dir), true);
    writeFileSync(join(dir, "Default", "Secure Preferences"), JSON.stringify({ session: { restore_on_startup: 5 } }));
    assert.equal(restoreSettingIsOn(dir), false);
    writeFileSync(join(dir, "Default", "Secure Preferences"), "{ not json");
    assert.equal(restoreSettingIsOn(dir), false); // unreadable is "not on", never a crash
    writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
    assert.equal(restoreSettingIsOn(dir), true); // builds that keep it in the plain file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
