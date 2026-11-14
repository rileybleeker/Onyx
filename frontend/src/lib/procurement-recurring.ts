/**
 * Recurring-charge ("subscription") detection over the finance ledger.
 *
 * PURE and deterministic: no network, no clock (callers pass `today` as YYYY-MM-DD), no Supabase.
 * The server loader lives in procurement-recurring-server.ts. Amounts are EXPENSE-POSITIVE cents
 * (see finance-ledger.ts); only counted USD purchases are considered, currencies are never mixed.
 */
import { classifyTxn, toCents } from "./finance-ledger";

export type RecurringCadence = "weekly" | "monthly" | "quarterly" | "annual";

export interface RecurringInput {
  txn_date: string; // YYYY-MM-DD
  name: string;
  custom_name: string | null;
  amount_cents: number;
  currency: string;
  category: string | null;
  ignored_from: string | null;
}

export type RenewalConfidence = "high" | "medium" | "low";

export interface DetectedSubscription {
  /** Opaque and stable for one merchant (a hash of its normalized name); safe to put in a URL. */
  id: string;
  merchant: string;
  cadence: RecurringCadence;
  typicalCents: number;
  lastCharge: string;
  /** Estimated date of the next charge (see nextMethod / confidence). */
  nextExpected: string;
  /** How nextExpected was estimated, in plain words. */
  nextMethod: string;
  confidence: RenewalConfidence;
  /** Recent gaps the method was checked against, and its largest miss over them, in days. */
  checkedGaps: number;
  maxMissDays: number;
  chargeCount: number;
  monthlyCents: number;
  status: "active" | "lapsed";
}

/** A charge that repeats for about the same amount but on no regular schedule: no date is estimated. */
export interface IrregularCharge {
  id: string;
  merchant: string;
  typicalCents: number;
  lastCharge: string;
  chargeCount: number;
  medianGapDays: number;
}

export type DetectedLoad =
  | { state: "ok"; subs: DetectedSubscription[]; irregular: IrregularCharge[]; total: number; today: string }
  | { state: "empty" }
  | { state: "error"; code: string };

/** Days of ledger history the loader reads. */
export const RECURRING_WINDOW_DAYS = 400;

const BANDS: Record<RecurringCadence, { min: number; max: number; minCharges: number }> = {
  weekly: { min: 6, max: 8, minCharges: 3 },
  monthly: { min: 26, max: 35, minCharges: 3 },
  quarterly: { min: 84, max: 98, minCharges: 3 },
  annual: { min: 350, max: 380, minCharges: 2 },
};
const CADENCES = Object.keys(BANDS) as RecurringCadence[];
const MIN_IN_BAND = 0.7;
const AMOUNT_TOLERANCE = 0.25;
const DAY_MS = 86_400_000;
/** Calendar months per cycle, for the cadences that bill on a calendar date. */
const CYCLE_MONTHS: Partial<Record<RecurringCadence, number>> = { monthly: 1, quarterly: 3, annual: 12 };
/** The estimate is checked against this many of the most recent gaps. */
const CHECKED_GAPS = 4;
/** Confidence: "high" = at least 3 gaps checked, none off by more than 2 days; "medium" = none off by more than 4. */
const HIGH_MAX_MISS = 2;
const HIGH_MIN_GAPS = 3;
const MEDIUM_MAX_MISS = 4;
/** Irregular repeats: at least 4 charges, 80% of them within 5% of the usual amount, the last one recent. */
const IRREGULAR_MIN_CHARGES = 4;
const IRREGULAR_AMOUNT_TOLERANCE = 0.05;
const IRREGULAR_MIN_SHARE = 0.8;
const IRREGULAR_MIN_MEDIAN_GAP = 10;
const IRREGULAR_RECENT_DAYS = 120;

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}
/** Same day of the month `months` later; a day the target month lacks becomes its last day. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Opaque 16-hex id for a text (two FNV-1a style passes). An identifier, not a security feature. */
export function stableId(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
    b ^= b >>> 13;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Strip store / reference numbers (#1234, long digit runs) so two spellings of a merchant merge. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/#\s*\d+/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[\s\-*#]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeMerchant(raw: string): string {
  return cleanLabel(raw).toLowerCase();
}

/** Parse one PostgREST row into a detector input; a malformed row is dropped (null). */
export function parseRecurringInput(raw: unknown): RecurringInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cents = toCents(r.amount_cents);
  if (!isDay(r.txn_date) || cents === null) return null;
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    txn_date: r.txn_date,
    name: s(r.name) ?? "",
    custom_name: s(r.custom_name),
    amount_cents: cents,
    currency: (s(r.currency) ?? "USD").trim().toUpperCase() || "USD",
    category: s(r.category),
    ignored_from: s(r.ignored_from),
  };
}

