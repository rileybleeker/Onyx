// Uber Eats leftovers eaten on a LATER day (pds.delivery_item_leftovers, sql/delivery_item_leftovers.sql).
// When a dish's delivery-day portion is set below All, what is left is asked about on the next days:
// "3/4 left. Ate: All / 3/4 / 1/2 / 1/4 · Not today · Threw out". Shares are of what is LEFT; a row
// stores the share of the WHOLE dish eaten that day, so the day totals simply add up.
// Riley's rule (2026-11-14): a leftover never answered within the window counts as thrown out.
// Pure helpers only (no Supabase, no React), shared by the PUT route, the browser and the tests. The
// database triggers enforce the same rules; checkLeftoverWrite only gives the friendly message first.

import { shiftYmd } from "./delivery-portion";

/** A leftover can be eaten on behavioral days D+1 .. D+LEFTOVER_WINDOW_DAYS (D = delivery day). */
export const LEFTOVER_WINDOW_DAYS = 3;

export interface LeftoverRow {
  item_id: number;
  /** Behavioral day the leftover was eaten. */
  eaten_date: string;
  /** Share of the WHOLE cart line eaten that day (0 = "not today" unless threw_out). */
  fraction: number;
  /** The rest was thrown away after this day: stop asking. */
  threw_out: boolean;
  /** Local clock time it was eaten ("19:30"; before 06:00 = the small hours closing that day), or null. */
  eaten_time: string | null;
}

/** The dish fields the leftover rules need. */
export interface LeftoverDish {
  item_id: number;
  /** Delivery behavioral day. */
  behavioral_date: string;
  /** Delivery-day portion; NULL = All (nothing left). */
  eaten_fraction: number | null;
}

/**
 * The one-tap answers, in display order. `share` is a share of what is LEFT. Saving the lit answer
 * again clears it (no row = not answered).
 */
export const LEFTOVER_OPTIONS: ReadonlyArray<{ key: string; label: string; share: number | null }> = [
  { key: "1", label: "All", share: 1 },
  { key: "0.75", label: "3/4", share: 0.75 },
  { key: "0.5", label: "1/2", share: 0.5 },
  { key: "0.25", label: "1/4", share: 0.25 },
  { key: "not_today", label: "Not today", share: 0 },
  { key: "threw_out", label: "Threw out", share: null },
];

const EPS = 1e-6;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * What is left of the dish for day `date`: the whole dish minus the delivery-day portion and every
 * leftover saved on ANOTHER day. (Normally the other days are all earlier; when an earlier day is
 * edited after a later one, this is still the most that day can take.) Never negative.
 */
export function leftFor(dish: LeftoverDish, rows: ReadonlyArray<LeftoverRow>, date: string): number {
  if (dish.eaten_fraction == null) return 0;
  let left = 1 - Number(dish.eaten_fraction);
  for (const r of rows) if (r.item_id === dish.item_id && r.eaten_date !== date) left -= Number(r.fraction);
  return left > EPS ? round4(left) : 0;
}

/**
 * Stored token for one (dish, day): null = not answered, "out" = threw it out, else the share of the
 * whole dish eaten that day as a decimal string ("0" = not today), with "@HH:MM" when the time it was
 * eaten is known ("0.375@19:30"). A string so the serialized saver can compare taps with ===.
 */
export type LeftoverToken = string | null;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM", 24-hour, 00:00..23:59. */
export function isClock(v: unknown): v is string {
  return typeof v === "string" && HHMM.test(v);
}

/** The amount and time parts of a token. */
export function splitToken(token: LeftoverToken): { fraction: number; time: string | null } {
  if (token == null || token === "out") return { fraction: 0, time: null };
  const [f, t] = token.split("@");
  const n = Number(f);
  return { fraction: Number.isFinite(n) ? n : 0, time: t && isClock(t) ? t : null };
}

function joinToken(fraction: number, time: string | null): LeftoverToken {
  const f = String(round4(fraction));
  return fraction > EPS && time ? `${f}@${time}` : f;
}

export function tokenOfRow(row: LeftoverRow | undefined): LeftoverToken {
  if (!row) return null;
  if (row.threw_out) return "out";
  return joinToken(Number(row.fraction), row.eaten_time ? row.eaten_time.slice(0, 5) : null);
}

