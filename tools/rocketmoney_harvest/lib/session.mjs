// Pure helpers for keeping the Rocket Money sign-in alive and for saying what was seen when it is lost.
// No Playwright, no network, no file access: everything here is driven with plain values in the tests.
//
// What the sign-in looks like (read from the harvester profile on 2026-11-13, names, hosts and times only):
//   - app.rocketmoney.com talks to client-api.rocketmoney.com, which holds the session in ONE cookie. That
//     cookie is not a browser-session cookie (it survived two clean browser restarts) and it was gone
//     8 hours later. An independent open-source client describes it as rolling: every answer from the API
//     re-issues it for about 3 h 48 min. That figure is not measured here yet; the harvester logs the real
//     one after every signed-in visit (the "session cookies:" line). A once-a-day visit can never keep it.
//   - When it is gone the app asks the sign-in service (auth.rocketaccount.com) to renew it silently
//     (/authorize?prompt=none). That works only while the sign-in service still knows the browser.
//   - The sign-in service's cookies (auth0 and auth0_compat on auth.rocketaccount.com) ARE in the profile:
//     persistent (on disk, kept across browser restarts), HttpOnly, expiring 72 h after they were issued
//     (Auth0's default idle limit is 3 days). So Chrome did not throw them away; the silent renewal that
//     answered login_required 8 hours after the 2026-11-11 sign-in was most likely refused by the service
//     itself. Caveat: the cookie seen was issued on the signed-out sign-in page; the one issued at sign-in
//     could not be inspected.
//   - No token in local storage or IndexedDB (the Uber Eats and Kindle profiles each hold a sign-in cookie
//     good for 6 to 12 months, which is why those two stay signed in for weeks with the same launch code).
// So the harvester (1) visits every 2 hours so the rolling app cookie never lapses while the PC is awake
// (2 h is also far inside the sign-in service's 72 h), (2) follows the silent renewal round trip instead of
// calling the first redirect "signed out", and (3) records what it saw, so the next failure explains itself.
// Expected, not yet proven: a sleep longer than the app cookie's lifetime ends the sign-in (the renewal was
// refused once while the PC was awake). The first post-sleep "signed in:" or "FAILED: login required" line
// in harvest.log settles it.
import { APP_HOST, GRAPHQL_HOST, MIN_HOURS_BETWEEN_RUNS } from "./harvest-core.mjs";

export const AUTH_HOST = "auth.rocketaccount.com";
export const DEFAULT_HOSTS = Object.freeze({ app: APP_HOST, api: GRAPHQL_HOST, auth: AUTH_HOST });

/** The scheduled task's interval. Must stay well under the app session's rolling lifetime (about 3 h 48 min). */
export const KEEPALIVE_HOURS = 2;
/** The sign-in service's cookies (auth0 / auth0_compat) expire this long after they are issued (read from the profile). */
export const SIGNIN_SERVICE_HOURS = 72;
/** Below this, a signed-in visit notes that the sign-in service's cookie is running out. */
export const SIGNIN_SERVICE_NOTE_HOURS = 24;
/** While signed out, the app is opened again at most this often (or as soon as someone used the profile). */
export const SIGNED_OUT_RECHECK_HOURS = MIN_HOURS_BETWEEN_RUNS;
/** The longest reason a heartbeat keeps (lib/normalize.mjs safeError cuts at 200). */
export const MAX_REASON_CHARS = 200;

const maskIds = (path) => path.replace(/[0-9a-zA-Z_-]{20,}/g, "~").replace(/\d{5,}/g, "~");

/**
 * Where is the page?
 *   'app'     the Rocket Money app (signed in, or about to bounce: only loaded data proves which)
 *   'signin'  a screen that waits for a person (the sign-in service's own pages, or the app's /login)
 *   'transit' a hop of the sign-in round trip (API login / callback, /authorize), a blank page, anything else
 */
export function classifyUrl(url, hosts = DEFAULT_HOSTS) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "transit";
  }
  if (u.hostname === hosts.app) return /^\/(login|signin|sign-in)\b/i.test(u.pathname) ? "signin" : "app";
  if (u.hostname === hosts.auth) return /^\/authorize\b/i.test(u.pathname) ? "transit" : "signin";
  return "transit";
}

