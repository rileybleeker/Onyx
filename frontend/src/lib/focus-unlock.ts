// Focus habit unlock (2026-11-13): which Onyx habits unlock the iPhone Focus block, and how they
// combine with the phone's unlock time. Storage: pds.focus_unlock_config (sql/focus_unlock_config.sql).
//
// Pure helpers only: no Supabase, no Next, no Node built-ins. Imported by PUT/GET /api/focus/config
// (owner session), GET /api/focus/unlock-status (the iPhone app, CI token), the /install settings card,
// and tests/focus-unlock.test.cjs. The Swift copy of shouldUnlock lives in
// tools/screentime_ios/FocusCore/Sources/FocusCore/OnyxHabits.swift; keep the two tables identical.

export type FocusUnlockRule = "or" | "and";

export const FOCUS_RULES: readonly FocusUnlockRule[] = ["or", "and"];

/** What each rule means, in the words shown on /install and in the iPhone app. */
export const FOCUS_RULE_TEXT: Record<FocusUnlockRule, { label: string; detail: string }> = {
  or: {
    label: "Habits OR time",
    detail: "Finishing the chosen habits unlocks early. The unlock time unlocks regardless.",
  },
  and: {
    label: "Habits AND time",
    detail: "Stays blocked after the unlock time until the chosen habits are done.",
  },
};

export const MAX_FOCUS_HABITS = 10;
export const MAX_FOCUS_CONFIG_BODY_BYTES = 1024;

/** A Notion page id as pds.habit_name_map stores it (lower-case dashed UUID). */
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FocusUnlockConfig {
  rule: FocusUnlockRule;
  /** Notion page ids of the chosen habits, in the order Riley picked them. */
  habitPageIds: string[];
}

/** No habits chosen, rule OR: the phone behaves exactly like the time-only Focus it had before. */
export const DEFAULT_FOCUS_CONFIG: FocusUnlockConfig = { rule: "or", habitPageIds: [] };

/**
 * The decision the phone makes. `true` = the blocked apps open.
 *
 *   configPresent     false when no habits are chosen in Onyx: the time alone decides.
 *   habitsDone        true / false from a status the phone trusts for today; null when it is unknown
 *                     (never fetched, fetched for another day, or the last fetch failed).
 *   nowPastUnlockTime the phone's own "Not before" time has passed today.
 *
 * Unknown always means time-only, under BOTH rules: a network failure can delay an early unlock, but it
 * can never keep apps blocked past the unlock time.
 */
export function shouldUnlock(
  rule: FocusUnlockRule,
  habitsDone: boolean | null,
  nowPastUnlockTime: boolean,
  configPresent: boolean
): boolean {
  if (!configPresent || habitsDone === null) return nowPastUnlockTime;
  return rule === "and" ? habitsDone && nowPastUnlockTime : habitsDone || nowPastUnlockTime;
}

/** A stored row (or nothing) to a config. Anything unexpected falls back to the default, piece by piece. */
export function configFromRow(row: unknown): FocusUnlockConfig {
  if (!row || typeof row !== "object") return { ...DEFAULT_FOCUS_CONFIG, habitPageIds: [] };
  const r = row as { rule?: unknown; habit_page_ids?: unknown };
  const rule: FocusUnlockRule = r.rule === "and" ? "and" : "or";
  const ids = Array.isArray(r.habit_page_ids) ? r.habit_page_ids.filter((v): v is string => typeof v === "string" && PAGE_ID.test(v)) : [];
  return { rule, habitPageIds: [...new Set(ids)].slice(0, MAX_FOCUS_HABITS) };
}

export type ConfigBodyResult = { ok: true; value: FocusUnlockConfig } | { ok: false; error: string };

/** Body of PUT /api/focus/config: exactly {rule: "or" | "and", habit_page_ids: string[]}. */
export function parseConfigBody(body: unknown): ConfigBodyResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "habit_page_ids" || keys[1] !== "rule") {
    return { ok: false, error: "body must be exactly {rule, habit_page_ids}" };
  }
  const { rule, habit_page_ids: ids } = body as { rule: unknown; habit_page_ids: unknown };
  if (rule !== "or" && rule !== "and") return { ok: false, error: 'rule must be "or" or "and"' };
  if (!Array.isArray(ids)) return { ok: false, error: "habit_page_ids must be a list" };
  if (ids.length > MAX_FOCUS_HABITS) return { ok: false, error: `choose at most ${MAX_FOCUS_HABITS} habits` };
  for (const id of ids) {
    if (typeof id !== "string" || !PAGE_ID.test(id)) return { ok: false, error: "habit_page_ids must be habit page ids" };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: "a habit is listed twice" };
  return { ok: true, value: { rule, habitPageIds: ids as string[] } };
}

type HeaderGetter = { get(name: string): string | null };

/**
 * Request-shape checks for the PUT, before the body is read (the route itself is session-only via
 * middleware): same origin (a browser always sends Origin on a PUT, so a missing one is refused), a JSON
 * content type, and a small declared size. Returns null when the request may proceed.
 */
export function checkConfigWrite(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
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
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };

  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };

  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_FOCUS_CONFIG_BODY_BYTES)) {
    return { status: 413, error: "body too large" };
  }
  return null;
}

/** What GET /api/focus/unlock-status answers. The phone gets these keys and nothing else. */
export interface FocusUnlockStatus {
  /** The Onyx behavioral day the done flags are for (pds.behavioral_today_now()). */
  behavioral_date: string;
  rule: FocusUnlockRule;
  /** false = no habits chosen in Onyx; the phone keeps its own rule. */
  config_present: boolean;
  habits: { name: string; done: boolean }[];
  /** Every chosen habit has answer 'Yes' for behavioral_date. Always false when none are chosen. */
  habits_done: boolean;
}

/**
 * Builds the answer for the phone. `names` maps a chosen page id to the habit's current name
 * (pds.habit_name_map); `yes` holds the habit names with an answer 'Yes' row for the day. A chosen id
 * the map no longer knows is left out: asking for a habit that cannot be ticked would block for good
 * under the AND rule.
 */
export function buildUnlockStatus(input: {
  behavioralDate: string;
  config: FocusUnlockConfig;
  names: ReadonlyMap<string, string>;
  yes: ReadonlySet<string>;
}): FocusUnlockStatus {
  const habits: { name: string; done: boolean }[] = [];
  for (const id of input.config.habitPageIds) {
    const name = input.names.get(id);
    if (!name) continue;
    habits.push({ name, done: input.yes.has(name) });
  }
  return {
    behavioral_date: input.behavioralDate,
    rule: input.config.rule,
    config_present: habits.length > 0,
    habits,
    habits_done: habits.length > 0 && habits.every((h) => h.done),
  };
}

/** One line for the settings card: what the phone would do with this status right now. */
export function describeStatus(status: FocusUnlockStatus): string {
  if (!status.config_present) return "No habits chosen: the phone unlocks at its unlock time, as before.";
  const left = status.habits.filter((h) => !h.done).length;
  if (status.rule === "or") {
    return left === 0
      ? "All chosen habits are done: the phone unlocks the next time it checks."
      : `${left} still to do: the phone unlocks when they are done, or at its unlock time.`;
  }
  return left === 0
    ? "All chosen habits are done: the phone unlocks at its unlock time."
    : `${left} still to do: the phone stays blocked after its unlock time until they are done.`;
}
