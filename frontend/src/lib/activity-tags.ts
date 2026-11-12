// Shared vocabulary and helpers for the /activities strength tags.
//
// Single source of truth for the tag sets used by the page (pill rows, category
// badge) and by the tag-suggestion route (/api/activities/suggest-tags). Must stay
// in sync with the DB CHECK constraints (sql/activity_muscle_groups.sql) and the
// allow-sets in /api/activities/categorize — tests/activity-tag-suggest.test.cjs
// fails if any of the three drifts.
//
// Pure module: no React, no Next, no network.

export const SPLIT_LABELS = ["leg", "pull", "push"] as const;
export const MUSCLE_GROUPS = [
  "chest", "back", "shoulders", "biceps", "triceps", "forearms",
  "quads", "hamstrings", "glutes", "calves", "core",
] as const;
export type SplitLabel = (typeof SPLIT_LABELS)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

export type ActivityCategory = "run" | "sauna" | "strength" | "other";

export type SuggestionConfidence = "high" | "medium" | "low";
export const SUGGESTION_CONFIDENCES: readonly SuggestionConfidence[] = ["high", "medium", "low"];

/** Only sessions this recent are ever suggested for. */
export const SUGGEST_WINDOW_DAYS = 30;
/** Hard cap on activities per suggest-tags call (also the most one model call can carry). */
export const SUGGEST_MAX_ITEMS = 10;
/** Newest already-tagged sessions shown to the model as examples. */
export const SUGGEST_EXAMPLE_LIMIT = 15;

/**
 * Category of an activity from its device sport label / name. The ONE copy of this
 * rule: the page's badge and the suggestion route's "is this a strength session?"
 * check both call it, so they cannot disagree. Order matters (sauna, then run,
 * then strength), exactly as the page has always evaluated it.
 */
export function deriveActivityCategory(type: string, name: string, isSauna: boolean): ActivityCategory {
  const hay = `${type} ${name}`.toLowerCase();
  // isSauna is the manual override (set on a WHOOP session the device didn't label
  // 'sauna'); honoring it keeps the category consistent with the toggle.
  if (isSauna || hay.includes("sauna")) return "sauna";
  if (hay.includes("run")) return "run";
  if (/weightlift|strength|lifting|resistance/.test(hay)) return "strength";
  return "other";
}

/**
 * Keep only the canonical values of a model- or client-supplied tag list:
 * lower-cased, de-duplicated, order preserved, everything else (unknown strings,
 * non-strings) dropped. Returns null when the input is not an array at all, so the
 * caller can tell "malformed" from "nothing valid left".
 */
export function keepCanonical<T extends string>(input: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(input)) return null;
  const out: T[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase() as T;
    if (allowed.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export type ActivitySource = "garmin" | "whoop";

export interface ActivityTarget {
  source: ActivitySource;
  id: string;
}

/**
 * Validate one { source, id } pair from a request body. Garmin ids are bigints
 * (digits only, so a bad value never reaches PostgREST's bigint cast); WHOOP ids
 * are opaque UUID-like text. Returns null when the pair is not acceptable.
 */
export function parseActivityTarget(raw: unknown): ActivityTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const { source, id } = raw as { source?: unknown; id?: unknown };
  if (source !== "garmin" && source !== "whoop") return null;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const text = String(id).trim();
  if (source === "garmin") return /^\d{1,19}$/.test(text) ? { source, id: text } : null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? { source, id: text } : null;
}