/**
 * One navigation hop, safe to log: host and path only (long ids masked), plus the value of an `error` query
 * parameter when it is a plain OAuth error word such as login_required. No other query value is ever kept.
 */
export function describeHop(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { where: u.protocol.replace(":", ""), error: null, silent: false };
    const error = u.searchParams.get("error");
    return {
      where: `${u.hostname}${maskIds(u.pathname)}`.slice(0, 80),
      error: error && /^[a-z_]{3,40}$/.test(error) ? error : null,
      silent: /^\/authorize\b/i.test(u.pathname) && u.searchParams.get("prompt") === "none",
    };
  } catch {
    return { where: "unreadable address", error: null, silent: false };
  }
}

/**
 * Sums up the main-frame navigations of one visit: was a silent renewal tried, how did it end, where did the
 * page come to rest. `finalUrl` is the address the page was on when the visit was judged.
 */
export function summarizeRoundTrip(hops, finalUrl) {
  const list = Array.isArray(hops) ? hops : [];
  const silentTried = list.some((h) => h.silent);
  const silentError = list.find((h) => h.error)?.error ?? null;
  return {
    endedAt: finalUrl ? describeHop(finalUrl).where : (list.at(-1)?.where ?? null),
    hops: list.length,
    silentTried,
    silentError,
    // 'renewed' = a silent renewal was tried and nothing refused it; whether the visit then counted as signed
    // in is decided by the data loading, not here.
    silentRenewed: silentTried && !silentError,
    path: list.slice(0, 12).map((h) => (h.error ? `${h.where} (${h.error})` : h.where)).join(" > "),
  };
}

/**
 * Decides, from repeated looks at the page, whether a visit is signed in. Pure: feed it the address, the
 * milliseconds since the visit started and whether the wanted data has arrived.
 *   signed_in       the data arrived (only a signed-in session gets it)
 *   login_required  the page rests on a screen that waits for a person
 *   stuck           the round trip stopped somewhere that is neither the app nor a sign-in screen
 *   timeout         on the app, but the data never came
 *   waiting         keep looking
 * A redirect hop is never judged on its own: the silent renewal passes through the API and the sign-in
 * service for a second or two before it lands back on the app.
 */
export function createLandingJudge({ hosts = DEFAULT_HOSTS, signinRestMs = 3000, transitRestMs = 20000, totalMs = 45000 } = {}) {
  let kind = null;
  let since = 0;
  return {
    update({ url, t, loaded }) {
      if (loaded) return { status: "signed_in" };
      const k = classifyUrl(url, hosts);
      if (k !== kind) {
        kind = k;
        since = t;
      }
      const rested = t - since;
      const where = describeHop(url).where;
      if (k === "signin" && rested >= signinRestMs) return { status: "login_required", where };
      if (k === "transit" && rested >= transitRestMs) return { status: "stuck", where };
      if (t >= totalMs) return k === "app" ? { status: "timeout", where } : k === "signin" ? { status: "login_required", where } : { status: "stuck", where };
      return { status: "waiting" };
    },
  };
}

// Cookies that sit on the same hosts but are not the sign-in (load balancer, analytics, bot checks, one-off
// round-trip state). Names only; used when the known session cookie name is not present.
const NOT_A_SESSION = /^(AWSALB|AWSALBCORS|FPID|browser_uid|auth_verification|did|did_compat|ak_bmsc|bm_[a-z]+|_abck|__cf_bm|m)$/;
const APP_SESSION_NAME = "tb.auth0.sid";
const SIGNIN_SESSION_NAMES = ["auth0", "auth0_compat"];

const hostMatches = (domain, host) => {
  const d = String(domain ?? "").replace(/^\./, "");
  return d === host || host.endsWith(`.${d}`);
};

function cookieFacts(c, nowMs) {
  const sessionOnly = !(typeof c.expires === "number" && c.expires > 0);
  return {
    name: String(c.name).slice(0, 40),
    sessionOnly,
    minutesLeft: sessionOnly ? null : Math.round((c.expires * 1000 - nowMs) / 60000),
  };
}

/**
 * What kind of cookies hold the sign-in right now: names, whether each dies with the browser, and how many
 * minutes it has left. Takes Playwright-style cookies ({ name, domain, expires (seconds, -1 = browser
 * session), httpOnly }); values are never read. This is the line to look at after a sign-in.
 */
