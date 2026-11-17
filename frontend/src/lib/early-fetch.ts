/**
 * A page's own first GETs, started by an inline script in the server HTML while the page's scripts are still
 * downloading (speed budget, 2026-11-15): on a first visit the requests used to wait for the JavaScript and for
 * hydration, about half a second, before they were even sent. The client takes each response once, for the same
 * URL, while it is fresh; otherwise it fetches as usual. GET only, nothing written; the request options mirror the
 * client's own fetch for that URL.
 *
 * Used by /check-in and /status (an inline script, below) and by Today (`/` and `/today`, lib/today-early.ts), /log
 * (lib/log-early.ts) and /agents (head script, next paragraph). Only a full page load starts reads: React never runs
 * an inline script it inserts itself (an in-app navigation, the continuous scroll), and the head script below checks
 * for itself that the document is still loading.
 *
 * Today, /log and /agents load theirs from the HEAD instead (`earlyScriptSrc`, PERF-01, 2026-11-16): an inline
 * script in the body waits until every stylesheet before it has loaded (HTML spec: a parser-inserted classic script
 * waits for script-blocking style sheets), and the sidebar's inline boot script stops the parser even earlier, so on
 * a cold first visit those reads only left the browser once the CSS had arrived over the network.
 * `<script async src="data:...">` is hoisted into the head by React and an async script never waits for a
 * stylesheet, so they start as soon as the head is parsed. React does run an async script it inserts on an in-app
 * navigation, so every script built by `earlyFetchWrap` does nothing once the document has finished loading.
 *
 * Import-free on purpose: the script text is built here so the page and the client agree on the key and the URLs.
 */

export const EARLY_FETCH_KEY = "__onyxEarlyFetch";
/** An answer older than this is not used (a page left in the background, a restored tab). */
export const EARLY_FETCH_MAX_AGE_MS = 10_000;

interface EarlyFetch {
  at: number;
  /** null on a claim: the client already took this URL or fetched it for itself. */
  p: Promise<Response> | null;
  /** true when `at` marks the moment the client consumed this URL, not the moment a read started. */
  claimed?: boolean;
}
type EarlyFetches = Record<string, EarlyFetch | undefined>;

/** Plain-ES5 request options for the script; `no-store` is the default, as the clients fetch with it. */
export interface EarlyInit {
  /** false: the browser's default cache mode (a client that fetches without `cache: "no-store"`). */
  noStore?: boolean;
}

function initText(init: EarlyInit = {}): string {
  return init.noStore === false ? `{credentials:"same-origin"}` : `{cache:"no-store",credentials:"same-origin"}`;
}

/**
 * The start of every early-fetch script: `m` is the map of started GETs (URL -> {at, p}) and `go(url, init)` starts
 * one, unless the same URL was started and not yet taken within EARLY_FETCH_MAX_AGE_MS (a script that runs twice in
 * one page load never sends a read twice or orphans the first answer). A claim the client wrote ({at, p: null}) counts
 * as a fresh entry too: the client took the URL or fetched it for itself, so a script that runs later (the document is
 * still "interactive" while the page's own fetch went out first) starts nothing and no duplicate read is orphaned.
 * Plain ES5, never throws.
 */
export function earlyFetchPrelude(): string {
  const k = JSON.stringify(EARLY_FETCH_KEY);
  return (
    `var w=window,m=w[${k}]||(w[${k}]={}),go=function(u,o){try{var s=m[u];` +
    `if(s&&Date.now()-s.at<${EARLY_FETCH_MAX_AGE_MS})return;m[u]={at:Date.now(),p:fetch(u,o)};}catch(e){}};`
  );
}

/**
 * Plain-ES5 condition: true once the document has finished loading, which means the script was inserted by React on
 * an in-app navigation, where the page reads for itself and an early read would only be a second, unused request.
 * `readyState === "complete"` is never true while a full page load is still running a script of this kind: an inline
 * script runs while the parser runs ("loading"), and an async script in the head delays the load event, so it runs
 * before "complete" however late it is. It does not depend on Next's own globals, so a late run on a slow or busy
 * load cannot be mistaken for an in-app navigation. A navigation made before the load event (state "interactive")
 * starts the reads too; the page then takes them instead of fetching for itself, so nothing is wasted.
 */
export const EARLY_APP_RUNNING = `document.readyState==="complete"`;

/** Wraps a script body (which may use `m` and `go`) so nothing it does can break the page. */
export function earlyFetchWrap(body: string): string {
  return `(function(){try{${earlyFetchPrelude()}if(${EARLY_APP_RUNNING})return;${body}}catch(e){}})();`;
}

/**
 * The `src` for `<script async src={...} />`: the script as a data: URL. React hoists an async script with a src into
 * the head, where it runs as soon as it is parsed instead of after the stylesheets (see the top of this file). Same
 * script text, so the same URLs and keys as the inline form.
 */
export function earlyScriptSrc(script: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`;
}

/**
 * Inline script (plain ES5) for a page whose first read is `path`, with the page's `?date=` copied onto it when
 * `withDate` (as the client builds its URL). Never throws.
 */
export function earlyFetchScript(path: string, withDate = false, init?: EarlyInit): string {
  const p = JSON.stringify(path);
  const date = withDate
    ? `var d=new URLSearchParams(location.search).get("date");if(d)u+="?date="+encodeURIComponent(d);`
    : "";
  return earlyFetchWrap(`var u=${p};${date}go(u,${initText(init)});`);
}

/** Inline script (plain ES5) that starts several fixed same-origin GETs at once. Never throws. */
export function earlyFetchesScript(paths: readonly string[], init?: EarlyInit): string {
  return earlyFetchWrap(`var o=${initText(init)},l=${JSON.stringify(paths)};for(var i=0;i<l.length;i++)go(l[i],o);`);
}

/**
 * The early response for `url`, once; null when there is none or it is too old. Taking the URL (or finding nothing,
 * which is the client's fallback path in earlyOr) writes a claim into the map — "consumed by the client at time T" —
 * so a head script that runs later (the document can still be "interactive" after React has already rendered and
 * fetched) does not start the same URL again and orphan a duplicate read. The claim ages out with
 * EARLY_FETCH_MAX_AGE_MS like any entry.
 */
export function takeEarlyFetch(url: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, EarlyFetches | undefined>;
  let m = w[EARLY_FETCH_KEY];
  if (!m || typeof m !== "object") {
    m = {};
    w[EARLY_FETCH_KEY] = m;
  }
  const e = m[url];
  m[url] = { at: now, p: null, claimed: true };
  if (!e || !e.p) return null;
  if (!(now - e.at < EARLY_FETCH_MAX_AGE_MS)) {
    // Unused: let it finish quietly.
    e.p.catch(() => {});
    return null;
  }
  return e.p;
}

/**
 * The early answer for `url` when it can be used, else `fallback()`. A sign-in failure (401, or redirected to
 * /login) and a network error are fetched again with the client's own fetch, so the app's session-end handling
 * (components/AppData.tsx watches window.fetch, which the inline script ran before) sees them as before.
 */
export async function earlyOr(url: string, fallback: () => Promise<Response>, now = Date.now()): Promise<Response> {
  const p = takeEarlyFetch(url, now);
  if (p) {
    const res = await p.catch(() => null);
    if (res && res.status !== 401 && !res.redirected) return res;
  }
  return fallback();
}
