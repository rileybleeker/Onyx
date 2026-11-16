/**
 * Cash flow forecast engine (design: docs/cash-flow-forecast.md, Sections 3, 4 and 9).
 *
 * PURE and deterministic: no I/O, no clock (callers pass `today` as YYYY-MM-DD and, for the staleness check,
 * `now`), no Supabase, and a seeded random stream, so the same input always draws the same forecast. It runs
 * on the server, in the browser for what-ifs, and in offline tests on synthetic data.
 *
 * Sign convention: ledger rows are EXPENSE-POSITIVE (finance-ledger.ts: a purchase is +). Everything this
 * module returns is BALANCE-POSITIVE: money in is +, money out is -. toBalanceDelta() is the only place the two
 * meet.
 *
 * What it projects, for the cash pool (checking + savings by default):
 * - detected streams: deposits and debits on a schedule (paychecks, rent, autopays), Section 4.3;
 * - card payments: what Riley actually pays each card from the pool, Section 4.3a;
 * - everyday spending: the mean weekly net flow left over, with a block-bootstrap range, Sections 4.3 / 4.4;
 * - planned items Riley enters (bonus, move, trip, tax payment), matched to actuals when they happen, 4.5;
 * and, separately, a monthly net worth projection with card balances, interest, promo end dates and investment
 * growth (Sections 4.3b / 4.3c).
 */
import { classifyTxn, isNonSpendingCategory } from "./finance-ledger";
import { addDays, addMonths, daysBetween, displayMerchant, merchantKey, rowLabel, stableId } from "./procurement-recurring";
import { FORECAST } from "./cash-forecast-config";
import { wordKey } from "./finance-categories";
import { UNVERIFIED } from "./cash-forecast-eligibility";

// The eligibility readers live in a small module so client views can use them without bundling the engine.
export { eligibilityOf, safeToMoveOf } from "./cash-forecast-eligibility";

// ─── Types ────────────────────────────────────────────────────────────────────────────────────

export type Certainty = "confirmed" | "likely" | "possible";
export type Layer = "detected" | "baseline" | "planned";
export type Direction = "in" | "out";

export interface ForecastAccount {
  account_key: string;
  account_type: string; // "Cash" | "Credit Card" | "Investment" | ...
  label: string;
}
export interface ForecastTxn {
  account_key: string;
  txn_date: string; // YYYY-MM-DD
  name: string;
  custom_name: string | null;
  amount_cents: number; // expense-positive
  currency: string;
  category: string | null;
  ignored_from: string | null;
}
export interface ForecastBalance {
  account_key: string;
  captured_at: string; // ISO timestamp
  balance_cents: number;
  currency: string;
  kind: "asset" | "liability" | null;
}
export interface PlannedItem {
  id: string;
  label: string;
  date: string;
  /** Balance-positive: a bonus is +, a deposit for an apartment is -. */
  amountCents: number;
  certainty: Certainty;
  repeat?: { unit: "month" | "week" | "day"; every?: number; count: number };
  matchWindowDays?: number;
  matchTolerance?: number;
  /** The other side of a transfer: money out of cash goes INTO this investment account, money in comes FROM it (net worth neutral). */
  account?: string;
}
/** Changes a detected stream (or a card's payments) from a date on: stop it, or change each amount. */
export interface StreamAdjustment {
  streamId: string;
  from: string;
  stop?: boolean;
  /** Balance-positive per occurrence. */
  amountCents?: number;
}
export interface CardTerms {
  account_key: string;
  aprPct?: number;
  promoAprPct?: number;
  promoEnds?: string; // YYYY-MM-DD
  standardAprPct?: number;
  /** Where an entered promo date came from ("estimated: ..."), shown next to it. */
  promoNote?: string;
}
export interface GrowthDriver {
  account_key: string;
  returnPct?: number;
  monthlyContributionCents?: number;
  contributionStarts?: string; // YYYY-MM-DD
  /** For an account with no ledger row yet (key "virtual-..."): its name and starting balance. */
  label?: string;
  startCents?: number;
}
export interface ForecastSettings {
  poolAccountKeys?: readonly string[];
  bufferCents?: number;
  lookbackWeeks?: number;
  lowPercentile?: number;
  highPercentile?: number;
  inflationPct?: number;
  horizonDays?: number;
  paths?: number;
  seed?: number;
  /** Months of card payments averaged for each card's monthly total (default 6). */
  cardMonths?: number;
  /** Backtests only: the pool's opening balance, instead of the latest snapshots. */
  openingOverride?: { cents: number; asOf: string };
  /**
   * Pool accounts Riley left out of the safe-to-move amount (driver "safe-to-move", e.g. an account the feed can no
   * longer refresh): their balance is not counted in the amount and is not checked for freshness. The projection
   * still includes them.
   */
  safeToMoveLeaveOut?: readonly string[];
}
export interface ForecastInput {
  today: string;
  now?: Date;
  accounts: readonly ForecastAccount[];
  txns: readonly ForecastTxn[];
  balances: readonly ForecastBalance[];
  planned?: readonly PlannedItem[];
  adjustments?: readonly StreamAdjustment[];
  cardTerms?: readonly CardTerms[];
  growth?: readonly GrowthDriver[];
  /** What-ifs: extra payments to a card on a date (lower its balance and interest in the net worth side). */
  extraCardPayments?: readonly { account_key: string; date: string; cents: number }[];
  settings?: ForecastSettings;
  /** What the caller knows about its own reads (the engine cannot see them); feeds `eligibility`. */
  quality?: InputQuality;
}

/** What the caller's reads could not deliver. Each one withholds the safe-to-move amount. */
export interface InputQuality {
  /** A paged read stopped at its page limit: part of the balances or the transaction history is missing. */
  historyTruncated?: boolean;
  /** The planned items or the plan drivers (settings, tax profile, move, stream changes) could not be read. */
  planUnavailable?: boolean;
  /** A saved tax profile or move plan was read but no longer parses, so its tax payments or move costs are missing. */
  planInvalid?: boolean;
  /** Riley's category fixes could not be read, so transfers and card payments are classified from raw categories. */
  categoriesUnavailable?: boolean;
  /**
   * Pool accounts whose balance read FAILED (not "no row": the read itself errored), so their balance is unknown and
   * could be an overdraft. Each withholds the amount even when Riley left the account out: leaving an account out
   * narrows what the amount counts, it does not make an unread balance known.
   */
  balanceUnreadable?: readonly string[];
}
/** Why the forecast's inputs do not support an actionable amount. */
export type EligibilityCode =
  | "no-pool"
  | "no-balance"
  | "missing-balance"
  | "invalid-balance"
  | "stale-balance"
  | "balance-unreadable"
  | "freshness-unknown"
  | "short-history"
  | "history-truncated"
  | "plan-unavailable"
  | "plan-invalid"
  | "categories-unavailable"
  | "invalid-input"
  | "unverified";
export interface EligibilityReason {
  code: EligibilityCode;
  /** One short sentence, shown next to the withheld amount and on Today. */
  text: string;
  /**
   * The pool account a balance reason is about: Riley can leave it out of the amount to clear the reason. Absent on
   * a reason leaving an account out cannot clear (an unreadable balance).
   */
  account?: string;
}
/**
 * A pool account whose balance the safe-to-move amount does not count (its positive part is taken out). Only Riley's
 * explicit choice (driver "safe-to-move") leaves an account out: a stale balance of any size withholds the amount.
 */
export interface LeftOutAccount {
  account: string;
  label: string;
  /** Its newest balance time (ISO); null when it has none. */
  asOf: string | null;
  /** Riley left it out ("Leave it out"). The only value: nothing leaves an account out automatically. */
  why: "chosen";
}
/**
 * Whether the inputs were complete and fresh enough for the ACTIONABLE number (safe to move). When false the
 * projection is still drawn as an estimate; only `headlines.safeToMoveCents` is withheld (null). The forecast page,
 * the what-if comparison and Today all read this one result (eligibilityOf / safeToMoveOf).
 */
export interface ForecastEligibility {
  eligible: boolean;
  reasons: EligibilityReason[];
  /**
   * When the check stops holding (ISO): the first balance the amount counts turns FORECAST.staleBalanceHours old.
   * A stored result read after it is not eligible (eligibilityOf with a clock). Absent when no balance was checked.
   */
  validUntil?: string;
  /** Pool accounts the amount does not count (named next to it). Absent when none. */
  leftOut?: LeftOutAccount[];
  /** The oldest balance the amount counts (ISO). Absent when none was checked. */
  cashAsOf?: string;
}