interface Charge {
  date: string;
  cents: number;
  label: string;
}

/** Several charges on one day count once (the largest), so a duplicate never makes a zero-day gap. Oldest first. */
function oncePerDay(charges: Charge[]): Charge[] {
  const byDay = new Map<string, Charge>();
  for (const c of charges) {
    const prev = byDay.get(c.date);
    if (!prev || c.cents > prev.cents) byDay.set(c.date, c);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

interface NextEstimate {
  next: string;
  method: string;
  confidence: RenewalConfidence;
  checkedGaps: number;
  maxMissDays: number;
}

/**
 * Estimate the next charge date from the charge dates (oldest first) of an established cadence.
 *
 * Two models are tried on the recent gaps and the one that fits them better is used:
 *  - calendar: the same day of the month, 1 / 3 / 12 months on (how most services bill);
 *  - interval: a fixed number of days (the median gap), for 4-weekly or 30-day billing and for weekly.
 * The date is the median of the last (up to three) charges each carried forward by whole cycles, so
 * one charge that posted a day or two late (a weekend) does not move it. Confidence says how well
 * the chosen model reproduced the recent charges; it is not a probability.
 */
function estimateNext(dates: string[], cadence: RecurringCadence, medGap: number): NextEstimate {
  const step = Math.round(medGap);
  const months = CYCLE_MONTHS[cadence];
  const band = BANDS[cadence];
  const recent = dates.slice(-(CHECKED_GAPS + 1));
  const intervalMiss: number[] = [];
  const calendarMiss: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    intervalMiss.push(Math.abs(daysBetween(recent[i - 1], recent[i]) - step));
    if (months) calendarMiss.push(Math.abs(daysBetween(addMonths(recent[i - 1], months), recent[i])));
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const calendar = months !== undefined && mean(calendarMiss) <= mean(intervalMiss);
  const miss = calendar ? calendarMiss : intervalMiss;

  // Carry the last charges forward; stop at a gap outside the band (a skipped cycle would be off by one).
  const tail: string[] = [];
  const projected: number[] = [];
  for (let i = dates.length - 1, k = 1; i >= 0 && k <= 3; i--, k++) {
    if (k > 1) {
      const gap = daysBetween(dates[i], dates[i + 1]);
      if (gap < band.min || gap > band.max) break;
    }
    tail.push(dates[i]);
    projected.push(dayNumber(calendar ? addMonths(dates[i], (months ?? 0) * k) : addDays(dates[i], step * k)));
  }
  let next = new Date(Math.round(median(projected)) * DAY_MS).toISOString().slice(0, 10);
  // Billing on the 29th-31st lands on the last day of a shorter month, which hides the real billing
  // day. When a recent charge sits on a month end, bill on the latest day of the month seen instead.
  if (calendar && tail.some((d) => addDays(d, 1).slice(8) === "01")) {
    const day = Math.max(...tail.map((d) => Number(d.slice(8))));
    const target = addMonths(`${dates[dates.length - 1].slice(0, 8)}01`, months ?? 0);
    next = addMonths(`${target.slice(0, 8)}${String(day).padStart(2, "0")}`, 0);
  }

  const maxMiss = Math.max(...miss);
  const confidence: RenewalConfidence =
    miss.length >= HIGH_MIN_GAPS && maxMiss <= HIGH_MAX_MISS
      ? "high"
      : maxMiss <= MEDIUM_MAX_MISS && (miss.length >= 2 || cadence === "annual")
        ? "medium"
        : "low";
  const method = calendar
    ? months === 1
      ? "same day of the month as the recent charges"
      : months === 3
        ? "three months after the recent charges, same day of the month"
        : "one year after the last charge, same date"
    : `every ${step} days, counted from the recent charges`;
  return { next, method, confidence, checkedGaps: miss.length, maxMissDays: maxMiss };
}

function classify(key: string, charges: Charge[], today: string): DetectedSubscription | null {
  const list = oncePerDay(charges);
  if (list.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
  const medGap = median(gaps);
  const cadence = CADENCES.find((c) => medGap >= BANDS[c].min && medGap <= BANDS[c].max);
  if (!cadence) return null;
  const band = BANDS[cadence];
  if (list.length < band.minCharges) return null;
  const inBand = gaps.filter((g) => g >= band.min && g <= band.max).length;
  if (inBand / gaps.length < MIN_IN_BAND) return null;

  const recent = list.slice(-3).map((c) => c.cents);
  const typical = Math.round(median(recent));
  if (typical <= 0) return null;
  if (recent.some((c) => Math.abs(c - typical) > AMOUNT_TOLERANCE * typical)) return null;

  const last = list[list.length - 1];
  const typicalGap = Math.round(medGap);
  const estimate = estimateNext(list.map((c) => c.date), cadence, medGap);
  const nextExpected = estimate.next;
  const monthlyCents = Math.round(
    cadence === "weekly" ? (typical * 52) / 12 : cadence === "monthly" ? typical : cadence === "quarterly" ? typical / 3 : typical / 12,
  );
  const active = daysBetween(nextExpected, today) <= typicalGap / 2;
  return {
    id: stableId(key),
    merchant: cleanLabel(last.label) || last.label.trim(),
    cadence,
    typicalCents: typical,
    lastCharge: last.date,
    nextExpected,
    nextMethod: estimate.method,
    confidence: estimate.confidence,
    checkedGaps: estimate.checkedGaps,
    maxMissDays: estimate.maxMissDays,
    chargeCount: list.length,
    monthlyCents,
    status: active ? "active" : "lapsed",
  };
}

/** Counted USD purchases grouped by normalized merchant (refunds, ignored rows, transfers and other currencies left out). */
function groupCharges(txns: readonly RecurringInput[]): Map<string, Charge[]> {
  const groups = new Map<string, Charge[]>();
  for (const t of txns) {
    if (classifyTxn(t) !== "counted") continue;
    if (!(t.amount_cents > 0)) continue;
    if ((t.currency ?? "").trim().toUpperCase() !== "USD") continue;
    if (!isDay(t.txn_date)) continue;
    const label = (t.custom_name ?? "").trim() || (t.name ?? "").trim();
    const key = normalizeMerchant(label);
    if (!key) continue;
    const list = groups.get(key);
    const charge = { date: t.txn_date, cents: t.amount_cents, label };
    if (list) list.push(charge);
    else groups.set(key, [charge]);
  }
  return groups;
}

/** Detect recurring charges. Active first, then by monthly-equivalent descending. */
export function detectRecurring(txns: readonly RecurringInput[], today: string): DetectedSubscription[] {
  const subs: DetectedSubscription[] = [];
  for (const [key, charges] of groupCharges(txns)) {
    const sub = classify(key, charges, today);
    if (sub) subs.push(sub);
  }
  return subs.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
      b.monthlyCents - a.monthlyCents ||
      (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0),
  );
}

/**
 * Charges that repeat for about the same amount but fit no cadence (so detectRecurring skips them):
 * a fixed top-up, a membership billed whenever it is used. They are listed WITHOUT a next date -
 * the spacing gives nothing to estimate one from. Most recent first.
 */
export function detectIrregular(txns: readonly RecurringInput[], today: string): IrregularCharge[] {
  const out: IrregularCharge[] = [];
  for (const [key, charges] of groupCharges(txns)) {
    if (classify(key, charges, today)) continue;
    const list = oncePerDay(charges);
    if (list.length < IRREGULAR_MIN_CHARGES) continue;
    const last = list[list.length - 1];
    const sinceLast = daysBetween(last.date, today);
    if (sinceLast < 0 || sinceLast > IRREGULAR_RECENT_DAYS) continue;
    const typical = Math.round(median(list.map((c) => c.cents)));
    if (typical <= 0) continue;
    const close = list.filter((c) => Math.abs(c.cents - typical) <= IRREGULAR_AMOUNT_TOLERANCE * typical).length;
    if (close / list.length < IRREGULAR_MIN_SHARE) continue;
    const gaps: number[] = [];
    for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
    const medGap = median(gaps);
    if (medGap < IRREGULAR_MIN_MEDIAN_GAP) continue;
    out.push({
      id: stableId(key),
      merchant: cleanLabel(last.label) || last.label.trim(),
      typicalCents: typical,
      lastCharge: last.date,
      chargeCount: list.length,
      medianGapDays: Math.round(medGap),
    });
  }
  return out.sort((a, b) =>
    a.lastCharge < b.lastCharge ? 1 : a.lastCharge > b.lastCharge ? -1 : a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0,
  );
}

/** Monthly-equivalent total of the active subscriptions, in cents. */
export function activeMonthlyTotal(subs: readonly DetectedSubscription[]): number {
  return subs.reduce((sum, s) => sum + (s.status === "active" ? s.monthlyCents : 0), 0);
}
