// Model routing for the app's single-purpose model calls (OPS-MODEL-01, 2026-11-16).
//
// Every routed call keeps its BASELINE model and effort (the configuration in production before
// this file). A cheaper CANDIDATE runs only inside a bounded pilot that is switched on with
// environment variables, ends by itself on a fixed date, and sends at most half of the calls to
// the candidate. Rollback = remove ONYX_MODEL_PILOT (or let the end date pass): every call goes
// back to the baseline. Widening a candidate to all calls is a code change to BASELINE, made only
// after the pilot's observations meet PILOT_CRITERIA (docs/model-routing-pilot.md).
//
// No imports and no clock: the routes pass the time in. Only pilotFromEnv (reads process.env),
// logPilotObservation (console), routeDeadline (AbortSignal.timeout) and the default wait and
// clock in callWithCountedRetries (setTimeout, Date.now) touch anything outside the arguments.

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
 *    the logged token counts at the price list current when the pilot is evaluated. Only valid
 *    when every attempt of both arms reported usage (pilotCostEvidence(...).complete); otherwise
 *    the cost of the unpriced attempts is unknown, never zero, and the cost check cannot pass
 *    until the window is reconciled with Anthropic's own usage report for the same models.
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
 * `calls` = provider attempts for the request (counted before each attempt, retries included, with
 * the SDK's own retries switched off), so an attempt that threw before returning usage still
 * counts; `usage` holds only the attempts that answered. `unpriced` = attempts with no usage: the
 * provider may still have billed them, so their cost is UNKNOWN, not zero (see pilotCostEvidence).
 * `ok` / `accepted` describe the request's outcome after its result was stored, not the model reply.
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
    unpriced: Math.max(0, Math.floor(o.calls) - o.usage.length),
    units: o.units ?? 1,
    accepted: o.accepted ?? (o.ok ? 1 : 0),
    latency_ms: Math.max(0, Math.round(o.latencyMs)),
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_input_tokens"),
    cache_write_tokens: sum("cache_creation_input_tokens"),
  };
}

/**
 * Whether one arm's logged token counts cover every provider attempt. Cost per accepted result
 * may be computed from the logs only when `complete` is true for BOTH arms; with any unpriced
 * attempt the cost criterion stays unmet until the window is reconciled with the provider's usage
 * report (docs/model-routing-pilot.md, "Evaluating").
 */
export function pilotCostEvidence(lines: ReadonlyArray<{ calls?: unknown; answered?: unknown }>): {
  attempts: number;
  answered: number;
  unpriced: number;
  complete: boolean;
} {
  let attempts = 0;
  let answered = 0;
  for (const l of lines) {
    const c = Number(l?.calls);
    const a = Number(l?.answered);
    // A line without valid counts cannot be priced: count it as one unpriced attempt.
    if (!Number.isFinite(c) || !Number.isFinite(a) || c < 0 || a < 0) {
      attempts += 1;
      continue;
    }
    attempts += Math.max(c, a);
    answered += a;
  }
  const unpriced = attempts - answered;
  return { attempts, answered, unpriced, complete: unpriced === 0 };
}

/** Retries a route makes itself (SDK retries off), the same number the SDK would make by default. */
export const MODEL_CALL_RETRIES = 2;
/** Deadline for one playlist model call (the SDK default is 10 minutes, so a hung call would never be observed). */
export const PLAYLIST_CALL_TIMEOUT_MS = 60_000;
/**
 * Whole playlist request (tool loop and retry waits). The route sets no `maxDuration`, so this
 * stays under the platform's default function limit; past it, no retry is started.
 */
export const PLAYLIST_REQUEST_BUDGET_MS = 280_000;

/** HTTP statuses the SDK itself retries (request timeout, conflict, rate limit, server errors). */
export function isRetryableStatus(status: unknown): boolean {
  return typeof status === "number" && (status === 408 || status === 409 || status === 429 || status >= 500);
}

interface HeadersLike {
  get(name: string): string | null | undefined;
}

function errorHeaders(e: unknown): HeadersLike | null {
  const h = (e as { headers?: unknown } | null)?.headers;
  return h && typeof (h as HeadersLike).get === "function" ? (h as HeadersLike) : null;
}

/**
 * The SDK's own retry rule for a failed call: a connection error (as `isConnectionError` says;
 * the routes pass the SDK's class) is retried; otherwise the provider's `x-should-retry` header
 * decides when present, else the status (isRetryableStatus). A call aborted by the route's own
 * deadline or by a disconnect is neither, so it is not retried.
 */
export function isRetryableModelError(e: unknown, isConnectionError: (e: unknown) => boolean): boolean {
  if (isConnectionError(e)) return true;
  const header = errorHeaders(e)?.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return isRetryableStatus((e as { status?: unknown } | null)?.status);
}

/**
 * The wait the provider asked for before a retry, as the SDK reads it: `retry-after-ms`, else
 * `retry-after` in seconds or as an HTTP date. Null when the error carries no usable header.
 */