export interface ForecastLine {
  date: string;
  amountCents: number; // balance-positive
  label: string;
  layer: Layer;
  certainty: Certainty;
  sourceId: string;
  reason: string;
}
export interface DayPoint {
  date: string;
  likely: number;
  low: number;
  high: number;
}
export interface DetectedStream {
  id: string;
  kind: "income" | "bill" | "card";
  label: string;
  direction: Direction;
  cadence: string;
  typicalCents: number; // balance-positive per occurrence
  next: string | null;
  certainty: Certainty;
  occurrences: number;
  method: string;
}
export interface PlannedStatus {
  id: string;
  label: string;
  date: string;
  amountCents: number;
  status: "upcoming" | "pending" | "realized" | "late-dropped" | "late-kept";
  matchedDate?: string;
  matchedCents?: number;
}
export interface Rollup {
  key: string; // week start or YYYY-MM
  inCents: number;
  outCents: number;
  endLikely: number;
  endLow: number;
  endHigh: number;
}
export interface CardProjection {
  account_key: string;
  label: string;
  owedNow: number; // positive = owed
  aprPct: number;
  aprSource: string;
  promoEnds: string | null;
  promoSource: string | null;
  monthlySpendCents: number;
  monthlyPaymentCents: number;
  interestNext12Cents: number;
  promoAprPct: number | null;
  standardAprPct: number;
  standardAprAssumed: boolean;
  months: { month: string; owed: number; interest: number }[];
  warnings: string[];
}
/** A dated call-out: a 0% (or low) promo rate ends on a card. */
export interface PromoMilestone {
  date: string;
  kind: "promo-end";
  account_key: string;
  label: string;
  promoAprPct: number;
  source: string;
  /** Still owed on that date at the current payments (balance-positive size of the debt). */
  owedAtEndCents: number;
  standardAprPct: number;
  standardAprAssumed: boolean;
  /** Interest a month once the promo ends, on what would still be owed. */
  interestPerMonthAfterCents: number;
  /** Paying this much a month (current spending included) clears the card before the promo ends. */
  payPerMonthToClearCents: number;
  daysAway: number;
  withinHorizon: boolean;
  ended: boolean;
}
export interface NetWorthMonth {
  month: string;
  cash: number;
  investments: number;
  cardsOwed: number;
  netWorth: number;
  /** Investment balance by account label (ledger accounts and planned ones such as a future SEP IRA). */
  byAccount?: Record<string, number>;
}
export interface ForecastResult {
  state: "ok" | "no-pool" | "no-balance";
  today: string;
  pool: { account_key: string; label: string }[];
  opening: { cents: number; asOf: string | null; stale: boolean };
  days: DayPoint[];
  lines: ForecastLine[];
  streams: DetectedStream[];
  baseline: { weeklyMeanCents: number; weeksUsed: number; projected: boolean; oneOffs: number };
  planned: PlannedStatus[];
  weeks: Rollup[];
  months: Rollup[];
  /** Whether the inputs support the actionable amount; read it through eligibilityOf() (stored results may predate it). */
  eligibility: ForecastEligibility;
  headlines: {
    lowest: { date: string; cents: number } | null;
    lowestLikely: { date: string; cents: number } | null;
    /** null = withheld: the inputs were incomplete, stale or unreadable (see `eligibility`). Read it through safeToMoveOf(). */
    safeToMoveCents: number | null;
    end13w: { likely: number; low: number; high: number } | null;
    end12m: { likely: number; low: number; high: number } | null;
    nextPromoEnd: PromoMilestone | null;
  };
  milestones: PromoMilestone[];
  cards: CardProjection[];
  netWorth: NetWorthMonth[];
  notes: string[];
  warnings: string[];
}

// ─── Money and dates ──────────────────────────────────────────────────────────────────────────

/** The ONLY conversion from the ledger's expense-positive cents to balance-positive cents. */
export const toBalanceDelta = (expenseCents: number): number => -expenseCents;

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const ymd = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const weekday = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
const monthKeyOf = (iso: string): string => iso.slice(0, 7);
const monthIndex = (key: string): number => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
const monthFromIndex = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayOfMonth = (iso: string): number => Number(iso.slice(8, 10));

function nthWeekday(y: number, m: number, dow: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return ymd(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = daysInMonth(y, m);
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymd(y, m, lastDay - ((last - dow + 7) % 7));
}

const holidayCache = new Map<number, Set<string>>();
/**
 * US bank holidays (the Federal Reserve calendar): a holiday on a Sunday is observed on the Monday; one on a
 * Saturday is not moved (banks stay open the Friday before).
 */
export function usBankHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed = [ymd(year, 1, 1), ymd(year, 6, 19), ymd(year, 7, 4), ymd(year, 11, 11), ymd(year, 12, 25)].map((d) =>
    weekday(d) === 0 ? addDays(d, 1) : d,
  );
  const set = new Set<string>([
    ...fixed,
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Presidents Day
    nthWeekday(year, 5, 1, -1), // Memorial Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
  ]);
  holidayCache.set(year, set);
  return set;
}
export function isBusinessDay(iso: string): boolean {
  const w = weekday(iso);
  return w !== 0 && w !== 6 && !usBankHolidays(Number(iso.slice(0, 4))).has(iso);
}
export function previousBusinessDay(iso: string): string {
  let d = iso;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}
export function nextBusinessDay(iso: string): string {
  let d = iso;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}
export function lastBusinessDayOfMonth(y: number, m: number): string {
  return previousBusinessDay(ymd(y, m, daysInMonth(y, m)));
}

// ─── Schedules ────────────────────────────────────────────────────────────────────────────────

export type Adjust = "prev" | "next";
export type Schedule =
  | { kind: "interval"; days: number }
  | { kind: "monthly-day"; day: number; every: number; anchorMonth: string; adjust: Adjust }
  | { kind: "month-end" }
  | { kind: "semimonthly"; first: number; second: number | "end"; adjust: Adjust };

const adjustDay = (iso: string, adjust: Adjust): string => (adjust === "prev" ? previousBusinessDay(iso) : nextBusinessDay(iso));
const clampedDay = (key: string, day: number): string => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return ymd(y, m, Math.min(day, daysInMonth(y, m)));
};

/** The first scheduled date at least `minGap` days after `after` (minGap keeps an early or late actual from counting twice). */
export function nextOnSchedule(s: Schedule, after: string, minGap = 1): string {
  if (s.kind === "interval") return addDays(after, Math.max(s.days, minGap));
  const start = monthIndex(monthKeyOf(addDays(after, -40)));
  for (let i = start; i < start + 400; i++) {
    const key = monthFromIndex(i);
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    let candidates: string[];
    if (s.kind === "month-end") candidates = [lastBusinessDayOfMonth(y, m)];
    else if (s.kind === "monthly-day") {
      if ((((i - monthIndex(s.anchorMonth)) % s.every) + s.every) % s.every !== 0) continue;
      candidates = [adjustDay(clampedDay(key, s.day), s.adjust)];
    } else {
      candidates = [
        adjustDay(clampedDay(key, s.first), s.adjust),
        s.second === "end" ? lastBusinessDayOfMonth(y, m) : adjustDay(clampedDay(key, s.second), s.adjust),
      ];
    }
    for (const c of candidates) if (daysBetween(after, c) >= minGap) return c;
  }
  return addDays(after, 30); // unreachable for valid schedules
}

