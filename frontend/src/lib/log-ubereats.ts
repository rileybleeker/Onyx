// The /log Uber Eats section (app/log/sections/UberEats.tsx): its cache keys, the behavioral-today guess, the
// "Uber Eats checked N min ago" line, and how a Say it draft (lib/log-drafts.ts UberEatsLogDraft[]) maps onto the
// dishes on screen. Pure: no React, no Supabase (AppData imports the keys at startup).

import { PORTION_OPTIONS, shiftYmd } from "./delivery-portion";
import { LEFTOVER_OPTIONS, LEFTOVER_WINDOW_DAYS, isClock } from "./delivery-leftovers";
import type { UberEatsLogDraft } from "./log-drafts";

/** pds.behavioral_today_now() as {behavioral_today}. */
export const BEHAVIORAL_TODAY_URL = "/api/behavioral-today";
/** Newest ubereats|items heartbeat (when the PC harvester last read the order history). */
export const UBER_EATS_CHECK_KEY = "delivery:ubereats-check";
/** Same rule as /check-in: the day's dishes plus the 2 days before still unanswered. */
export const LOG_EARLIER_DAYS = 2;
/** The harvester runs every 10 min; two missed runs = the PC is probably off or asleep. */
export const CHECK_STALE_MIN = 25;

/** Every day the dish window of `date` reads: `date` back to the earliest of the asked days and the leftover window. */
export function deliveryWindowDays(date: string, earlierDays: number): string[] {
  const span = Math.max(earlierDays, LEFTOVER_WINDOW_DAYS);
  return Array.from({ length: span + 1 }, (_, i) => shiftYmd(date, -i));
}

