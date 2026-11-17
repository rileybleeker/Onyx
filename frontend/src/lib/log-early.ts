/**
 * The Log screen's first reads (AGENTS.md "Log screen"), started by a script in the head of /log
 * (app/log/EarlyReads.tsx) instead of after the page's JavaScript, the section chunks and their mount (speed budget,
 * 2026-11-15: the cold first visit took about 1.4 s, its 9 reads only starting at about 670 ms). Each section takes
 * its answer once on its first load, on the routed page only (never a copy in the continuous scroll), through
 * `logEarlyGet` (lib/early-fetch.ts `earlyOr`: a 401, a redirect to sign-in or a network error is fetched again).
 *
 * READ-ONLY by design: only GETs that write nothing, mark nothing read and reveal nothing (no experiment read).
 * Every URL is the one the section builds (the sections import these constants; tests/early-fetch.test.cjs checks
 * the script against them). The Uber Eats dishes and heartbeat are Supabase reads (supabase-js), which a plain
 * script cannot start; LogLoader starts those when the page's own JavaScript runs (app/log/early-delivery.ts).
 */
import { earlyFetchWrap, earlyOr } from "@/lib/early-fetch";

/** The embedded check-in's day (no `?date=`: /log opens on the server's today). */
export const LOG_CHECKIN_URL = "/api/habits/checkin";
export const LOG_WEIGHT_URL = "/api/weight?days=365";
export const LOG_READING_URL = "/api/reading";
export const LOG_SUPPLEMENTS_TODAY_URL = "/api/supplements/today";
export const LOG_SUPPLEMENTS_STACKS_URL = "/api/supplements/stacks";
export const LOG_SUPPLEMENTS_PRODUCTS_URL = "/api/supplements/products";
/** Orders the Supplements section's product options (most used first); the options never wait for it. */
export const LOG_SUPPLEMENTS_HISTORY_URL = "/api/supplements/history?days=30&perPage=200";
/** Same as BEHAVIORAL_TODAY_URL in lib/log-ubereats.ts (the Uber Eats section's day). */
export const LOG_BEHAVIORAL_TODAY_URL = "/api/behavioral-today";
/**
 * The Drinks section's first read: behavioral today's drinks (DRINKS_URL in lib/drink-capture.ts, no `?day=`). GET
 * only, read-only (PERF-01: it used to start only once the section had mounted, the last read of a cold /log).
 */
export const LOG_DRINKS_URL = "/api/nutrition/drinks";
/** Prefix of journalTodayUrl() in lib/journal-file.ts: `?from=<New York date>&to=<same>&limit=20`. */
export const LOG_JOURNAL_LIST_PATH = "/api/journal/list";

/**
 * Set by the script (the time it ran): marks a full page load of /log, so LogLoader starts the Uber Eats section's
 * Supabase reads (app/log/early-delivery.ts) only then, never for an in-app visit or a copy in the scroll.
 */
export const LOG_EARLY_MARK = "__onyxLogEarly";

/** The fixed same-origin GETs, fetched exactly as the sections fetch them (`cache: "no-store"`). */
export const LOG_EARLY_GETS = [
  LOG_CHECKIN_URL,
  LOG_SUPPLEMENTS_TODAY_URL,
  LOG_SUPPLEMENTS_STACKS_URL,
  LOG_SUPPLEMENTS_PRODUCTS_URL,
  LOG_SUPPLEMENTS_HISTORY_URL,
  LOG_WEIGHT_URL,
  LOG_READING_URL,
  LOG_BEHAVIORAL_TODAY_URL,
  LOG_DRINKS_URL,
] as const;

/**
 * Plain-ES5 script for /log: the mark above, the fixed GETs, then today's journal list for the New York date
 * (the same Intl call as easternDate() in lib/journal-entry.ts). Never throws; a failure leaves a read to its section.
 */
export function logEarlyScript(): string {
  const same =
    `w[${JSON.stringify(LOG_EARLY_MARK)}]=Date.now();` +
    `var o={cache:"no-store",credentials:"same-origin"},l=${JSON.stringify(LOG_EARLY_GETS)},i;for(i=0;i<l.length;i++)go(l[i],o);`;
  const journal =
    `try{var f=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()),q={};` +
    `for(i=0;i<f.length;i++)q[f[i].type]=f[i].value;var D=q.year+"-"+q.month+"-"+q.day;` +
    `if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(D))go(${JSON.stringify(LOG_JOURNAL_LIST_PATH)}+"?from="+D+"&to="+D+"&limit=20",o);}catch(e){}`;
  return earlyFetchWrap(same + journal);
}

/**
 * A /log section's GET for the client cache (`cachedJson(url, { get })`): the answer the page's HTML started for
 * `url`, taken once, else the section's usual fetch. undefined in a copy drawn in the continuous scroll, which never
 * takes an early answer.
 */
export function logEarlyGet(url: string, routed: boolean): (() => Promise<Response>) | undefined {
  if (!routed) return undefined;
  return () => earlyOr(url, () => fetch(url, { cache: "no-store" }));
}

/**
 * True while the head script's mark is present and still fresh (10 s): a full page load of /log is in progress.
 * Reads WITHOUT consuming, so a caller may poll for it (app/log/early-delivery-start.ts: the starter module can be
 * evaluated before the head script has set the mark). False for an in-app visit or a copy in the continuous scroll
 * (no script ran, so no mark exists).
 */
export function peekLogEarlyMark(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  const at = (window as unknown as Record<string, unknown>)[LOG_EARLY_MARK];
  return typeof at === "number" && now - at >= 0 && now - at < 10_000;
}

/**
 * True once per full page load of /log, and consumes the mark (a second call returns false): the caller then
 * starts the early reads. Check first with peekLogEarlyMark() when the head script may not have run yet.
 */
export function takeLogEarlyMark(now = Date.now()): boolean {
  if (!peekLogEarlyMark(now)) return false;
  delete (window as unknown as Record<string, unknown>)[LOG_EARLY_MARK];
  return true;
}
