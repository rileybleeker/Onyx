/**
 * A page's own first GET, started by an inline script in the server HTML while the page's scripts are still
 * downloading (speed budget, 2026-11-15): on a first visit the request used to wait for the JavaScript and for
 * hydration, about half a second, before it was even sent. The client takes the response once, for the same URL,
 * while it is fresh; otherwise it fetches as usual. GET only, same origin, nothing written.
 *
 * Import-free on purpose: the script text is built here so the page and the client agree on the key and the URL.
 */

export const EARLY_FETCH_KEY = "__onyxEarlyFetch";
/** An answer older than this is not used (a page left in the background, a restored tab). */
export const EARLY_FETCH_MAX_AGE_MS = 10_000;

interface EarlyFetch {
  url: string;
  at: number;
  p: Promise<Response>;
}

/**
 * Inline script (plain ES5) for a page whose first read is `path`, with the page's `?date=` copied onto it when
 * `withDate` (as the client builds its URL). Never throws.
 */
export function earlyFetchScript(path: string, withDate = false): string {
  const p = JSON.stringify(path);
  const date = withDate
    ? `var d=new URLSearchParams(location.search).get("date");if(d)u+="?date="+encodeURIComponent(d);`
    : "";
  return `(function(){try{var u=${p};${date}window[${JSON.stringify(EARLY_FETCH_KEY)}]={url:u,at:Date.now(),p:fetch(u,{cache:"no-store",credentials:"same-origin"})};}catch(e){}})();`;
}

/** The early response for `url`, once; null when there is none, it is for another URL or it is too old. */
export function takeEarlyFetch(url: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, EarlyFetch | undefined>;
  const e = w[EARLY_FETCH_KEY];
  if (!e) return null;
  w[EARLY_FETCH_KEY] = undefined;
  if (e.url !== url || !(now - e.at < EARLY_FETCH_MAX_AGE_MS)) {
    // Unused: let it finish quietly.
    e.p.catch(() => {});
    return null;
  }
  return e.p;
}