/**
 * The token a tap on `optionKey` stores, given what is left for that day. Changing the amount keeps
 * the time already entered; Not today / Threw out drop it (a time needs an amount).
 */
export function tokenForOption(optionKey: string, left: number, time: string | null = null): LeftoverToken {
  if (optionKey === "threw_out") return "out";
  if (optionKey === "not_today") return "0";
  const o = LEFTOVER_OPTIONS.find((x) => x.key === optionKey);
  if (!o || o.share == null) return null;
  return joinToken(left * o.share, time);
}

/** The same answer with the time set (or cleared with null). A token without an amount is returned as is. */
export function withTime(token: LeftoverToken, time: string | null): LeftoverToken {
  const { fraction } = splitToken(token);
  if (token == null || token === "out" || fraction <= EPS) return token;
  return joinToken(fraction, time && isClock(time) ? time : null);
}

/** Which button is lit for a stored token (null = none). */
export function optionOfToken(token: LeftoverToken, left: number): string | null {
  if (token == null) return null;
  if (token === "out") return "threw_out";
  const f = splitToken(token).fraction;
  if (f <= EPS) return "not_today";
  if (left <= EPS) return "1";
  let best: string | null = null;
  let bestGap = Infinity;
  for (const o of LEFTOVER_OPTIONS) {
    if (o.share == null || o.share === 0) continue;
    const gap = Math.abs(left * o.share - f);
    if (gap < bestGap) {
      bestGap = gap;
      best = o.key;
    }
  }
  return best;
}

/** Share of the whole dish eaten that day for a token (null / "out" = 0). */
export function fractionOfToken(token: LeftoverToken): number {
  return splitToken(token).fraction;
}

/** PUT body for a token. */
export function bodyForToken(
  date: string,
  token: LeftoverToken,
): { date: string; fraction: number | null; threw_out?: boolean; time?: string | null } {
  if (token == null) return { date, fraction: null };
  if (token === "out") return { date, fraction: 0, threw_out: true };
  const { fraction, time } = splitToken(token);
  return fraction > EPS ? { date, fraction, threw_out: false, time } : { date, fraction: 0, threw_out: false };
}

