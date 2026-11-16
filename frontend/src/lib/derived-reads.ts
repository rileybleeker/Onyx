// Owner-only facade over the pds materialized views (*_mat), browser side (SEC-01-B, 2026-11-16).
//
// Postgres has no row security on a materialized view, so a direct Data API read of one by ANY signed-in
// account would see every row (the base tables answer only the owner, through owner_read). The browser
// therefore never reads a matview. Each name below is ONE fixed query (explicit columns, the page's own
// filters) that runs on the server with the service role: in a route handler or an ISR prefetch the query
// functions in lib/queries.ts / lib/queries-hrv.ts read the matview directly, and in the browser they call
// GET /api/derived/<name>[?since=YYYY-MM-DD] instead (app/api/derived/[read]/route.ts: owner session via
// middleware, deliberately NOT in isCiRoute; same-origin; no-store). Same query either way, so the ISR seed
// and the browser's silent revalidation cannot diverge, and the browser still makes one request per read.
//
// Import-free on purpose: both query modules (both runtimes), the route and the offline tests load it.

/** Each read and its lower date bound: required, optional (absent = all time) or not accepted. */
export const DERIVED_READS = {
  nutrition: "required",
  "caffeine-hrv": "required",
  "running-recovery": "required",
  "health-matrix": "required",
  "historical-hrv": "required",
  "spotify-volume": "optional",
  "spotify-drift": "optional",
  "sweet-spot": "none",
} as const satisfies Record<string, "required" | "optional" | "none">;

export type DerivedRead = keyof typeof DERIVED_READS;

export const DERIVED_PATH = "/api/derived";

export function isDerivedRead(name: unknown): name is DerivedRead {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(DERIVED_READS, name);
}

/**
 * A real calendar date YYYY-MM-DD from 1900 through 2199, else null. The "all" ranges ask for rangeDays("all")
 * = 36500 days back, a date in the 1920s, so the lower bound stays well before that.
 */
export function parseSince(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1900 || y > 2199) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? value : null;
}

/** The `since` query value checked against the read's rule (null = no bound). */
export function checkSince(name: DerivedRead, raw: string | null): { ok: true; since: string | null } | { ok: false } {
  const rule: string = DERIVED_READS[name];
  if (raw === null) return rule === "required" ? { ok: false } : { ok: true, since: null };
  if (rule === "none") return { ok: false };
  const since = parseSince(raw);
  return since === null ? { ok: false } : { ok: true, since };
}

export function derivedUrl(name: DerivedRead, since: string | null = null): string {
  return since === null ? `${DERIVED_PATH}/${name}` : `${DERIVED_PATH}/${name}?since=${since}`;
}

/** True in the browser, where the matview reads go through the facade. */
export function inBrowser(): boolean {
  return typeof window !== "undefined";
}

/** The server-side reader refuses to run in the browser (a direct matview read there is the leak this closes). */
export function assertServerRead(name: DerivedRead): void {
  if (inBrowser()) throw new Error(`${name}: materialized views are read on the server only (lib/derived-reads.ts)`);
}

export class DerivedReadError extends Error {
  constructor(readonly read: DerivedRead, readonly reason: number | "redirected" | "malformed") {
    super(`derived read ${read} failed (${reason})`);
    this.name = "DerivedReadError";
  }
}

/**
 * Browser: the rows of one read from GET /api/derived/<name>. Throws on anything but a 200 `{rows: [...]}`,
 * like the direct PostgREST read threw on an error, so a page keeps what it shows (silent revalidation) and
 * the next load simply asks again. A 401 or a redirect to /login (signed out) is also seen by AppData's fetch
 * observer, which ends the session in this tab.
 */
export async function fetchDerived<T>(name: DerivedRead, since: string | null = null): Promise<T[]> {
  const res = await fetch(derivedUrl(name, since), {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (res.redirected) throw new DerivedReadError(name, "redirected");
  if (!res.ok) throw new DerivedReadError(name, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new DerivedReadError(name, "malformed");
  }
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new DerivedReadError(name, "malformed");
  return rows as T[];
}

/** One matview read: the server query where it runs (service role), the facade in the browser. */
export function derivedRead<R>(name: DerivedRead, since: string | null, server: () => Promise<R>): Promise<R> {
  return inBrowser() ? (fetchDerived(name, since) as unknown as Promise<R>) : server();
}
