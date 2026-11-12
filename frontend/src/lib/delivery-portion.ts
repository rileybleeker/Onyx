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

/** YYYY-MM-DD shifted by whole days (calendar arithmetic in UTC, so no DST edge). */
export function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Uber Eats estimates filling days with no food log (getNutrition) ───────

export interface DeliveryEstimateDay {
  behavioral_date: string;
  est_kcal: number | string | null;
  est_protein_g: number | string | null;
  est_carbs_g: number | string | null;
  est_fat_g: number | string | null;
}

/**
 * Adds pds.delivery_nutrition_daily estimates for days with no Cronometer/MFP log. A logged day always
 * wins (the diary usually already holds the delivered meal). A day whose estimate is 0 kcal or less (every
 * dish marked "None": an order for a guest, or one thrown away) is left out: nothing delivered was eaten,
 * so there is no food signal for that day, which is not the same as a day Riley ate nothing.
 */
export function mergeDeliveryEstimates<T extends { calendar_date: string }>(
  logged: ReadonlyArray<T>,
  estimates: ReadonlyArray<DeliveryEstimateDay>,
): Array<T | (Record<string, unknown> & { calendar_date: string })> {
  const rows: Array<T | (Record<string, unknown> & { calendar_date: string })> = [...logged];
  const seen = new Set(logged.map((r) => r.calendar_date));
  for (const e of estimates) {
    if (seen.has(e.behavioral_date)) continue;
    const kcal = e.est_kcal == null ? NaN : Number(e.est_kcal);
    if (!Number.isFinite(kcal) || kcal <= 0) continue;
    seen.add(e.behavioral_date);
    rows.push({
      calendar_date: e.behavioral_date,
      nutrition_source: "uber_eats",
      calories: e.est_kcal,
      protein_g: e.est_protein_g,
      carbs_g: e.est_carbs_g,
      fat_g: e.est_fat_g,
      fiber_g: null,
      sugar_g: null,
      sodium_mg: null,
      water_ml: null,
    });
  }
  rows.sort((a, b) => (a.calendar_date < b.calendar_date ? -1 : a.calendar_date > b.calendar_date ? 1 : 0));
  return rows;
}

// ─── Which dishes the check-in asks about ────────────────────────────────────

/**
 * The check-in for day D shows every dish of D, plus dishes of the days before D (the caller fetches
 * D-1 and D-2) whose portion was never set. The harvester runs every 6 h, so a dinner delivered after the
 * evening check-in usually lands in the database after it; it is then asked at the next check-in. Grouped
 * by day: D first, then the earlier days, newest first.
 */
export function checkinDishGroups<T extends { behavioral_date: string; eaten_fraction: number | null }>(
  rows: ReadonlyArray<T>,
  date: string,
): Array<{ date: string; items: T[] }> {
  return groupDishesByDay(
    rows.filter((r) => r.behavioral_date === date || (r.behavioral_date < date && r.eaten_fraction == null)),
    date,
  );
}

/** Group by behavioral day: `date` first, then the other days newest first; order within a day kept. */
export function groupDishesByDay<T extends { behavioral_date: string }>(
  rows: ReadonlyArray<T>,
  date: string,
): Array<{ date: string; items: T[] }> {
  const byDay = new Map<string, T[]>();
  for (const r of rows) byDay.set(r.behavioral_date, [...(byDay.get(r.behavioral_date) ?? []), r]);
  return [...byDay.entries()]
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] === date ? -1 : b[0] === date ? 1 : a[0] < b[0] ? 1 : -1))
    .map(([d, items]) => ({ date: d, items }));
}

// ─── Saving taps ─────────────────────────────────────────────────────────────

export type PortionSendResult = { ok: true } | { ok: false; error: string };

export interface PortionSaverOptions {
  /** Write one dish's fraction (PATCH /api/delivery/items/[itemId]). A throw counts as a network error. */
  send(itemId: number, fraction: number | null): Promise<PortionSendResult>;
  /** Show a value for the dish (the optimistic tap, or the stored value after a failed save). */
  apply(itemId: number, fraction: number | null): void;
  onError(itemId: number, message: string): void;
  onSaved(itemId: number, fraction: number | null): void;
}

/**
 * Optimistic one-tap saving with writes SERIALIZED per dish: while a write is in flight, further taps on
 * that dish only update the screen and the newest one is sent when the write returns. So the server sees
 * the taps in order, and a failed save goes back to the last value the server CONFIRMED (the loaded one,
 * or the last successful write), never to an earlier optimistic tap that was not saved.
 */
export function createPortionSaver(o: PortionSaverOptions) {
  type Dish = { confirmed: number | null; shown: number | null; inflight: boolean; pending: { v: number | null } | null };
  const dishes = new Map<number, Dish>();

  async function run(id: number, d: Dish, f: number | null): Promise<void> {
    d.inflight = true;
    let r: PortionSendResult;
    try {
      r = await o.send(id, f);
    } catch {
      r = { ok: false, error: "Network error: the portion was not saved." };
    }
    d.inflight = false;
    if (r.ok) d.confirmed = f;
    const next = d.pending;
    d.pending = null;
    if (next && next.v !== d.confirmed) return run(id, d, next.v);
    if (r.ok) {
      o.onSaved(id, d.confirmed);
      return;
    }
    // This write failed, but the newest tap went back to the stored value: the screen is already right.
    if (next) return;
    d.shown = d.confirmed;
    o.apply(id, d.confirmed);
    o.onError(id, r.error);
  }

  return {
    /**
     * Record the stored value of a freshly loaded dish. Returns the value to display: the stored one,
     * or (while a save for that dish is still in flight) the value on screen.
     */
    seed(itemId: number, stored: number | null): number | null {
      const d = dishes.get(itemId);
      if (!d) {
        dishes.set(itemId, { confirmed: stored, shown: stored, inflight: false, pending: null });
        return stored;
      }
      if (d.inflight || d.pending) return d.shown;
      d.confirmed = stored;
      d.shown = stored;
      return stored;
    },
    /** A tap. Resolves when this tap's write (or the queued write that supersedes it) has settled. */
    set(itemId: number, fraction: number | null): Promise<void> {
      let d = dishes.get(itemId);
      if (!d) {
        d = { confirmed: null, shown: null, inflight: false, pending: null };
        dishes.set(itemId, d);
      }
      if (d.shown === fraction) return Promise.resolve();
      d.shown = fraction;
      o.apply(itemId, fraction);
      if (d.inflight) {
        d.pending = { v: fraction };
        return Promise.resolve();
      }
      return run(itemId, d, fraction);
    },
    shown(itemId: number): number | null | undefined {
      return dishes.get(itemId)?.shown;
    },
    confirmed(itemId: number): number | null | undefined {
      return dishes.get(itemId)?.confirmed;
    },
  };
}
