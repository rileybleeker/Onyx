/**
 * A page's own first GETs, started by an inline script in the server HTML while the page's scripts are still
 * downloading (speed budget, 2026-11-15): on a first visit the requests used to wait for the JavaScript and for
 * hydration, about half a second, before they were even sent. The client takes each response once, for the same
 * URL, while it is fresh; otherwise it fetches as usual. GET only, nothing written; the request options mirror the
 * client's own fetch for that URL.
 *
 * Used by /check-in, Today (`/` and `/today`, lib/today-early.ts) and /status. Only a full page load runs the
 * script: React never runs a script it inserts itself (an in-app navigation, the continuous scroll).
 *
 * Import-free on purpose: the script text is built here so the page and the client agree on the key and the URLs.
 */

export const EARLY_FETCH_KEY = "__onyxEarlyFetch";
/** An answer older than this is not used (a page left in the background, a restored tab). */
export const EARLY_FETCH_MAX_AGE_MS = 10_000;

interface EarlyFetch {
  at: number;
  p: Promise<Response>;
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
 * one. Plain ES5, never throws.
 */
export function earlyFetchPrelude(): string {
  const k = JSON.stringify(EARLY_FETCH_KEY);
  return `var w=window,m=w[${k}]||(w[${k}]={}),go=function(u,o){try{m[u]={at:Date.now(),p:fetch(u,o)};}catch(e){}};`;
}

/** Wraps a script body (which may use `m` and `go`) so nothing it does can break the page. */
export function earlyFetchWrap(body: string): string {
  return `(function(){try{${earlyFetchPrelude()}${body}}catch(e){}})();`;
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

/** The early response for `url`, once; null when there is none or it is too old. */
export function takeEarlyFetch(url: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const m = (window as unknown as Record<string, EarlyFetches | undefined>)[EARLY_FETCH_KEY];
  if (!m || typeof m !== "object") return null;
  const e = m[url];
  delete m[url];
  if (!e) return null;
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