export function summarizeSessionCookies(cookies, nowMs, hosts = DEFAULT_HOSTS) {
  const list = (Array.isArray(cookies) ? cookies : []).filter((c) => c && typeof c.name === "string");
  const onApp = list.filter((c) => hostMatches(c.domain, hosts.app) || hostMatches(c.domain, hosts.api));
  const known = onApp.find((c) => c.name === APP_SESSION_NAME);
  const guesses = onApp.filter((c) => c.httpOnly && !NOT_A_SESSION.test(c.name));
  const app = known ?? guesses[0] ?? null;
  const signIn = SIGNIN_SESSION_NAMES.map((n) => list.find((c) => c.name === n && hostMatches(c.domain, hosts.auth))).find(Boolean) ?? null;
  return {
    app: app ? { ...cookieFacts(app, nowMs), guessed: !known } : null,
    signIn: signIn ? cookieFacts(signIn, nowMs) : null,
    browserSessionOnly: list.filter((c) => !(typeof c.expires === "number" && c.expires > 0)).length,
  };
}

const lifetimeWords = (c) => (c.sessionOnly ? "browser-session only" : `${c.minutesLeft} min left`);

/** One log line for the summary above (names and lifetimes only). */
export function sessionLine(summary) {
  if (!summary) return "session cookies: not read";
  const app = summary.app ? `app ${summary.app.name}${summary.app.guessed ? " (guessed)" : ""}: ${lifetimeWords(summary.app)}` : "app session cookie: not found";
  const signIn = summary.signIn ? `sign-in service ${summary.signIn.name}: ${lifetimeWords(summary.signIn)}` : "sign-in service cookie: not found";
  return `session cookies: ${app}; ${signIn}; ${summary.browserSessionOnly} browser-session cookie(s), gone when Chrome closes`;
}

/** A warning when the app session would run out before the next scheduled visit, else null. */
export function scheduleWarning(summary, keepaliveHours = KEEPALIVE_HOURS) {
  const left = summary?.app?.minutesLeft;
  if (typeof left !== "number") return null;
  const need = keepaliveHours * 60 + 15;
  return left < need ? `WARNING: the app session has ${left} min left, less than the ${keepaliveHours}-hour schedule needs (${need} min): shorten the task interval in register-task.ps1` : null;
}

/**
 * A note when the sign-in service's cookie can no longer back a silent renewal for long, else null. While the
 * keep-alive holds the app session this does not matter; it decides whether a lapse (a long sleep) can be
 * renewed without a sign-in.
 */
export function signInServiceNote(summary, noteHours = SIGNIN_SERVICE_NOTE_HOURS) {
  const s = summary?.signIn;
  if (!s) return null;
  if (s.sessionOnly) return "NOTE: the sign-in service's cookie is browser-session only here (it was persistent, 72 h, on 2026-11-13): if Chrome discards it, a lapsed app session cannot be renewed without a sign-in";
  if (typeof s.minutesLeft === "number" && s.minutesLeft < noteHours * 60) return `NOTE: the sign-in service's cookie has ${Math.max(0, Math.round(s.minutesLeft / 60))} h left; after that a lapsed app session cannot be renewed without a sign-in`;
  return null;
}

const hoursBetween = (a, b) => {
  const x = Date.parse(a);
  const y = b instanceof Date ? b.getTime() : Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round(((y - x) / 36e5) * 10) / 10 : null;
};

/**
 * The failure text for a lost sign-in: the fixed instruction first, then what was seen, most useful first,
 * for as long as it fits a heartbeat (200 characters). `seen` is summarizeRoundTrip's result; `state` is the
 * harvester's state.json as it was BEFORE this visit.
 */