interface CadenceClass {
  cadence: string;
  band: [number, number];
  cycleDays: number;
  minGap: number;
  schedules: Schedule[];
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

function classifyCadence(dates: readonly string[], adjust: Adjust): CadenceClass | null {
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  if (!gaps.length) return null;
  const med = median(gaps);
  const recentDays = dates.slice(-3).map(dayOfMonth);
  const domDay = Math.round(median(recentDays));
  let cls: CadenceClass | null = null;
  if (med >= 5 && med <= 9) cls = { cadence: "weekly", band: [5, 9], cycleDays: 7, minGap: 4, schedules: [{ kind: "interval", days: 7 }] };
  else if (med >= 11 && med <= 20) {
    const doms = dates.slice(-6).map(dayOfMonth);
    const low = doms.filter((d) => d <= 16);
    const high = doms.filter((d) => d > 16);
    const schedules: Schedule[] = [{ kind: "interval", days: 14 }];
    if (low.length && high.length) {
      const hi = Math.round(median(high));
      schedules.push({ kind: "semimonthly", first: Math.round(median(low)), second: hi >= 27 ? "end" : hi, adjust });
    }
    cls = { cadence: "every two weeks", band: [11, 20], cycleDays: 15, minGap: 7, schedules };
  } else if (med >= 25 && med <= 36) {
    cls = {
      cadence: "monthly",
      band: [25, 36],
      cycleDays: 30,
      minGap: 15,
      schedules: [
        { kind: "monthly-day", day: domDay, every: 1, anchorMonth: monthKeyOf(dates[dates.length - 1]), adjust },
        { kind: "month-end" },
      ],
    };
  } else if (med >= 80 && med <= 100) {
    cls = {
      cadence: "quarterly",
      band: [80, 100],
      cycleDays: 91,
      minGap: 45,
      schedules: [{ kind: "monthly-day", day: domDay, every: 3, anchorMonth: monthKeyOf(dates[dates.length - 1]), adjust }],
    };
  }
  if (!cls) return null;
  const inBand = gaps.filter((g) => g >= cls!.band[0] && g <= cls!.band[1]).length;
  return inBand / gaps.length >= FORECAST.minInBand ? cls : null;
}

/** How well a schedule replays the last (up to 4) gaps: the largest miss in days and how many gaps were checked. */
export function scoreSchedule(s: Schedule, dates: readonly string[], minGap: number): { maxMiss: number; checked: number } {
  let maxMiss = 0;
  let checked = 0;
  for (let i = Math.max(1, dates.length - 4); i < dates.length; i++) {
    // Step past skipped cycles (a missing month, or an occurrence left out as unusual) to the nearest one.
    let pred = nextOnSchedule(s, dates[i - 1], minGap);
    for (let guard = 0; guard < 24 && daysBetween(pred, dates[i]) > minGap; guard++) pred = nextOnSchedule(s, pred, minGap);
    maxMiss = Math.max(maxMiss, Math.abs(daysBetween(pred, dates[i])));
    checked++;
  }
  return { maxMiss, checked };
}

function scheduleLabel(s: Schedule, cadence: string): string {
  if (s.kind === "month-end") return "on the last business day of each month";
  if (s.kind === "interval") return s.days === 7 ? "every week" : `every ${s.days} days`;
  if (s.kind === "semimonthly") return `on the ${ordinal(s.first)} and ${s.second === "end" ? "last business day" : ordinal(s.second)} of each month`;
  return `${cadence === "quarterly" ? "every 3 months" : "each month"} on the ${ordinal(s.day)}`;
}
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

interface PickedSchedule {
  schedule: Schedule;
  cls: CadenceClass;
  certainty: Certainty;
  maxMiss: number;
}
function pickSchedule(dates: readonly string[], adjust: Adjust): PickedSchedule | null {
  const cls = classifyCadence(dates, adjust);
  if (!cls) return null;
  let best: { s: Schedule; maxMiss: number; checked: number } | null = null;
  for (const s of cls.schedules) {
    const sc = scoreSchedule(s, dates, cls.minGap);
    if (!best || sc.maxMiss < best.maxMiss) best = { s, ...sc };
  }
  if (!best) return null;
  const certainty: Certainty | null =
    best.checked >= 3 && best.maxMiss <= 2 ? "confirmed" : best.checked >= 2 && best.maxMiss <= 4 ? "likely" : null;
  return certainty ? { schedule: best.s, cls, certainty, maxMiss: best.maxMiss } : null;
}

// ─── Seeded random stream ─────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Account roles ────────────────────────────────────────────────────────────────────────────

const isCashType = (t: string): boolean => t.trim().toLowerCase() === "cash";
const isCardType = (t: string): boolean => t.toLowerCase().includes("credit");
const isInvestmentType = (t: string): boolean => t.trim().toLowerCase() === "investment";

export function poolAccountKeys(accounts: readonly ForecastAccount[], settings?: ForecastSettings): string[] {
  if (settings?.poolAccountKeys?.length) {
    const known = new Set(accounts.map((a) => a.account_key));
    return settings.poolAccountKeys.filter((k) => known.has(k));
  }
  return accounts.filter((a) => isCashType(a.account_type)).map((a) => a.account_key);
}

function latestBalances(balances: readonly ForecastBalance[]): Map<string, ForecastBalance> {
  const out = new Map<string, ForecastBalance>();
  for (const b of balances) {
    if ((b.currency ?? "USD").toUpperCase() !== "USD") continue;
    const cur = out.get(b.account_key);
    if (!cur || b.captured_at > cur.captured_at) out.set(b.account_key, b);
  }
  return out;
}
/**
 * Whether `account` has a snapshot in another currency that is not older than the US-dollar one taken at `atMs`
 * (latestBalances skips those rows), or one whose date cannot be compared. Then the US-dollar balance is not known to
 * be the account's current one, so the safe-to-move gate must not count it as fresh.
 */
function supersededByOtherCurrency(balances: readonly ForecastBalance[], account: string, atMs: number): boolean {
  return balances.some((x) => x.account_key === account && (x.currency ?? "USD").toUpperCase() !== "USD" && !(Date.parse(x.captured_at) < atMs));
}
/** Owed on a card (positive) from its balance row: liabilities are stored as their size, sometimes negative. */
const owedFrom = (b: ForecastBalance | undefined): number => (b ? Math.abs(b.balance_cents) : 0);

// ─── Row preparation ──────────────────────────────────────────────────────────────────────────

interface Row {
  i: number;
  t: ForecastTxn;
  delta: number; // balance-positive
}

/** Pairs: transfers between two pool accounts (both left out) and pool payments to a card (card stream history). */
function pairRows(pool: Row[], cardRows: Row[]): { internal: Set<number>; cardPay: Map<number, string> } {
  const internal = new Set<number>();
  const cardPay = new Map<number, string>();
  const outs = pool.filter((r) => r.delta < 0);
  const ins = pool.filter((r) => r.delta > 0);
  for (const o of outs) {
    const match = ins.find(
      (n) =>
        !internal.has(n.i) &&
        n.t.account_key !== o.t.account_key &&
        n.delta === -o.delta &&
        Math.abs(daysBetween(o.t.txn_date, n.t.txn_date)) <= FORECAST.internalPairDays &&
        (isNonSpendingCategory(o.t.category) || isNonSpendingCategory(n.t.category)),
    );
    if (match) {
      internal.add(o.i);
      internal.add(match.i);
    }
  }
  const usedCard = new Set<number>();
  for (const o of outs) {
    if (internal.has(o.i)) continue;
    let best: Row | null = null;
    for (const c of cardRows) {
      if (usedCard.has(c.i) || c.delta !== -o.delta) continue; // card side: a payment lowers the balance (expense-negative)
      const gap = Math.abs(daysBetween(o.t.txn_date, c.t.txn_date));
      if (gap > FORECAST.cardPairDays) continue;
      if (!best || gap < Math.abs(daysBetween(o.t.txn_date, best.t.txn_date))) best = c;
    }
    if (best) {
      usedCard.add(best.i);
      cardPay.set(o.i, best.t.account_key);
    }
  }
  return { internal, cardPay };
}

// ─── Streams ──────────────────────────────────────────────────────────────────────────────────

/**
 * Grouping key for streams: the first three words of the label with digits and punctuation removed. Bank
 * descriptions often carry a per-deposit reference ("VOLT TECHNOLOGIE PAYROLL 8A2F ...") that a plain
 * normalized label keeps, which split one paycheck into six one-off deposits (found 2026-11-14).
 */
export function streamKey(t: { name: string | null; custom_name: string | null }): string {
  return wordKey(t);
}

interface StreamPlan {
  stream: DetectedStream;
  dates: string[]; // projected occurrence dates (after today, inside the horizon)
  claimed: number[]; // row indices this stream explains
  sampleCents?: number[]; // card payments: the amounts the range samples
  amounts?: number[]; // per-occurrence amounts (card payments: this month's remainder, then the monthly total)
}

function oncePerDay(rows: Row[]): { date: string; cents: number; rows: number[] }[] {
  const map = new Map<string, { date: string; cents: number; rows: number[] }>();
  for (const r of rows) {
    const cur = map.get(r.t.txn_date);
    if (cur) {
      cur.cents += Math.abs(r.delta);
      cur.rows.push(r.i);
    } else map.set(r.t.txn_date, { date: r.t.txn_date, cents: Math.abs(r.delta), rows: [r.i] });
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function projectDates(s: Schedule, minGap: number, last: string, today: string, horizonEnd: string, direction: Direction, notes: string[], label: string): string[] {
  const dates: string[] = [];
  let next = nextOnSchedule(s, last, minGap);
  if (next <= today) {
    // Overdue. Money out is kept (moved to tomorrow); money in that is more than a match window late is dropped.
    if (direction === "out" || daysBetween(next, today) <= FORECAST.matchWindowDays) dates.push(addDays(today, 1));
    else notes.push(`${label}: expected on ${next} and not seen yet, so it is not counted.`);
    while (next <= today) next = nextOnSchedule(s, next, minGap);
  }
  for (let guard = 0; next <= horizonEnd && guard < 400; guard++) {
    if (!dates.includes(next)) dates.push(next);
    next = nextOnSchedule(s, next, minGap);
  }
  return dates;
}

function detectStreams(external: Row[], today: string, horizonEnd: string, notes: string[]): StreamPlan[] {
  const groups = new Map<string, Row[]>();
  const since = addDays(today, -FORECAST.detectWindowDays);
  for (const r of external) {
    if (r.t.txn_date < since || r.delta === 0) continue;
    // Deposits group by the robust key (paychecks carry per-deposit references); spending keeps the merchant key,
    // because grouping card payments and everyday debits by three words merged unrelated rows (backtest 2026-11-14).
    const key = r.delta > 0 ? streamKey(r.t) : merchantKey(r.t);
    if (!key) continue;
    const g = `${r.delta > 0 ? "in" : "out"}|${key}`;
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  const plans: StreamPlan[] = [];
  for (const [g, rows] of groups) {
    const direction: Direction = g.startsWith("in|") ? "in" : "out";
    const occ = oncePerDay(rows);
    if (occ.length < FORECAST.minOccurrences) continue;
    const last6 = occ.slice(-6).map((o) => o.cents);
    const m6 = median(last6);
    const isStable = (c: number) => Math.abs(c - m6) <= FORECAST.amountBand * m6;
    const stable = occ.filter((o) => isStable(o.cents));
    if (stable.length < FORECAST.minOccurrences) continue;
    const picked = pickSchedule(stable.map((o) => o.date).slice(-12), direction === "in" ? "prev" : "next");
    if (!picked) {
      continue; // irregular: stays in the everyday baseline
    }
    const label = displayMerchant(rowLabel(rows[rows.length - 1].t));
    const lastDate = stable[stable.length - 1].date;
    if (daysBetween(lastDate, today) > FORECAST.lapseCycles * picked.cls.cycleDays + 5) {
      notes.push(`${label}: stopped after ${lastDate}, so it is not projected.`);
      continue;
    }
    const typical = Math.round(median(stable.slice(-3).map((o) => o.cents)));
    const outliers = occ.slice(-6).filter((o) => !isStable(o.cents)).length;
    if (outliers) notes.push(`${label}: ${outliers} of the last 6 amounts were unusual (for example a bonus) and are not projected.`);
    const signed = direction === "in" ? typical : -typical;
    const dates = projectDates(picked.schedule, picked.cls.minGap, lastDate, today, horizonEnd, direction, notes, label);
    const id = stableId(`stream|${g}`);
    plans.push({
      stream: {
        id,
        kind: direction === "in" ? "income" : "bill",
        label,
        direction,
        cadence: picked.cls.cadence,
        typicalCents: signed,
        next: dates[0] ?? null,
        certainty: picked.certainty,
        occurrences: stable.length,
        method: `${scheduleLabel(picked.schedule, picked.cls.cadence)}, usual amount from the last 3 (${stable.length} seen, dates within ${picked.maxMiss} days)`,
      },
      dates,
      claimed: rows.map((r) => r.i),
    });
  }
  return plans;
}

function detectCardStreams(
  pool: Row[],
  cardPay: Map<number, string>,
  accounts: readonly ForecastAccount[],
  today: string,
  horizonEnd: string,
  notes: string[],
  cardMonths: number = FORECAST.cardMeanPayments,
): StreamPlan[] {
  const byCard = new Map<string, Row[]>();
  for (const r of pool) {
    const card = cardPay.get(r.i);
    if (!card) continue;
    const list = byCard.get(card);
    if (list) list.push(r);
    else byCard.set(card, [r]);
  }
  // Model (backtest 2026-11-14): a card is often paid several times a month in varying amounts, so the
  // projection is the card's MONTHLY TOTAL paid (mean of the last 3 complete months), on the amount-weighted
  // usual day of the month, minus whatever was already paid this month. The range samples the last 6 months.
  const plans: StreamPlan[] = [];
  const thisMonth = monthIndex(monthKeyOf(today));
  for (const acct of accounts) {
    if (!isCardType(acct.account_type)) continue;
    const rows = (byCard.get(acct.account_key) ?? []).filter((r) => r.t.txn_date >= addDays(today, -FORECAST.detectWindowDays));
    const occ = oncePerDay(rows);
    if (occ.length < 2) {
      if (occ.length) notes.push(`${acct.label}: fewer than 2 payments from your cash accounts, so its payments are counted in everyday spending.`);
      continue;
    }
    const lastDate = occ[occ.length - 1].date;
    if (daysBetween(lastDate, today) > 70) {
      notes.push(`${acct.label}: no payment from your cash accounts since ${lastDate}, so none is projected.`);
      continue;
    }
    const firstMonth = monthIndex(monthKeyOf(occ[0].date));
    const totals: number[] = [];
    for (let k = 1; k <= Math.max(FORECAST.cardSamplePayments, cardMonths); k++) {
      const mi = thisMonth - k;
      if (mi < firstMonth) break;
      const key = monthFromIndex(mi);
      totals.push(occ.filter((o) => monthKeyOf(o.date) === key).reduce((sum, o) => sum + o.cents, 0));
    }
    if (!totals.length) totals.push(occ.reduce((sum, o) => sum + o.cents, 0));
    const typical = Math.round(mean(totals.slice(0, cardMonths)));
    if (typical <= 0) continue;
    // Amount-weighted median day of the month over the last 6 months of payments.
    const recent = occ.filter((o) => monthIndex(monthKeyOf(o.date)) >= thisMonth - 6);
    const byDay = [...(recent.length ? recent : occ)].sort((a, b) => dayOfMonth(a.date) - dayOfMonth(b.date));
    const half = byDay.reduce((sum, o) => sum + o.cents, 0) / 2;
    let acc = 0;
    let day = dayOfMonth(byDay[byDay.length - 1].date);
    for (const o of byDay) {
      acc += o.cents;
      if (acc >= half) {
        day = dayOfMonth(o.date);
        break;
      }
    }
    const paidThisMonth = occ.filter((o) => monthKeyOf(o.date) === monthKeyOf(today)).reduce((sum, o) => sum + o.cents, 0);
    const dates: string[] = [];
    const amounts: number[] = [];
    const remaining = typical - paidThisMonth;
    if (remaining > 0) {
      let d = cardPayDay(monthKeyOf(today), day);
      if (d <= today) d = addDays(today, 1);
      dates.push(d);
      amounts.push(-remaining);
    }
    for (let k = 1; k <= 25; k++) {
      const d = cardPayDay(monthFromIndex(thisMonth + k), day);
      if (d > horizonEnd) break;
      if (dates.includes(d)) continue;
      dates.push(d);
      amounts.push(-typical);
    }
    const monthsPaid = totals.slice(0, 3).filter((t) => t > 0).length;
    plans.push({
      stream: {
        id: stableId(`card|${acct.account_key}`),
        kind: "card",
        label: `${acct.label} payment`,
        direction: "out",
        cadence: "monthly",
        typicalCents: -typical,
        next: dates[0] ?? null,
        certainty: monthsPaid >= 3 ? "confirmed" : "likely",
        occurrences: occ.length,
        method: `monthly total = mean paid in the last ${Math.min(cardMonths, totals.length)} months, around the ${ordinal(day)}${paidThisMonth > 0 ? `; ${fmt(paidThisMonth)} already paid this month` : ""}`,
      },
      dates,
      amounts,
      claimed: rows.map((r) => r.i),
      sampleCents: totals.map((t) => -t),
    });
  }
  return plans;
}

/** A card's payment day in a month: the next business day, except days 28+ stay in their month (previous business day). */
function cardPayDay(monthKey: string, day: number): string {
  const d = clampedDay(monthKey, day);
  return day >= 28 ? previousBusinessDay(d) : nextBusinessDay(d);
}

/** Monthly-total card streams for unpaired card payments, one per payee (e.g. "APPLECARD GSBANK PAYMENT"). */
function detectPayeeCardStreams(rows: Row[], today: string, horizonEnd: string, notes: string[], cardMonths: number = FORECAST.cardMeanPayments): StreamPlan[] {
  const byPayee = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.t.txn_date < addDays(today, -FORECAST.detectWindowDays)) continue;
    const key = merchantKey(r.t);
    if (!key) continue;
    const list = byPayee.get(key);
    if (list) list.push(r);
    else byPayee.set(key, [r]);
  }
  const plans: StreamPlan[] = [];
  const thisMonth = monthIndex(monthKeyOf(today));
  for (const [key, list] of byPayee) {
    const occ = oncePerDay(list);
    if (occ.length < 2) continue;
    const lastDate = occ[occ.length - 1].date;
    const label = `${displayMerchant(rowLabel(list[list.length - 1].t))} (card payment)`;
    if (daysBetween(lastDate, today) > 70) {
      notes.push(`${label}: none since ${lastDate}, so none is projected.`);
      continue;
    }
    const firstMonth = monthIndex(monthKeyOf(occ[0].date));
    const totals: number[] = [];
    for (let k = 1; k <= Math.max(FORECAST.cardSamplePayments, cardMonths); k++) {
      const mi = thisMonth - k;
      if (mi < firstMonth) break;
      const mk = monthFromIndex(mi);
      totals.push(occ.filter((o) => monthKeyOf(o.date) === mk).reduce((sum, o) => sum + o.cents, 0));
    }
    if (!totals.length) totals.push(occ.reduce((sum, o) => sum + o.cents, 0));
    const typical = Math.round(mean(totals.slice(0, cardMonths)));
    if (typical <= 0) continue;
    const recent = occ.filter((o) => monthIndex(monthKeyOf(o.date)) >= thisMonth - 6);
    const byDay = [...(recent.length ? recent : occ)].sort((a, b) => dayOfMonth(a.date) - dayOfMonth(b.date));
    const half = byDay.reduce((sum, o) => sum + o.cents, 0) / 2;
    let acc = 0;
    let day = dayOfMonth(byDay[byDay.length - 1].date);
    for (const o of byDay) {
      acc += o.cents;
      if (acc >= half) {
        day = dayOfMonth(o.date);
        break;
      }
    }
    const paidThisMonth = occ.filter((o) => monthKeyOf(o.date) === monthKeyOf(today)).reduce((sum, o) => sum + o.cents, 0);
    const dates: string[] = [];
    const amounts: number[] = [];
    if (typical - paidThisMonth > 0) {
      let d = cardPayDay(monthKeyOf(today), day);
      if (d <= today) d = addDays(today, 1);
      dates.push(d);
      amounts.push(-(typical - paidThisMonth));
    }
    for (let k = 1; k <= 25; k++) {
      const d = cardPayDay(monthFromIndex(thisMonth + k), day);
      if (d > horizonEnd) break;
      if (dates.includes(d)) continue;
      dates.push(d);
      amounts.push(-typical);
    }
    plans.push({
      stream: {
        id: stableId(`cardpayee|${key}`),
        kind: "card",
        label,
        direction: "out",
        cadence: "monthly",
        typicalCents: -typical,
        next: dates[0] ?? null,
        certainty: totals.slice(0, 3).filter((t) => t > 0).length >= 3 ? "confirmed" : "likely",
        occurrences: occ.length,
        method: `monthly total = mean paid in the last ${Math.min(cardMonths, totals.length)} months, around the ${ordinal(day)} (no matching rows on the card's own account)`,
      },
      dates,
      amounts,
      claimed: list.map((r) => r.i),
      sampleCents: totals.map((t) => -t),
    });
  }
  return plans;
}

// ─── Planned items ────────────────────────────────────────────────────────────────────────────

interface PlannedOcc {
  id: string;
  label: string;
  date: string;
  amount: number;
  certainty: Certainty;
  window: number;
  tolerance: number;
  account?: string;
}
function expandPlanned(items: readonly PlannedItem[]): PlannedOcc[] {
  const out: PlannedOcc[] = [];
  for (const it of items) {
    if (!isDay(it.date) || !Number.isFinite(it.amountCents) || it.amountCents === 0) continue;
    const count = Math.max(1, Math.min(it.repeat?.count ?? 1, 400));
    const every = Math.max(1, it.repeat?.every ?? 1);
    for (let k = 0; k < count; k++) {
      const date =
        !it.repeat || k === 0
          ? it.date
          : it.repeat.unit === "month"
            ? addMonths(it.date, k * every)
            : addDays(it.date, k * every * (it.repeat.unit === "week" ? 7 : 1));
      out.push({
        id: count > 1 ? `${it.id}#${k + 1}` : it.id,
        label: it.label,
        date,
        amount: Math.round(it.amountCents),
        certainty: it.certainty,
        window: it.matchWindowDays ?? FORECAST.matchWindowDays,
        tolerance: it.matchTolerance ?? FORECAST.matchTolerance,
        account: it.account,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─── The forecast ─────────────────────────────────────────────────────────────────────────────

const EMPTY_HEADLINES: ForecastResult["headlines"] = { lowest: null, lowestLikely: null, safeToMoveCents: null, end13w: null, end12m: null, nextPromoEnd: null };

export function forecastCash(input: ForecastInput): ForecastResult {
  const { today } = input;
  const settings = input.settings ?? {};
  const H = Math.max(28, Math.min(settings.horizonDays ?? FORECAST.horizonDays, 730));
  const horizonEnd = addDays(today, H);
  const notes: string[] = [];
  const warnings: string[] = [];
  const accountsByKey = new Map(input.accounts.map((a) => [a.account_key, a]));
  const poolKeys = poolAccountKeys(input.accounts, settings);
  const poolSet = new Set(poolKeys);
  const pool = poolKeys.map((k) => ({ account_key: k, label: accountsByKey.get(k)?.label ?? k }));
  const latest = latestBalances(input.balances);

  // Eligibility: every reason the inputs do not support an actionable amount. Any reason withholds safe to move.
  const reasons: EligibilityReason[] = [];
  const reason = (code: EligibilityCode, text: string, account?: string) => {
    if (!reasons.some((r) => r.text === text)) reasons.push(account ? { code, text, account } : { code, text });
  };
  const notEligible = (): ForecastEligibility => ({ eligible: false, reasons: [...reasons] });
  const quality = input.quality ?? {};
  if (quality.historyTruncated) {
    warnings.push("Part of the history was not read (page limit), so the forecast may be off.");
    reason("history-truncated", "Part of the balance or transaction history was not read.");
  }
  if (quality.planUnavailable) reason("plan-unavailable", "Planned items or plan settings could not be read, so planned payments and taxes may be missing.");
  if (quality.planInvalid) reason("plan-invalid", "Your saved tax profile or move plan could not be read, so planned taxes or move costs may be missing.");
  if (quality.categoriesUnavailable) reason("categories-unavailable", "Your category fixes could not be read, so some transfers or card payments may be counted as spending.");

  const base: ForecastResult = {
    state: "ok",
    today,
    pool,
    opening: { cents: 0, asOf: null, stale: false },
    eligibility: UNVERIFIED,
    days: [],
    lines: [],
    streams: [],
    baseline: { weeklyMeanCents: 0, weeksUsed: 0, projected: false, oneOffs: 0 },
    planned: [],
    weeks: [],
    months: [],
    headlines: EMPTY_HEADLINES,
    cards: [],
    netWorth: [],
    milestones: [],
    notes,
    warnings,
  };
  if (!poolKeys.length) {
    reason("no-pool", "No checking or savings account found.");
    return { ...base, state: "no-pool", eligibility: notEligible() };
  }

  // Opening balance.
  let opening = 0;
  let asOf: string | null = null;
  let stale = false;
  // What the actionable amount does not count, and how long its check holds (eligibility below).
  const staleMs = FORECAST.staleBalanceHours * 3_600_000;
  const leaveOut = new Set(settings.safeToMoveLeaveOut ?? []);
  const unreadable = new Set(quality.balanceUnreadable ?? []);
  const leftOut: LeftOutAccount[] = [];
  let leftOutCents = 0;
  let cashAsOf: string | null = null;
  let validUntilMs = Number.POSITIVE_INFINITY;
  if (settings.openingOverride) {
    opening = Math.round(settings.openingOverride.cents);
    asOf = settings.openingOverride.asOf;
  } else {
    let found = 0;
    for (const k of poolKeys) {
      const label = accountsByKey.get(k)?.label ?? k;
      const chosen = leaveOut.has(k);
      const b = latest.get(k);
      // A balance read that failed: the balance is unknown (it could be an overdraft), so the amount is withheld
      // whether or not Riley left the account out, and the reason carries no account (leaving it out cannot clear it).
      if (unreadable.has(k)) reason("balance-unreadable", `The balance for ${label} could not be read.`);
      if (!b || !Number.isFinite(b.balance_cents)) {
        warnings.push(`No balance for ${label}: counted as $0.`);
        if (chosen) leftOut.push({ account: k, label, asOf: null, why: "chosen" });
        // An unreadable one is already named above: not "missing", the read did not answer.
        else if (!unreadable.has(k)) {
          // A row in another currency (or with no usable amount) is there but cannot be counted: invalid, not missing.
          if (b || input.balances.some((x) => x.account_key === k)) reason("invalid-balance", `The balance for ${label} is not a usable US-dollar amount.`, k);
          else reason("missing-balance", `No recent balance for ${label}.`, k);
        }
        continue;
      }
      found++;
      const signedCents = b.kind === "liability" ? -Math.abs(b.balance_cents) : b.balance_cents;
      opening += signedCents;
      if (!asOf || b.captured_at < asOf) asOf = b.captured_at;
      const at = Date.parse(b.captured_at);
      const age = input.now && Number.isFinite(at) ? input.now.getTime() - at : null;
      const big = Math.abs(b.balance_cents) >= FORECAST.smallBalanceCents;
      const tooOld = age !== null && age > staleMs;
      // The projection's stale badge: a small balance that rarely updates (Apple Cash) does not flag the whole forecast.
      if (tooOld && big) stale = true;
      // Left out by Riley: not counted in the amount (only its positive part; an overdraft keeps lowering it) and not
      // checked for freshness. The projection still counts it.
      if (chosen) {
        leftOut.push({ account: k, label, asOf: b.captured_at, why: "chosen" });
        leftOutCents += Math.max(0, signedCents);
        continue;
      }
      if (!Number.isFinite(at)) {
        reason("invalid-balance", `The balance for ${label} has no readable date.`, k);
        continue;
      }
      // The account's NEWEST snapshot decides, in any currency: a newer row in another currency means this older
      // US-dollar balance is not its current one, however fresh it looks. Withheld like any unusable balance (the
      // estimate keeps the last US-dollar balance; Leave it out clears the reason).
      if (supersededByOtherCurrency(input.balances, k, at)) {
        warnings.push(`The newest balance for ${label} is not in US dollars: the estimate uses its last US-dollar balance.`);
        reason("invalid-balance", `The balance for ${label} is not a usable US-dollar amount.`, k);
        continue;
      }
      if (age === null) {
        if (!cashAsOf || b.captured_at < cashAsOf) cashAsOf = b.captured_at;
        continue;
      }
      if (age < -FORECAST.futureBalanceSkewMs) {
        reason("invalid-balance", `The balance for ${label} is dated in the future.`, k);
        continue;
      }
      // A balance too old to trust withholds the amount whatever its size: an old small or zero balance is no proof
      // the account is not overdrawn now. Leaving the account out ("Leave it out", Riley's explicit choice) is the
      // only way to stop it counting.
      if (tooOld) {
        reason("stale-balance", `The balance for ${label} is older than ${FORECAST.staleBalanceHours} hours.`, k);
        continue;
      }
      // A fresh balance the amount counts: the check holds until it turns staleBalanceHours old.
      validUntilMs = Math.min(validUntilMs, at + staleMs);
      if (!cashAsOf || b.captured_at < cashAsOf) cashAsOf = b.captured_at;
    }
    if (!found) {
      reason("no-balance", "No balance yet for your cash accounts.");
      return { ...base, state: "no-balance", eligibility: notEligible() };
    }
    if (!input.now) reason("freshness-unknown", "The balance dates could not be checked.");
    if (stale) warnings.push(`A cash balance is older than ${FORECAST.staleBalanceHours} hours, so the starting point may be off.`);
  }

  // Rows: USD, dated up to today. Rows the budget ignores are KEPT: they still moved cash (the backtest of
  // 2026-11-14 showed that leaving them out made the forecast too optimistic). Card spending still uses
  // counted rows only.
  const rows: Row[] = [];
  input.txns.forEach((t, i) => {
    if (!isDay(t.txn_date) || t.txn_date > today) return;
    if ((t.currency ?? "USD").toUpperCase() !== "USD") return;
    rows.push({ i, t, delta: toBalanceDelta(t.amount_cents) });
  });
  const poolRows = rows.filter((r) => poolSet.has(r.t.account_key));
  const cardRows = rows.filter((r) => isCardType(accountsByKey.get(r.t.account_key)?.account_type ?? ""));
  const { internal, cardPay } = pairRows(poolRows, cardRows);
  const external = poolRows.filter((r) => !internal.has(r.i) && !cardPay.has(r.i));

  // Streams and card payments.
  // Pool payments filed as card payments that could not be paired with a card account's rows (a card whose
  // feed is monthly, or one not connected): modeled per payee as monthly totals, like paired card payments.
  const unpairedCardRows = external.filter((r) => r.delta < 0 && /credit card payment/i.test(r.t.category ?? ""));
  const cardMonths = Math.max(1, Math.min(12, Math.round(settings.cardMonths ?? FORECAST.cardMeanPayments)));
  const unpairedCards = detectPayeeCardStreams(unpairedCardRows, today, horizonEnd, notes, cardMonths);
  const unpairedClaimed = new Set(unpairedCards.flatMap((p) => p.claimed));
  const streamPlans = [
    ...detectStreams(external.filter((r) => !unpairedClaimed.has(r.i)), today, horizonEnd, notes),
    ...detectCardStreams(poolRows, cardPay, input.accounts, today, horizonEnd, notes, cardMonths),
    ...unpairedCards,
  ];
  const claimed = new Set<number>();
  for (const p of streamPlans) for (const i of p.claimed) claimed.add(i);

  // Planned items: match to actuals first (asymmetric: late money in is dropped, late money out is kept).
  const plannedOcc = expandPlanned(input.planned ?? []);
  const planned: PlannedStatus[] = [];
  const projectedPlanned: PlannedOcc[] = [];
  const usedRows = new Set<number>();
  const matchable = poolRows.filter((r) => !internal.has(r.i));
  for (const p of plannedOcc) {
    const from = addDays(p.date, -p.window);
    const to = addDays(p.date, FORECAST.lateMatchDays);
    let best: Row | null = null;
    for (const r of matchable) {
      if (usedRows.has(r.i) || Math.sign(r.delta) !== Math.sign(p.amount)) continue;
      if (r.t.txn_date < from || r.t.txn_date > to) continue;
      if (Math.abs(r.delta - p.amount) > p.tolerance * Math.abs(p.amount)) continue;
      if (!best || Math.abs(daysBetween(p.date, r.t.txn_date)) < Math.abs(daysBetween(p.date, best.t.txn_date))) best = r;
    }
    const status: PlannedStatus = { id: p.id, label: p.label, date: p.date, amountCents: p.amount, status: "upcoming" };
    if (best) {
      usedRows.add(best.i);
      claimed.add(best.i);
      status.status = "realized";
      status.matchedDate = best.t.txn_date;
      status.matchedCents = best.delta;
    } else if (p.date <= today) {
      const late = daysBetween(p.date, today) > p.window;
      if (late && p.amount > 0) status.status = "late-dropped";
      else {
        status.status = late ? "late-kept" : "pending";
        projectedPlanned.push({ ...p, date: addDays(today, 1) });
      }
      if (late) notes.push(`${p.label} (${p.date}): no matching transaction yet. ${p.amount > 0 ? "Not counted until it arrives." : "Still counted, as of tomorrow."}`);
    } else projectedPlanned.push(p);
    planned.push(status);
  }

  // Everyday baseline: weekly net flow of what is left.
  const L = Math.max(4, Math.min(settings.lookbackWeeks ?? FORECAST.lookbackWeeks, 104));
  const firstPoolDate = poolRows.reduce<string | null>((m, r) => (!m || r.t.txn_date < m ? r.t.txn_date : m), null);
  const windowStart = addDays(today, -7 * L + 1);
  const residual = external.filter((r) => !claimed.has(r.i) && r.t.txn_date >= windowStart);
  // The one-off cut comes from the leftover rows themselves (paychecks and other streams would raise it).
  const sizes = residual.map((r) => Math.abs(r.delta)).sort((a, b) => a - b);
  const oneOffCut = Math.max(FORECAST.oneOffMinCents, FORECAST.oneOffP95Multiple * percentile(sizes, 0.95));
  // Asymmetric caution: only unusually large money IN is left out (a refund, a gift). Large money out stays in
  // the mean: rent paid by transfer, a lump payment to a card, a move all recur in some form (backtest 2026-11-14).
  const isOneOff = (r: Row) => r.delta > 0 && r.delta > oneOffCut;
  const oneOffs = residual.filter(isOneOff);
  if (oneOffs.length) {
    const inn = oneOffs.reduce((s, r) => s + r.delta, 0);
    notes.push(
      `${oneOffs.length} unusually large deposit${oneOffs.length > 1 ? "s" : ""} in the last ${L} weeks (${fmt(inn)} in total) ${oneOffs.length > 1 ? "are" : "is"} not counted as everyday money in. Add a planned item if one will repeat.`,
    );
  }
  const weeklySeries: number[] = [];
  for (let w = L - 1; w >= 0; w--) {
    const end = addDays(today, -7 * w);
    const start = addDays(end, -6);
    if (!firstPoolDate || start < firstPoolDate) continue;
    let sum = 0;
    for (const r of residual) if (r.t.txn_date >= start && r.t.txn_date <= end && !isOneOff(r)) sum += r.delta;
    weeklySeries.push(sum);
  }
  const baselineProjected = weeklySeries.length >= FORECAST.minBaselineWeeks;
  const weeklyMean = baselineProjected ? Math.round(mean(weeklySeries)) : 0;
  if (!baselineProjected) {
    warnings.push(`Fewer than ${FORECAST.minBaselineWeeks} weeks of history: everyday spending is not projected.`);
    reason("short-history", `Fewer than ${FORECAST.minBaselineWeeks} weeks of history, so everyday spending is not in the forecast.`);
  }

  // Stream adjustments (stop / new amount from a date).
  const adjustments = input.adjustments ?? [];
  const amountFor = (streamId: string, date: string, normal: number): number | null => {
    let amount: number | null = normal;
    for (const a of adjustments) {
      if (a.streamId !== streamId || date < a.from) continue;
      if (a.stop) amount = null;
      else if (typeof a.amountCents === "number" && Number.isFinite(a.amountCents)) amount = Math.round(a.amountCents);
    }
    return amount;
  };

  // Day index i (0-based) is today + i + 1.
  const dayIdx = (date: string): number => daysBetween(today, date) - 1;
  const inflation = (i: number): number => Math.pow(1 + (settings.inflationPct ?? 0) / 100, (i + 1) / 365);

  interface Occ {
    idx: number;
    amount: number;
    plan: StreamPlan;
    k: number;
  }
  const streamOcc: Occ[] = [];
  const lines: ForecastLine[] = [];
  for (const p of streamPlans) {
    p.dates.forEach((date, k) => {
      const idx = dayIdx(date);
      if (idx < 0 || idx >= H) return;
      const amt = amountFor(p.stream.id, date, p.amounts?.[k] ?? p.stream.typicalCents);
      if (amt === null) return;
      streamOcc.push({ idx, amount: amt, plan: p, k });
      lines.push({ date, amountCents: amt, label: p.stream.label, layer: "detected", certainty: p.stream.certainty, sourceId: p.stream.id, reason: p.stream.method });
    });
  }
  base.streams = streamPlans.map((p) => p.stream);

  const inVariant = (o: PlannedOcc, variant: "likely" | "low" | "high"): boolean => {
    if (variant === "likely") return o.certainty !== "possible";
    if (variant === "low") return o.amount < 0 || o.certainty === "confirmed";
    return o.amount > 0 || o.certainty !== "possible";
  };
  for (const o of projectedPlanned) {
    if (!inVariant(o, "likely")) continue;
    if (dayIdx(o.date) < 0 || dayIdx(o.date) >= H) continue;
    lines.push({ date: o.date, amountCents: o.amount, label: o.label, layer: "planned", certainty: o.certainty, sourceId: o.id, reason: `Planned (${o.certainty})` });
  }
  if (baselineProjected && weeklyMean !== 0) {
    for (let w = 0; w * 7 < H; w++) {
      const date = addDays(today, 7 * w + 1);
      lines.push({
        date,
        amountCents: Math.round(weeklyMean * inflation(7 * w)),
        label: "Everyday spending (week)",
        layer: "baseline",
        certainty: "likely",
        sourceId: "baseline",
        reason: `Mean weekly net flow of the last ${weeklySeries.length} weeks, after the lines above`,
      });
    }
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // Paths.
  const buildFlows = (variant: "likely" | "low" | "high", rng: (() => number) | null): Float64Array => {
    const F = new Float64Array(H);
    for (const o of streamOcc) {
      let amount = o.amount;
      const samples = o.plan.sampleCents;
      const normal = o.plan.amounts?.[o.k] ?? o.plan.stream.typicalCents;
      // Sample full months only (not this month's remainder), and never an amount the user adjusted.
      if (rng && samples?.length && normal === o.plan.stream.typicalCents && o.amount === normal) {
        amount = samples[Math.floor(rng() * samples.length)];
      }
      F[o.idx] += amount;
    }
    for (const o of projectedPlanned) {
      const idx = dayIdx(o.date);
      if (idx >= 0 && idx < H && inVariant(o, variant)) F[idx] += o.amount;
    }
    if (baselineProjected) {
      const weeks = Math.ceil(H / 7);
      const n = weeklySeries.length;
      const B = Math.min(FORECAST.blockWeeks, n);
      let w = 0;
      while (w < weeks) {
        if (!rng) {
          for (let d = 0; d < 7 && w * 7 + d < H; d++) F[w * 7 + d] += (weeklyMean / 7) * inflation(w * 7 + d);
          w++;
          continue;
        }
        const start = Math.floor(rng() * (n - B + 1));
        for (let b = 0; b < B && w < weeks; b++, w++) {
          const wk = weeklySeries[start + b];
          for (let d = 0; d < 7 && w * 7 + d < H; d++) F[w * 7 + d] += (wk / 7) * inflation(w * 7 + d);
        }
      }
    }
    return F;
  };
  const cumulative = (F: Float64Array): Float64Array => {
    const out = new Float64Array(H);
    let bal = opening;
    for (let i = 0; i < H; i++) {
      bal += F[i];
      out[i] = bal;
    }
    return out;
  };
  const likelyPath = cumulative(buildFlows("likely", null));
  const P = Math.max(50, Math.min(settings.paths ?? FORECAST.paths, 2000));
  const rng = mulberry32(settings.seed ?? FORECAST.seed);
  const bandAt = (variant: "low" | "high", p: number): Float64Array => {
    const paths: Float64Array[] = [];
    for (let k = 0; k < P; k++) paths.push(cumulative(buildFlows(variant, rng)));
    const out = new Float64Array(H);
    const col = new Float64Array(P);
    for (let i = 0; i < H; i++) {
      for (let k = 0; k < P; k++) col[k] = paths[k][i];
      col.sort();
      out[i] = col[Math.min(P - 1, Math.max(0, Math.round(p * (P - 1))))];
    }
    return out;
  };
  const low = bandAt("low", settings.lowPercentile ?? FORECAST.lowPercentile);
  const high = bandAt("high", settings.highPercentile ?? FORECAST.highPercentile);
  const days: DayPoint[] = [];
  for (let i = 0; i < H; i++) {
    const likely = Math.round(likelyPath[i]);
    days.push({ date: addDays(today, i + 1), likely, low: Math.min(Math.round(low[i]), likely), high: Math.max(Math.round(high[i]), likely) });
  }

  // Headlines.
  const short = days.slice(0, Math.min(FORECAST.shortHorizonDays, H));
  const minBy = (pick: (d: DayPoint) => number) =>
    short.reduce<{ date: string; cents: number } | null>((m, d) => (!m || pick(d) < m.cents ? { date: d.date, cents: pick(d) } : m), null);
  const lowest = minBy((d) => d.low);
  const lowestLikely = minBy((d) => d.likely);
  const buffer = Math.max(0, settings.bufferCents ?? 0);
  const at = (n: number) => (days[n - 1] ? { likely: days[n - 1].likely, low: days[n - 1].low, high: days[n - 1].high } : null);
  if (!Number.isFinite(opening) || !Number.isFinite(buffer) || days.some((d) => !Number.isFinite(d.low) || !Number.isFinite(d.likely))) {
    reason("invalid-input", "Some forecast inputs are not valid numbers.");
  }
  const eligibility: ForecastEligibility = {
    eligible: reasons.length === 0,
    reasons: [...reasons],
    ...(Number.isFinite(validUntilMs) ? { validUntil: new Date(validUntilMs).toISOString() } : {}),
    ...(leftOut.length ? { leftOut } : {}),
    ...(cashAsOf ? { cashAsOf } : {}),
  };
  const headlines: ForecastResult["headlines"] = {
    lowest,
    lowestLikely,
    // Withheld unless every input was read, complete and fresh: an amount Riley could act on must not rest on a
    // stale balance or on planned obligations that could not be read.
    // Accounts Riley left out take their positive balance out of both the opening and the lowest point: the same as
    // starting the path without it (an overdraft on one keeps lowering the amount).
    safeToMoveCents: eligibility.eligible && lowest ? Math.max(0, Math.min(opening, lowest.cents) - leftOutCents - buffer) : null,
    end13w: at(Math.min(91, H)),
    end12m: at(Math.min(365, H)),
    nextPromoEnd: null,
  };

  // Rollups from the likely lines.
  const rollup = (keyOf: (date: string) => string): Rollup[] => {
    const map = new Map<string, Rollup>();
    for (const l of lines) {
      const key = keyOf(l.date);
      const r = map.get(key) ?? { key, inCents: 0, outCents: 0, endLikely: 0, endLow: 0, endHigh: 0 };
      if (l.amountCents > 0) r.inCents += l.amountCents;
      else r.outCents += l.amountCents;
      map.set(key, r);
    }
    for (const d of days) {
      const r = map.get(keyOf(d.date));
      if (r) {
        r.endLikely = d.likely;
        r.endLow = d.low;
        r.endHigh = d.high;
      }
    }
    return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  };
  const weekKey = (date: string) => addDays(today, 1 + 7 * Math.floor(dayIdx(date) / 7));
  const weeks = rollup(weekKey).slice(0, 13);
  const months = rollup(monthKeyOf).slice(0, 13);

  // Net worth side.
  const cards = projectCards(input, latest, cardRows, streamPlans, today);
  // Planned transfers into (or out of) an investment account move the money there, so net worth sees both sides.
  const transfers = projectedPlanned
    .filter((o) => o.account && inVariant(o, "likely") && dayIdx(o.date) >= 0 && dayIdx(o.date) < H)
    .map((o) => ({ account_key: o.account!, date: o.date, cents: -o.amount }));
  const netWorth = projectNetWorth(input, latest, cards, days, today, transfers);
  const milestones = promoMilestones(cards, today, horizonEnd);
  headlines.nextPromoEnd = milestones.find((m) => !m.ended) ?? null;

  return {
    ...base,
    opening: { cents: opening, asOf, stale },
    eligibility,
    days,
    lines,
    baseline: { weeklyMeanCents: weeklyMean, weeksUsed: weeklySeries.length, projected: baselineProjected, oneOffs: oneOffs.length },
    planned,
    weeks,
    months,
    headlines,
    cards,
    netWorth,
    milestones,
  };
}

/** Promo end dates as dated call-outs, soonest first (Riley, 2026-11-14: the forecast must show where the 0% ends). */
function promoMilestones(cards: CardProjection[], today: string, horizonEnd: string): PromoMilestone[] {
  const thisMonth = monthIndex(monthKeyOf(today));
  const out: PromoMilestone[] = [];
  for (const c of cards) {
    if (!c.promoEnds) continue;
    const end = c.promoEnds;
    const endMonth = monthKeyOf(end);
    const ended = end < today;
    const atEnd = ended || monthIndex(endMonth) <= thisMonth
      ? c.owedNow
      : (c.months.find((m) => m.month === endMonth)?.owed ?? c.months[c.months.length - 1]?.owed ?? c.owedNow);
    const monthsLeft = Math.max(1, monthIndex(endMonth) - thisMonth + 1);
    out.push({
      date: end,
      kind: "promo-end",
      account_key: c.account_key,
      label: c.label,
      promoAprPct: c.promoAprPct ?? 0,
      source: c.promoSource ?? "entered",
      owedAtEndCents: atEnd,
      standardAprPct: c.standardAprPct,
      standardAprAssumed: c.standardAprAssumed,
      interestPerMonthAfterCents: Math.round((atEnd * c.standardAprPct) / 100 / 12),
      payPerMonthToClearCents: ended ? 0 : Math.ceil((c.owedNow + c.monthlySpendCents * monthsLeft) / monthsLeft),
      daysAway: daysBetween(today, end),
      withinHorizon: end <= horizonEnd,
      ended,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const fmt = (cents: number): string => `$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;

// ─── Net worth side: cards, interest, promos, investments ─────────────────────────────────────

const INTEREST_RE = /interest/i;
const BT_RE = /(?:\dbt\b|\bbt\b|\bbal(?:ance)?\.?\s*(?:xfr|xfer|transfer))/i;
const EXPIRES_RE = /\bexpires?\s*(\d{1,2})\/(\d{4})\b/i;
const APR_RE = /\bapr\s*(\d{1,2}(?:\.\d+)?)\s*%/i;

/** Promo end from a balance-transfer row's text ("... BT CA APR 0.00% EXPIRES 08/2027" -> last day of 08/2027). */
export function parsePromo(text: string): { promoEnds: string; promoAprPct: number } | null {
  if (!BT_RE.test(text)) return null;
  const m = EXPIRES_RE.exec(text);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  const apr = APR_RE.exec(text);
  return { promoEnds: ymd(year, month, daysInMonth(year, month)), promoAprPct: apr ? Number(apr[1]) : 0 };
}

function projectCards(
  input: ForecastInput,
  latest: Map<string, ForecastBalance>,
  cardRows: Row[],
  plans: StreamPlan[],
  today: string,
): CardProjection[] {
  const out: CardProjection[] = [];
  const terms = new Map((input.cardTerms ?? []).map((t) => [t.account_key, t]));
  const thisMonth = monthIndex(monthKeyOf(today));
  for (const acct of input.accounts) {
    if (!isCardType(acct.account_type)) continue;
    const rows = cardRows.filter((r) => r.t.account_key === acct.account_key);
    const owed = owedFrom(latest.get(acct.account_key));
    if (!rows.length && !owed) continue;
    const warnings: string[] = [];
    const t = terms.get(acct.account_key);

    // Spending: counted rows (purchases, refunds, interest, fees), mean of the last complete months with activity.
    const firstMonth = rows.reduce((m, r) => Math.min(m, monthIndex(monthKeyOf(r.t.txn_date))), Infinity);
    const spendMonths: number[] = [];
    for (let k = 1; k <= FORECAST.cardSpendMonths; k++) {
      const mi = thisMonth - k;
      if (mi < firstMonth) break;
      const key = monthFromIndex(mi);
      spendMonths.push(
        rows.filter((r) => monthKeyOf(r.t.txn_date) === key && classifyTxn(r.t) === "counted" && !INTEREST_RE.test(rowLabel(r.t))).reduce((s, r) => s - r.delta, 0),
      );
    }
    const monthlySpend = Math.max(0, Math.round(mean(spendMonths)));
    const plan = plans.find((p) => p.stream.id === stableId(`card|${acct.account_key}`));
    const monthlyPayment = plan ? Math.abs(plan.stream.typicalCents) : 0;

    // Promo: an explicit driver, else the newest balance-transfer row whose text carries "EXPIRES MM/YYYY".
    let promoEnds: string | null = t?.promoEnds ?? null;
    let promoApr = t?.promoAprPct ?? 0;
    let promoSource: string | null = t?.promoEnds ? t.promoNote?.trim() || "entered" : null;
    if (!promoEnds) {
      for (const r of [...rows].reverse()) {
        const p = parsePromo(rowLabel(r.t));
        if (p) {
          promoEnds = p.promoEnds;
          promoApr = p.promoAprPct;
          promoSource = `from the transfer on ${r.t.txn_date}`;
          break;
        }
      }
    }

    // APR: an explicit driver, else the effective rate the ledger shows over the last 3 months.
    const since = addDays(today, -91);
    const interest3m = rows.filter((r) => r.t.txn_date >= since && r.delta < 0 && INTEREST_RE.test(`${rowLabel(r.t)} ${r.t.category ?? ""}`)).reduce((s, r) => s - r.delta, 0);
    const interest12m = rows.filter((r) => r.t.txn_date >= addDays(today, -365) && r.delta < 0 && INTEREST_RE.test(`${rowLabel(r.t)} ${r.t.category ?? ""}`)).length;
    let apr: number;
    let aprSource: string;
    if (typeof t?.aprPct === "number") {
      apr = t.aprPct;
      aprSource = "entered";
    } else if (interest3m > 0 && owed > 0) {
      apr = Math.round(((interest3m * 4) / owed) * 1000) / 10;
      aprSource = "effective rate from the last 3 months of interest charges";
    } else {
      apr = 0;
      aprSource = interest12m ? "no interest in the last 3 months" : "no interest charged in 12 months";
    }
    const standardApr = t?.standardAprPct ?? FORECAST.defaultStandardAprPct;
    if (promoEnds && !t?.standardAprPct) warnings.push(`Standard APR after the promo is not known: ${standardApr}% assumed. Enter the one on your statement.`);
    if (apr === 0 && owed > 0 && !promoEnds) warnings.push("Carries a balance with no interest and no known promo end date: enter the date from your statement.");

    // Month by month: interest on the balance, then spending, then payments.
    let bal = owed;
    let interestNext12 = 0;
    const months: CardProjection["months"] = [];
    const extras = (input.extraCardPayments ?? []).filter((x) => x.account_key === acct.account_key && x.cents > 0);
    for (let k = 1; k <= 24; k++) {
      const key = monthFromIndex(thisMonth + k);
      const monthStart = `${key}-01`;
      const rate = promoEnds && monthStart <= promoEnds ? promoApr : promoEnds ? Math.max(apr, standardApr) : apr;
      const interest = Math.round((bal * rate) / 100 / 12);
      const extra = extras.filter((x) => monthKeyOf(x.date) === key || (k === 1 && monthKeyOf(x.date) <= key)).reduce((sum, x) => sum + x.cents, 0);
      bal = Math.max(0, bal + interest + monthlySpend - monthlyPayment - extra);
      if (k <= 12) interestNext12 += interest;
      months.push({ month: key, owed: bal, interest });
    }
    if (promoEnds && promoEnds < today) {
      warnings.push(`Promo ended ${promoEnds}: the balance now accrues at the standard rate.`);
    } else if (promoEnds && daysBetween(today, promoEnds) <= 365) {
      const atEnd = months.filter((m) => `${m.month}-01` <= promoEnds!).pop()?.owed ?? owed;
      if (atEnd > 0) {
        warnings.push(
          `Promo ends ${promoEnds}: about ${fmt(atEnd)} would still be owed then at the current payments, and it would start accruing about ${fmt((atEnd * standardApr) / 100 / 12)} a month.`,
        );
      }
    }
    out.push({
      account_key: acct.account_key,
      label: acct.label,
      owedNow: owed,
      aprPct: apr,
      aprSource,
      promoEnds,
      promoSource,
      monthlySpendCents: monthlySpend,
      monthlyPaymentCents: monthlyPayment,
      interestNext12Cents: interestNext12,
      promoAprPct: promoEnds ? promoApr : null,
      standardAprPct: standardApr,
      standardAprAssumed: typeof t?.standardAprPct !== "number",
      months,
      warnings,
    });
  }
  return out;
}

function projectNetWorth(
  input: ForecastInput,
  latest: Map<string, ForecastBalance>,
  cards: CardProjection[],
  days: DayPoint[],
  today: string,
  transfers: readonly { account_key: string; date: string; cents: number }[] = [],
): NetWorthMonth[] {
  const growth = new Map((input.growth ?? []).map((g) => [g.account_key, g]));
  const ledgerInv = input.accounts.filter((a) => isInvestmentType(a.account_type));
  const virtual = (input.growth ?? []).filter((g) => g.account_key.startsWith("virtual-") && !ledgerInv.some((a) => a.account_key === g.account_key));
  const investments = [...ledgerInv.map((a) => ({ account_key: a.account_key, label: a.label })), ...virtual.map((g) => ({ account_key: g.account_key, label: g.label ?? "Planned account" }))];
  const thisMonth = monthIndex(monthKeyOf(today));
  const out: NetWorthMonth[] = [];
  const invBal = new Map(investments.map((a) => [a.account_key, latest.get(a.account_key)?.balance_cents ?? growth.get(a.account_key)?.startCents ?? 0]));
  const monthsOut = Math.min(24, Math.max(12, Math.floor(days.length / 30.4)));
  for (let k = 1; k <= monthsOut; k++) {
    const key = monthFromIndex(thisMonth + k);
    const lastDay = addDays(`${monthFromIndex(thisMonth + k + 1)}-01`, -1);
    const cashDay = days.filter((d) => d.date <= lastDay).pop();
    let inv = 0;
    const byAccount: Record<string, number> = {};
    for (const a of investments) {
      const g = growth.get(a.account_key);
      const r = (g?.returnPct ?? FORECAST.defaultReturnPct) / 100;
      let b = (invBal.get(a.account_key) ?? 0) * Math.pow(1 + r, 1 / 12);
      if (g?.monthlyContributionCents && (!g.contributionStarts || `${key}-01` >= g.contributionStarts.slice(0, 7) + "-01")) b += g.monthlyContributionCents;
      for (const t of transfers) if (t.account_key === a.account_key && (monthKeyOf(t.date) === key || (k === 1 && monthKeyOf(t.date) < key))) b += t.cents;
      invBal.set(a.account_key, b);
      inv += b;
      byAccount[a.label] = Math.round(b);
    }
    const owed = cards.reduce((s, c) => s + (c.months[k - 1]?.owed ?? 0), 0);
    const cash = cashDay?.likely ?? 0;
    out.push({ month: key, cash, investments: Math.round(inv), cardsOwed: owed, netWorth: Math.round(cash + inv - owed), byAccount });
  }
  return out;
}

// ─── Backtest helpers (Section 9) ─────────────────────────────────────────────────────────────

/**
 * The pool's balance at the end of `target`, reconstructed backward from an anchor (the latest snapshot) by
 * undoing every pool transaction dated after `target` and up to the anchor date. Uses EVERY row, ignored ones
 * too: they moved cash even when the budget leaves them out.
 */
export function poolBalanceAt(poolTxns: readonly ForecastTxn[], anchorCents: number, anchorDate: string, target: string): number {
  let bal = anchorCents;
  for (const t of poolTxns) {
    if ((t.currency ?? "USD").toUpperCase() !== "USD") continue;
    if (t.txn_date > target && t.txn_date <= anchorDate) bal -= toBalanceDelta(t.amount_cents);
  }
  return bal;
}

export interface BacktestPoint {
  horizonDays: number;
  likely: number;
  low: number;
  high: number;
  actual: number;
  /** A month of the pool's gross outflows at the as-of date: errors are reported as a share of it. */
  scale: number;
}
export interface BacktestSummary {
  horizonDays: number;
  n: number;
  medianAbsErrorPct: number;
  meanErrorPct: number;
  belowLowPct: number;
  aboveHighPct: number;
}
export function summarizeBacktest(points: readonly BacktestPoint[]): BacktestSummary[] {
  const byH = new Map<number, BacktestPoint[]>();
  for (const p of points) {
    if (!(p.scale > 0)) continue;
    const list = byH.get(p.horizonDays);
    if (list) list.push(p);
    else byH.set(p.horizonDays, [p]);
  }
  return [...byH.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, list]) => {
      const err = list.map((p) => ((p.likely - p.actual) / p.scale) * 100);
      const pct = (n: number) => Math.round((n / list.length) * 1000) / 10;
      return {
        horizonDays: h,
        n: list.length,
        medianAbsErrorPct: Math.round(median(err.map(Math.abs)) * 10) / 10,
        meanErrorPct: Math.round(mean(err) * 10) / 10,
        belowLowPct: pct(list.filter((p) => p.actual < p.low).length),
        aboveHighPct: pct(list.filter((p) => p.actual > p.high).length),
      };
    });
}
