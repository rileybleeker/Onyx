// Model routing for the app's single-purpose model calls (OPS-MODEL-01, 2026-11-16).
//
// Every routed call keeps its BASELINE model and effort (the configuration in production before
// this file). A cheaper CANDIDATE runs only inside a bounded pilot that is switched on with
// environment variables, ends by itself on a fixed date, and sends at most half of the calls to
// the candidate. Rollback = remove ONYX_MODEL_PILOT (or let the end date pass): every call goes
// back to the baseline. Widening a candidate to all calls is a code change to BASELINE, made only
// after the pilot's observations meet PILOT_CRITERIA (docs/model-routing-pilot.md).
//
// No imports and no clock: the routes pass the time in. Only pilotFromEnv (reads process.env) and
// logPilotObservation (console) touch anything outside the function arguments.

export type RoutedTask = "delivery_estimate" | "playlist" | "supplement_photo";
export type Effort = "low" | "medium" | "high";

export interface ModelConfig {
  model: string;
  /** undefined = the API default (no output_config.effort sent). */
  effort?: Effort;
}

export interface ModelChoice extends ModelConfig {
  arm: "baseline" | "pilot";
}

export const ROUTED_TASKS: readonly RoutedTask[] = ["delivery_estimate", "playlist", "supplement_photo"];

/** Production configuration. Do not change without pilot evidence (see header). */
export const BASELINE: Record<RoutedTask, ModelConfig> = {
  delivery_estimate: { model: "claude-opus-5-5", effort: "low" },
  playlist: { model: "claude-sonnet-5-5" },
  supplement_photo: { model: "claude-sonnet-5-5" },
};

/** What the pilot tries instead. */
export const CANDIDATE: Record<RoutedTask, ModelConfig> = {
  delivery_estimate: { model: "claude-sonnet-5-5", effort: "low" },
  playlist: { model: "claude-sonnet-5-5", effort: "low" },
  supplement_photo: { model: "claude-sonnet-5-5", effort: "low" },
};

/**
 * Thresholds set before the pilot runs, per task. A candidate is widened only when it meets every
 * one against the baseline arm of the same pilot window, with at least `minCalls` calls per arm.
 *  - successRate: share of calls that produced an accepted result (estimates stored for the whole
 *    batch / a playlist created / a label parsed into the product shape); failures and the
 *    harvester's one-dish retries count against it.
 *  - p90LatencyMs: 90th percentile of the model call time (playlist: the whole tool loop).
 *  - maxCostRatio: candidate cost per accepted result / baseline cost per accepted result, from
 *    the logged token counts at the price list current when the pilot is evaluated.
 *  - fixture: the offline fixture check in tests/fixtures/model-routing-pilot.json.
 */
export const PILOT_CRITERIA: Record<
  RoutedTask,
  { minCalls: number; successRate: number; p90LatencyMs: number; maxCostRatio: number; fixture: string }
> = {
  delivery_estimate: {
    minCalls: 20,
    successRate: 0.98,
    p90LatencyMs: 45_000,
    maxCostRatio: 0.8,
    fixture: "at least 90% of fixture dishes inside their kcal band, every kind correct",
  },
  playlist: {
    minCalls: 10,
    successRate: 0.9,
    p90LatencyMs: 40_000,
    maxCostRatio: 0.9,
    fixture: "every fixture prompt creates a playlist within the iteration limit and honours the source pool",
  },
  supplement_photo: {
    minCalls: 10,
    successRate: 0.95,
    p90LatencyMs: 30_000,
    maxCostRatio: 0.9,
    fixture: "every fixture label's ingredients, amounts and units read exactly",
  },
};

/** Longest pilot accepted: an end date further out turns the pilot off rather than running long. */
export const PILOT_MAX_DAYS = 21;
/** Largest share of calls sent to the candidate. */
export const PILOT_MAX_SHARE = 0.5;

export interface PilotConfig {
  tasks: ReadonlySet<RoutedTask>;
  /** Exclusive end instant (start of the day after ONYX_MODEL_PILOT_UNTIL, UTC). */
  endsAt: number;
  share: number;
}

export interface PilotEnv {
  ONYX_MODEL_PILOT?: string;
  ONYX_MODEL_PILOT_UNTIL?: string;
  ONYX_MODEL_PILOT_SHARE?: string;
}