export function retryAfterMs(e: unknown, nowMs: number): number | null {
  const h = errorHeaders(e);
  if (!h) return null;
  const ms = parseFloat(h.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = h.get("retry-after");
  if (!raw) return null;
  const seconds = parseFloat(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** Shortest time worth starting one more attempt with before a deadline. */
export const MIN_ATTEMPT_MS = 1_000;

/**
 * Run one model call with bounded retries done HERE, so every provider attempt is counted
 * (`onAttempt` fires before each one). The call must be made with the SDK's `maxRetries: 0`; a
 * retry happens only when `isRetryable` says so, after the wait the provider asked for
 * (`retryAfterMs`, e.g. a 429's Retry-After) or else a short exponential wait. With `deadlineMs`
 * a retry is started only when that wait plus MIN_ATTEMPT_MS still ends before the deadline;
 * otherwise, when the retries run out, when the error is not retryable or when `signal` was
 * aborted meanwhile, the last error is thrown. An already aborted `signal` starts no attempt.
 */
export async function callWithCountedRetries<T>(
  call: () => Promise<T>,
  o: {
    retries: number;
    isRetryable: (e: unknown) => boolean;
    onAttempt: () => void;
    retryAfterMs?: (e: unknown) => number | null;
    deadlineMs?: number;
    signal?: AbortSignal;
    now?: () => number;
    waitMs?: (retry: number) => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const retries = Math.max(0, Math.floor(o.retries));
  const waitMs = o.waitMs ?? ((r: number) => Math.min(8_000, 500 * 2 ** r));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? (() => Date.now());
  if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
  for (let attempt = 0; ; attempt++) {
    o.onAttempt();
    try {
      return await call();
    } catch (e) {
      if (attempt >= retries || !o.isRetryable(e)) throw e;
      const asked = o.retryAfterMs?.(e);
      const wait = asked != null && Number.isFinite(asked) && asked >= 0 ? asked : waitMs(attempt);
      if (o.deadlineMs !== undefined && now() + wait + MIN_ATTEMPT_MS > o.deadlineMs) throw e;
      await sleep(wait);
      if (o.signal?.aborted) throw e;
    }
  }
}

/** Function limit of the routes that call a model (their `maxDuration`), and the part of it kept for the rest of the request. */
export const FUNCTION_BUDGET_MS = 60_000;
export const FUNCTION_RESERVE_MS = 6_000;
/** Part of the request deadline kept after the model call for storing its result. */
export const MODEL_WRITE_RESERVE_MS = 4_000;

/**
 * Absolute deadlines for a request with a FUNCTION_BUDGET_MS limit, counted from the handler's
 * entry (`startMs`), so time spent on database reads before the model call is inside the budget.
 *  - `at` / `signal`: the whole request's work (reads, model call, writes) ends by then; pass
 *    `signal` to every database query (`.abortSignal(signal)`).
 *  - `modelAt` / `modelSignal`: the model call (all attempts, retry waits and reading the
 *    response body) ends by then, leaving MODEL_WRITE_RESERVE_MS for storing its result. The SDK's
 *    `timeout` stops only at the response headers, so the call also gets `modelSignal`, which
 *    aborts the body read as well.
 * Ending inside the budget lets the request write its own terminal observation instead of being
 * killed with none.
 */
export interface RouteDeadline {
  at: number;
  modelAt: number;
  signal: AbortSignal;
  modelSignal: AbortSignal;
}

export function routeDeadline(startMs: number, nowMs: number): RouteDeadline {
  const at = startMs + FUNCTION_BUDGET_MS - FUNCTION_RESERVE_MS;
  const modelAt = at - MODEL_WRITE_RESERVE_MS;
  return {
    at,
    modelAt,
    signal: AbortSignal.timeout(Math.max(0, at - nowMs)),
    modelSignal: AbortSignal.timeout(Math.max(0, modelAt - nowMs)),
  };
}

/** SDK `timeout` for one attempt that must end by `deadlineMs` (never zero or negative). */
export function attemptTimeoutMs(deadlineMs: number, nowMs: number): number {
  return Math.max(MIN_ATTEMPT_MS, deadlineMs - nowMs);
}

export type Arm = ModelChoice["arm"];

/**
 * Which dishes one estimate call takes. A call uses one model, so a batch holds only dishes of one
 * arm. `rows` is the unestimated queue from its start (at least `from + n` rows when it has that
 * many). Without `only`, the batch is the arm of the dish at `from` plus the later dishes of that
 * arm in the window, and `armOffset` = how many dishes of that arm sit before `from`. With `only`
 * (a retry after that arm's batch failed), `from` counts within that arm's dishes only, so a retry
 * never calls the model for the other arm. Null = nothing at this offset.
 */
export function selectEstimateBatch<T>(
  rows: readonly T[],
  from: number,
  n: number,
  armOf: (row: T) => Arm,
  only?: Arm,
): { todo: T[]; arm: Arm; armOffset: number } | null {
  if (only) {
    const todo = rows.filter((r) => armOf(r) === only).slice(from, from + n);
    return todo.length ? { todo, arm: only, armOffset: from } : null;
  }
  const queue = rows.slice(from);
  if (queue.length === 0) return null;
  const arm = armOf(queue[0]);
  return {
    todo: queue.filter((r) => armOf(r) === arm),
    arm,
    armOffset: rows.slice(0, from).filter((r) => armOf(r) === arm).length,
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
