// How much of a delivered Uber Eats dish was actually eaten (pds.delivery_order_items.eaten_fraction).
// Ordered is not eaten: a quarter of a pizza is a quarter of its calories. NULL = all of it (the default
// for every row the harvester writes; the importer never sends this column, so a value set here survives
// re-harvests). Pure helpers only: no Supabase, no React, no Node built-ins, so both the PATCH route and
// the browser bundle (/nutrition, /check-in) can import it, and the tests load it offline.

/** The one-tap choices, in display order. "All" stores 1 (a confirmed full portion). */
export const PORTION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "All" },
  { value: 0.75, label: "3/4" },
  { value: 0.5, label: "1/2" },
  { value: 0.25, label: "1/4" },
  { value: 0, label: "None" },
];

export type FractionResult = { ok: true; value: number | null } | { ok: false; error: string };

/** null, or a number 0..1 with at most 2 decimals. Strings, NaN, Infinity, 0.333 are refused. */
export function parseEatenFraction(v: unknown): FractionResult {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { ok: false, error: "eaten_fraction must be null or a number from 0 to 1" };
  }
  if (v < 0 || v > 1) return { ok: false, error: "eaten_fraction must be between 0 and 1" };
  const cents = v * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-9) {
    return { ok: false, error: "eaten_fraction may have at most 2 decimals" };
  }
  return { ok: true, value: Math.round(cents) / 100 };
}

/** Body of PATCH /api/delivery/items/[itemId]: exactly {eaten_fraction: number|null}. */
export function parsePortionBody(body: unknown): FractionResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "eaten_fraction") {
    return { ok: false, error: "body must be exactly {eaten_fraction: number | null}" };
  }
  return parseEatenFraction((body as { eaten_fraction: unknown }).eaten_fraction);
}

/** Path segment: a positive bigint item_id. */
export function parseItemId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) return null;
  return Number(raw);
}

export const MAX_PORTION_BODY_BYTES = 256;

type HeaderGetter = { get(name: string): string | null };

/**
 * Request-shape checks for the PATCH route, before the body is read. Returns null when the request may
 * proceed, else the status + message to answer with. The route is session-only (middleware); this adds a
 * same-origin check (a browser always sends Origin on a PATCH, so a missing one is refused), a JSON
 * content type, and a small declared size.
 */
export function checkPortionRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  // The host the browser addressed: Vercel's proxy sets x-forwarded-host; locally it is Host. A browser
  // cannot forge either Origin or Host, which is what this CSRF check relies on.
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };

  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };

  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_PORTION_BODY_BYTES)) {
    return { status: 413, error: "body too large" };
  }
  return null;
}

/** kcal eaten from one cart line: one unit x quantity x fraction (NULL fraction = all). */
export function dishKcal(unitKcal: number | null | undefined, quantity: unknown, fraction: number | null | undefined): number | null {
  if (unitKcal == null || !Number.isFinite(Number(unitKcal))) return null;
  const q = Number(quantity ?? 1);
  const f = fraction == null ? 1 : Number(fraction);
  return Number(unitKcal) * (Number.isFinite(q) ? q : 1) * (Number.isFinite(f) ? f : 1);
}

/** Day total, same scope as pds.delivery_nutrition_daily.est_kcal: food and drink dishes only. */
export function dayKcal(items: ReadonlyArray<{ est_kcal: number | null; est_kind?: string | null }>): number | null {
  let total = 0;
  let any = false;
  for (const i of items) {
    if (i.est_kcal == null) continue;
    if (i.est_kind != null && i.est_kind !== "food" && i.est_kind !== "drink") continue;
    total += i.est_kcal;
    any = true;
  }
  return any ? total : null;
}

/** Which button is lit: NULL shows as All. */
export function selectedPortion(fraction: number | null | undefined): number {
  return fraction == null ? 1 : Number(fraction);
}