/**
 * The pilot from the environment, or null (= baseline everywhere). Null whenever anything is
 * missing or out of bounds: no task named, no valid end date, an end date already past or more
 * than PILOT_MAX_DAYS ahead.
 */
export function parsePilot(env: PilotEnv, nowMs: number): PilotConfig | null {
  const tasks = new Set<RoutedTask>();
  for (const raw of (env.ONYX_MODEL_PILOT ?? "").split(",")) {
    const t = raw.trim();
    if ((ROUTED_TASKS as readonly string[]).includes(t)) tasks.add(t as RoutedTask);
  }
  if (tasks.size === 0) return null;
  const until = (env.ONYX_MODEL_PILOT_UNTIL ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  const endsAt = Date.parse(`${until}T00:00:00Z`) + 86_400_000;
  if (!Number.isFinite(endsAt) || endsAt <= nowMs) return null;
  if (endsAt - nowMs > (PILOT_MAX_DAYS + 1) * 86_400_000) return null;
  const s = Number(env.ONYX_MODEL_PILOT_SHARE ?? "0.5");
  const share = Number.isFinite(s) ? Math.min(PILOT_MAX_SHARE, Math.max(0, s)) : 0;
  if (share <= 0) return null;
  return { tasks, endsAt, share };
}

/** FNV-1a, 32 bit, scaled to [0, 1): the same unit always lands in the same arm. */
export function unitPosition(task: RoutedTask, unitKey: string): number {
  let h = 0x811c9dc5;
  const s = `${task}|${unitKey}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

/** The model and effort for one call. `unitKey` identifies what is being worked on. */
export function chooseModel(task: RoutedTask, unitKey: string, pilot: PilotConfig | null, nowMs: number): ModelChoice {
  if (pilot && pilot.tasks.has(task) && nowMs < pilot.endsAt && unitPosition(task, unitKey) < pilot.share) {
    return { ...CANDIDATE[task], arm: "pilot" };
  }
  return { ...BASELINE[task], arm: "baseline" };
}

/** `output_config.effort` for a choice, or nothing when the API default applies. */
export function effortConfig(choice: ModelConfig): { effort: Effort } | Record<string, never> {
  return choice.effort ? { effort: choice.effort } : {};
}

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * One observation line for the pilot (counts only: never prompt, reply, dish, product or track
 * text). Returns null when no pilot covers the task, so nothing is logged outside a pilot.
 *
 * `calls` = model calls ATTEMPTED for the request (counted before each create), so a call that
 * threw before returning usage still counts; `usage` holds only the calls that answered. `ok` /
 * `accepted` describe the request's outcome after its result was stored, not the model reply.
 */
export function pilotObservation(
  task: RoutedTask,
  choice: ModelChoice,
  pilot: PilotConfig | null,
  o: { usage: UsageLike[]; latencyMs: number; ok: boolean; calls: number; units?: number; accepted?: number },
): Record<string, string | number | boolean> | null {
  if (!pilot || !pilot.tasks.has(task)) return null;
  const sum = (k: keyof UsageLike) => o.usage.reduce((a, u) => a + (Number(u?.[k]) || 0), 0);
  return {
    event: "model_pilot",
    task,
    arm: choice.arm,
    model: choice.model,
    effort: choice.effort ?? "default",
    ok: o.ok,
    calls: Math.max(0, Math.floor(o.calls)),
    answered: o.usage.length,
    units: o.units ?? 1,
    accepted: o.accepted ?? (o.ok ? 1 : 0),
    latency_ms: Math.max(0, Math.round(o.latencyMs)),
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_input_tokens"),
    cache_write_tokens: sum("cache_creation_input_tokens"),
  };
}

/** Pilot from process.env (server routes). */
export function pilotFromEnv(nowMs: number): PilotConfig | null {
  return parsePilot(
    {
      ONYX_MODEL_PILOT: process.env.ONYX_MODEL_PILOT,
      ONYX_MODEL_PILOT_UNTIL: process.env.ONYX_MODEL_PILOT_UNTIL,
      ONYX_MODEL_PILOT_SHARE: process.env.ONYX_MODEL_PILOT_SHARE,
    },
    nowMs,
  );
}

/** Log an observation line if the pilot covers the task. */
export function logPilotObservation(line: Record<string, string | number | boolean> | null): void {
  if (line) console.info(JSON.stringify(line));
}