/** The browser's clock as "HH:MM" (for the "Now" button). */
export function clockNow(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "19:30" -> "7:30 PM". */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The dishes whose leftovers are asked about on day `date`: delivered on date-3 .. date-1 with a
 * delivery-day portion below All, not thrown out on an earlier day, and with something left for
 * that day, or already answered for that day (so the answer stays visible and can be changed).
 */
export function leftoverQuestions<T extends LeftoverDish>(
  dishes: ReadonlyArray<T>,
  rows: ReadonlyArray<LeftoverRow>,
  date: string,
): Array<{ dish: T; left: number; row: LeftoverRow | undefined }> {
  const first = shiftYmd(date, -LEFTOVER_WINDOW_DAYS);
  const out: Array<{ dish: T; left: number; row: LeftoverRow | undefined }> = [];
  for (const dish of dishes) {
    if (dish.behavioral_date >= date || dish.behavioral_date < first) continue;
    if (dish.eaten_fraction == null || Number(dish.eaten_fraction) >= 1) continue;
    const mine = rows.filter((r) => r.item_id === dish.item_id);
    if (mine.some((r) => r.threw_out && r.eaten_date < date)) continue;
    const row = mine.find((r) => r.eaten_date === date);
    const left = leftFor(dish, rows, date);
    if (left <= 0 && !row) continue;
    out.push({ dish, left, row });
  }
  return out;
}

// ─── PUT /api/delivery/items/[itemId]/leftovers ──────────────────────────────

export type LeftoverBody = { date: string; fraction: number | null; threw_out: boolean; time: string | null };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isRealYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Exactly {date, fraction, threw_out?, time?}: fraction null (= clear) or 0..1 with at most 4 decimals;
 * time null or "HH:MM", only with an amount eaten (fraction > 0).
 */
export function parseLeftoverBody(body: unknown): { ok: true; value: LeftoverBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (!keys.includes("date") || !keys.includes("fraction") || keys.some((k) => !["date", "fraction", "threw_out", "time"].includes(k))) {
    return { ok: false, error: "body must be exactly {date, fraction, threw_out?, time?}" };
  }
  if (b.time !== undefined && b.time !== null && !isClock(b.time)) return { ok: false, error: "time must be HH:MM (24-hour)" };
  const time = isClock(b.time) ? b.time : null;
  if (typeof b.date !== "string" || !isRealYmd(b.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (b.threw_out !== undefined && typeof b.threw_out !== "boolean") return { ok: false, error: "threw_out must be true or false" };
  const threw = b.threw_out === true;
  if (b.fraction === null) {
    if (threw) return { ok: false, error: "threw_out needs a fraction (0 when nothing was eaten)" };
    if (time) return { ok: false, error: "a time needs an amount eaten" };
    return { ok: true, value: { date: b.date, fraction: null, threw_out: false, time: null } };
  }
  const f = b.fraction;
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 1) {
    return { ok: false, error: "fraction must be null or a number from 0 to 1" };
  }
  if (Math.abs(f * 10000 - Math.round(f * 10000)) > 1e-6) return { ok: false, error: "fraction may have at most 4 decimals" };
  if (time && f <= 0) return { ok: false, error: "a time needs an amount eaten" };
  return { ok: true, value: { date: b.date, fraction: round4(f), threw_out: threw, time } };
}

/**
 * The same rules as the database trigger (pds.delivery_item_leftovers_guard), checked first so the
 * answer names the problem. Returns null when the write may go ahead.
 */
export function checkLeftoverWrite(
  dish: LeftoverDish & { merchant_kind?: string | null; is_cancelled?: boolean | null },
  rows: ReadonlyArray<LeftoverRow>,
  today: string,
  w: LeftoverBody,
): { status: number; error: string } | null {
  if (dish.merchant_kind != null && dish.merchant_kind !== "restaurant") return { status: 409, error: "only restaurant dishes have leftovers" };
  if (dish.is_cancelled) return { status: 409, error: "this order was cancelled" };
  if (w.fraction === null) return null; // clearing an answer is always allowed
  if (dish.eaten_fraction == null || Number(dish.eaten_fraction) >= 1) {
    return { status: 409, error: "nothing left: this dish is marked All on its delivery day" };
  }
  const last = shiftYmd(dish.behavioral_date, LEFTOVER_WINDOW_DAYS);
  if (w.date <= dish.behavioral_date || w.date > last) {
    return { status: 409, error: `leftovers can be logged for ${LEFTOVER_WINDOW_DAYS} days after the delivery day only` };
  }
  if (w.date > today) return { status: 409, error: "that day has not happened yet" };
  if (w.fraction > leftFor(dish, rows, w.date) + EPS) return { status: 409, error: "that is more than was left of this dish" };
  const mine = rows.filter((r) => r.item_id === dish.item_id && r.eaten_date !== w.date);
  if (mine.some((r) => r.threw_out && r.eaten_date < w.date)) return { status: 409, error: "this dish was marked thrown out on an earlier day" };
  if (w.threw_out && mine.some((r) => r.eaten_date > w.date)) {
    return { status: 409, error: "leftovers of this dish are saved on a later day; clear those first" };
  }
  return null;
}

/**
 * Answer for a guard trigger's SQLSTATE. `portion` = the delivery-day PATCH (only OXL01 can fire:
 * pds.delivery_order_items_leftover_guard), `leftover` = the leftovers PUT (pds.delivery_item_leftovers_guard).
 */
export function leftoverConflictMessage(code: string | undefined | null, context: "portion" | "leftover"): string | null {
  switch (code) {
    case "OXL01":
      return context === "portion"
        ? "leftovers of this dish are saved on a later day; clear those first"
        : "that is more than was left of this dish; reload and try again";
    case "OXL02":
      return "leftovers can be logged only for the 3 days after the delivery day, never ahead";
    case "OXL03":
      return "nothing left: this dish is marked All on its delivery day";
    case "OXL04":
      return "this dish was marked thrown out on an earlier day";
    case "OXL05":
      return "that time has not happened yet";
    default:
      return null;
  }
}

/** "3/4", "3/8", "1/2"; "all" for 1; a percent when no small fraction fits. */
export function formatShare(v: number): string {
  if (v >= 1 - EPS) return "all";
  for (const d of [2, 3, 4, 8, 16]) {
    const n = v * d;
    if (Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) > 0) {
      const k = Math.round(n);
      // reduce
      const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
      const c = g(k, d);
      return `${k / c}/${d / c}`;
    }
  }
  return `${Math.round(v * 100)}%`;
}