/** Client-cache key of one dish window. Under "delivery:", so every Uber Eats write drops it. */
export function deliveryWindowKey(date: string, earlierDays: number): string {
  return `delivery:window:${date}|${earlierDays}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The day in an /api/behavioral-today answer, or null. */
export function behavioralTodayOf(raw: unknown): string | null {
  const b = (raw as { behavioral_today?: unknown } | null | undefined)?.behavioral_today;
  return typeof b === "string" && YMD.test(b) ? b : null;
}

/** A cached server answer is trusted for the first paint only this long (it may be from yesterday). */
export const TODAY_CACHE_TRUST_MS = 20 * 60_000;

/** Behavioral today without the server: the Eastern clock minus 6 h (travel time zones are the server's job). */
export function behavioralTodayGuess(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now - 6 * 3_600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The day to paint first: a recent cached server answer (it knows about travel), else the Eastern-clock guess. */
export function initialBehavioralToday(cached: unknown, fetchedAt: number | undefined, now: number = Date.now()): string {
  if (fetchedAt !== undefined && now - fetchedAt <= TODAY_CACHE_TRUST_MS) {
    const t = behavioralTodayOf(cached);
    if (t) return t;
  }
  return behavioralTodayGuess(now);
}

// ─── "Uber Eats checked N min ago" ────────────────────────────────────────────

export interface UberEatsCheck {
  /** sync_start of the newest ubereats|items heartbeat, or null when there is none. */
  at: string | null;
  status: string | null;
}

export function isUberEatsCheck(v: unknown): v is UberEatsCheck {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (o.at === null || typeof o.at === "string") && (o.status === null || typeof o.status === "string");
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export type CheckTone = "ok" | "stale" | "failed";

/** The line under the section heading, so Riley knows whether a just-delivered order can be in yet. */
export function uberEatsCheckLine(check: UberEatsCheck, now: number): { text: string; tone: CheckTone } {
  if (!check.at) return { text: "Uber Eats has not been checked yet.", tone: "stale" };
  const age = Math.max(0, now - new Date(check.at).getTime());
  if (!Number.isFinite(age)) return { text: "Uber Eats has not been checked yet.", tone: "stale" };
  if (check.status === "failed") return { text: `The last Uber Eats check failed (${ago(age)}). New orders may be missing.`, tone: "failed" };
  if (age > CHECK_STALE_MIN * 60_000) {
    return { text: `Uber Eats checked ${ago(age)}. The PC looks off or asleep, so a new order may not be here yet.`, tone: "stale" };
  }
  return { text: `Uber Eats checked ${ago(age)}.`, tone: "ok" };
}

// ─── Say it drafts ────────────────────────────────────────────────────────────

/**
 * Where one draft entry stands against the screen:
 *   here      on screen now (highlighted); Save stores it
 *   after     a leftover whose question appears once this draft's portion for the same dish is saved; Save stores both
 *   other-day on another day of the switch (`day`)
 *   unknown   not one of the dishes of these days, nothing left to eat, or not a valid answer
 *   done      already stored like that
 *   tapped    Riley answered it himself since the section loaded: the suggestion is dropped
 */
export type SuggestionStatus = "here" | "after" | "other-day" | "unknown" | "done" | "tapped";

export type UberEatsSuggestion =
  | { kind: "portion"; item_id: number; title: string | null; day: string | null; status: SuggestionStatus; fraction: number }
  | {
      kind: "leftover";
      item_id: number;
      title: string | null;
      day: string;
      status: SuggestionStatus;
      /** LEFTOVER_OPTIONS key (a share of what is left). */
      option: string;
      /** "HH:MM", only with an amount. */
      time: string | null;
    };

export interface SuggestionDish {
  item_id: number;
  title: string;
  behavioral_date: string;
  eaten_fraction: number | null;
}

export interface SuggestionQuestion {
  item_id: number;
  option: string | null;
  time: string | null;
  left: number;
}

/** Keys of the taps Riley made since the section loaded (a suggestion never overrides them). */
export const portionTapKey = (itemId: number) => `p:${itemId}`;
export const leftoverTapKey = (itemId: number, date: string) => `l:${itemId}|${date}`;

const PORTION_VALUES = new Set(PORTION_OPTIONS.map((o) => o.value));
const AMOUNT_KEYS = new Set(LEFTOVER_OPTIONS.filter((o) => o.share != null && o.share > 0).map((o) => o.key));
const ANSWER_KEYS = new Set(LEFTOVER_OPTIONS.map((o) => o.key));

export function classifySuggestions(input: {
  entries: ReadonlyArray<UberEatsLogDraft>;
  /** The day on screen. */
  date: string;
  /** The days the switch offers. */
  tabs: ReadonlyArray<string>;
  /** Every dish loaded for `date` (the window). */
  dishes: ReadonlyArray<SuggestionDish>;
  /** Dishes with a portion control on screen. */
  shownIds: ReadonlySet<number>;
  /** Dishes seen in other days' windows this visit (title + delivery day), to point at their day. */
  known?: ReadonlyMap<number, { title: string; day: string }>;
  /** The leftover questions of `date`. */
  questions: ReadonlyArray<SuggestionQuestion>;
  touched: ReadonlySet<string>;
}): UberEatsSuggestion[] {
  const { entries, date, tabs, dishes, shownIds, questions, touched } = input;
  const known = input.known ?? new Map<number, { title: string; day: string }>();
  const byId = new Map(dishes.map((d) => [d.item_id, d]));
  const portions: UberEatsSuggestion[] = [];
  const out: UberEatsSuggestion[] = [];
  for (const e of entries) {
    if (!e || e.kind !== "portion") continue;
    const id = Number(e.item_id);
    const dish = byId.get(id) ?? null;
    const seen = known.get(id) ?? null;
    let status: SuggestionStatus;
    let day: string | null = dish?.behavioral_date ?? seen?.day ?? null;
    if (!Number.isInteger(id) || !PORTION_VALUES.has(e.fraction)) status = "unknown";
    else if (touched.has(portionTapKey(id))) status = "tapped";
    else if (!dish) status = seen && seen.day !== date && tabs.includes(seen.day) ? "other-day" : "unknown";
    else if (dish.eaten_fraction === e.fraction) status = "done";
    else if (shownIds.has(id)) status = "here";
    else if (dish.behavioral_date !== date && tabs.includes(dish.behavioral_date)) status = "other-day";
    else status = "unknown";
    if (status === "unknown") day = null;
    const s: UberEatsSuggestion = { kind: "portion", item_id: id, title: dish?.title ?? seen?.title ?? null, day, status, fraction: e.fraction };
    portions.push(s);
    out.push(s);
  }
  for (const e of entries) {
    if (!e || e.kind !== "leftover") continue;
    const id = Number(e.item_id);
    const dish = byId.get(id) ?? null;
    const amount = AMOUNT_KEYS.has(e.answer);
    const time = amount && isClock(e.time) ? e.time : null;
    const base = { kind: "leftover" as const, item_id: id, title: dish?.title ?? known.get(id)?.title ?? null, day: e.date, option: e.answer, time };
    let status: SuggestionStatus;
    if (!Number.isInteger(id) || !ANSWER_KEYS.has(e.answer) || typeof e.date !== "string" || !YMD.test(e.date)) status = "unknown";
    else if (touched.has(leftoverTapKey(id, e.date))) status = "tapped";
    else if (e.date !== date) status = tabs.includes(e.date) ? "other-day" : "unknown";
    else {
      const q = questions.find((x) => x.item_id === id);
      if (q) {
        if (q.option === e.answer && (time == null || q.time === time)) status = "done";
        else if (amount && q.left <= 0) status = "unknown";
        else status = "here";
      } else {
        // The question appears once the delivery-day portion is below All: this draft may set it.
        const p = portions.find((x) => x.item_id === id && x.status === "here");
        const inWindow = dish != null && dish.behavioral_date < date && dish.behavioral_date >= shiftYmd(date, -LEFTOVER_WINDOW_DAYS);
        status = p && p.kind === "portion" && p.fraction < 1 && inWindow ? "after" : "unknown";
      }
    }
    out.push({ ...base, status });
  }
  return out;
}

/** "All" / "3/4" … for a portion or leftover answer. */
export function portionLabel(fraction: number): string {
  return PORTION_OPTIONS.find((o) => o.value === fraction)?.label ?? String(fraction);
}

export function leftoverLabel(option: string): string {
  return LEFTOVER_OPTIONS.find((o) => o.key === option)?.label ?? option;
}