export function loginReason(base, { seen, state = {}, now = new Date() } = {}) {
  const parts = [];
  if (seen?.endedAt) parts.push(`at ${seen.endedAt}`);
  if (seen?.silentTried) parts.push(`silent renewal: ${seen.silentError ?? "no answer"}`);
  // State files written before the sign-in bookkeeping existed only have lastSuccessAt (a successful import
  // is a signed-in visit too).
  const lastSeen = state.lastSignedInAt ?? state.lastSuccessAt ?? null;
  const sinceVisit = lastSeen ? hoursBetween(lastSeen, now) : null;
  if (sinceVisit === null) parts.push("never seen signed in");
  else {
    parts.push(`last signed in ${sinceVisit} h ago`);
    const lasted = state.signedInSince && state.lastSignedInAt ? hoursBetween(state.signedInSince, state.lastSignedInAt) : null;
    if (lasted !== null) parts.push(`sign-in lasted ${lasted} h`);
    const signIn = state.lastSession?.signIn;
    if (signIn) parts.push(signIn.sessionOnly ? "sign-in cookie was browser-session" : `sign-in cookie had ${Math.round((signIn.minutesLeft ?? 0) / 60)} h left`);
    const left = state.lastSession?.app?.minutesLeft;
    if (typeof left === "number") parts.push(`app session had ${left} min left then`);
  }
  let out = base;
  for (const p of parts) {
    const next = `${out}; ${p}`;
    if (next.length > MAX_REASON_CHARS) break;
    out = next;
  }
  return out;
}

/**
 * What this run should do.
 *   full       read and import (first run, 20 hours since the last import, --force, --dry-run, or the first
 *              look after being signed out)
 *   keepalive  open the app, let it renew the session, write nothing to the database
 *   skip       signed out and nothing has changed: do not knock on the sign-in page again yet
 * `profileChangedAt` is when the browser profile's cookie file last changed (ms), or null: a change after the
 * harvester's own last visit means someone opened that profile, most likely to sign in.
 */
export function visitPlan({ state = {}, now = new Date(), force = false, dryRun = false, profileChangedAt = null, minHours = MIN_HOURS_BETWEEN_RUNS }) {
  if (force) return { mode: "full", why: "--force" };
  if (dryRun) return { mode: "full", why: "--dry-run" };
  if (state.signedOutSince) {
    const lastCheck = Date.parse(state.lastSignedOutCheckAt ?? state.signedOutSince);
    const hours = (now.getTime() - lastCheck) / 36e5;
    const ended = Date.parse(state.lastVisitEndedAt ?? "");
    const used = typeof profileChangedAt === "number" && Number.isFinite(ended) && profileChangedAt > ended + 60_000;
    if (used) return { mode: "full", why: "the browser profile was used since the last check" };
    if (!Number.isFinite(hours) || hours < 0 || hours >= SIGNED_OUT_RECHECK_HOURS) return { mode: "full", why: "time to check the sign-in again" };
    return { mode: "skip", hoursSince: Math.round(hours * 10) / 10 };
  }
  const last = Date.parse(state.lastAttemptAt ?? "");
  if (!Number.isFinite(last)) return { mode: "full", why: "no earlier import on record" };
  const hours = (now.getTime() - last) / 36e5;
  if (hours < 0 || hours >= minHours) return { mode: "full", why: `${minHours} hours since the last import` };
  return { mode: "keepalive", hoursSince: Math.round(hours * 10) / 10 };
}

/** The state.json fields to write after a visit that was signed in. */
export function signedInPatch(state = {}, { now = new Date(), endedAt = new Date(), session = null, seen = null } = {}) {
  const continuing = Boolean(state.signedInSince) && !state.signedOutSince;
  return {
    lastSignedInAt: now.toISOString(),
    lastVisitEndedAt: endedAt.toISOString(),
    signedInSince: continuing ? state.signedInSince : now.toISOString(),
    visitsSinceSignIn: (continuing ? Number(state.visitsSinceSignIn) || 0 : 0) + 1,
    silentRenewals: (continuing ? Number(state.silentRenewals) || 0 : 0) + (seen?.silentRenewed ? 1 : 0),
    signedOutSince: null,
    lastSignedOutCheckAt: null,
    lastSession: session,
    // A signed-in visit ends any run of failed keep-alive visits.
    keepaliveFailures: 0,
  };
}

/** The state.json fields to write after a visit that found the profile signed out. */
export function signedOutPatch(state = {}, { now = new Date(), endedAt = new Date() } = {}) {
  return {
    signedOutSince: state.signedOutSince ?? now.toISOString(),
    lastSignedOutCheckAt: now.toISOString(),
    lastVisitEndedAt: endedAt.toISOString(),
    // The first signed-in visit must import straight away, whatever the 20-hour rule says.
    lastAttemptAt: null,
  };
}
