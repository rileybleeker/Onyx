/**
 * Reading question bank: the ONE model call helper (READ-QUIZ-01; docs/reading-question-bank.md "Models and calls").
 *
 * Every bank call (map, research, build structure + verify, highlights, grade) goes through bankModelCall():
 * - client.beta.messages.stream(...).finalMessage(), with the server-side refusal fallback
 *   (betas: server-side-fallback-2026-07-01, fallbacks: "default");
 * - effort always explicit (output_config.effort); `thinking` is never sent (both models think adaptively, and
 *   disabling it is a 400 on Opus 5.5 / Sonnet 5.5);
 * - the system prompt is the stable prefix, with cache_control on its (last) block;
 * - stop_reason is read before the content: refusal -> code `refusal`, max_tokens -> `max_tokens`, pause_turn ->
 *   continued (the answer so far sent back) up to 3 times;
 * - cost from usage (input, output, cache read / write, web searches) with PRICES; a turn a server-side fallback
 *   served (a `fallback` content block, a `fallback_message` in usage.iterations, or another model named) is priced
 *   with the dearer of the requested and the serving model (UNKNOWN_PRICE for a model this table lacks), over
 *   usage.iterations, which also counts the declined attempt;
 * - ONE deadline for the whole call (every continuation and every SDK retry): the step's STEP_MAX_SECONDS unless
 *   timeoutMs says otherwise, and never past deadlineAt (the STEP's absolute deadline, shared by a step's two calls:
 *   stepDeadlineAt), enforced with an abort signal, so a call cannot outlive the worker's budget (an unbounded call
 *   is what lets a lease run out after a billed request);
 * - money is checked before EVERY request, the first included: requestBoundCents is a conservative bound on what
 *   the request can cost (its whole output at UNKNOWN_PRICE, its prompt at the cache-write rate, every allowed web
 *   search and fetch at full size); the request is sent only when the job's spend so far (priorCostCents + this
 *   call's) plus that bound can be reserved: with `reserve` (the worker) only after the database raised the job's
 *   reservation to that total atomically (pds.reading_bank_reserve, which counts every other running job live and
 *   pauses the book at its cap, so two jobs at once cannot spend the same headroom and a book that is out of money
 *   is paused instead of failing quietly); without `reserve`, only when the total stays within maxCostCents (the
 *   claim's headroom_cents), which is NOT consulted when `reserve` is given, because the claim's number is older
 *   than the database's and a local refusal never reaches the pause. A continuation re-sends everything so far, so
 *   its bound is at least what the previous turn cost. Otherwise: `cost_limit`, nothing sent;
 * - a failure that may have been billed without a usage report (timeout, connection, abort) says so
 *   (maybeBilled), so the worker charges the job's reservation instead of 0;
 * - errors leave as codes only: no prompt, book text or API message is ever returned or logged.
 *
 * SDK note: the installed @anthropic-ai/sdk (0.80) types the web_*_20260209 tools but not `fallbacks`, so the
 * request is built here as plain data and passed through a client typed by this module (BankClient). That one
 * local widening is the only place the extra field crosses the SDK's types. 0.80's stream accumulator takes the
 * message's `model` from message_start, which names the requested model when a fallback took over mid-stream;
 * servedModel() reads the `fallback` block instead, and the pricing above stays on the dear side either way.
 */

import Anthropic from "@anthropic-ai/sdk";
import { BLOCKED_DOMAINS, STEP_MAX_SECONDS, type BankStep, type ContentBlockLike } from "./reading-bank";

export const BANK_OPUS = "claude-opus-5-5";
export const BANK_SONNET = "claude-sonnet-5-5";
export type BankModel = typeof BANK_OPUS | typeof BANK_SONNET;
export type BankEffort = "low" | "medium" | "high";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_CONTINUATIONS = 3;
/** The deadline of a call that names no step and no timeoutMs (the longest step's budget). */
export const DEFAULT_CALL_MS = Math.max(...Object.values(STEP_MAX_SECONDS)) * 1000;
/** A continuation is sent only with at least this much of the deadline left. */
export const MIN_TURN_MS = 5000;

/* ------------------------------------------------------------------ */
/* Prices and cost                                                      */
/* ------------------------------------------------------------------ */

/** Dollars per million tokens. Cache writes (5-minute) are priced at 1.25 x input. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const PRICES: Record<string, Price> = {
  [BANK_OPUS]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  [BANK_SONNET]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
/** A model this table does not know (a server-side fallback answered): priced high, so the caps stay safe. */
export const UNKNOWN_PRICE: Price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
/** Web search: $10 per 1,000 searches = 1 cent each. Web fetch costs only the tokens it adds. */
export const WEB_SEARCH_CENTS = 1;

/** One sampling attempt in usage.iterations ('message', or 'fallback_message' for an attempt a fallback model ran). */
export interface IterationUsageLike {
  type?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
  /** Per attempt; top-level usage covers only the attempt that produced the message (declined ones are listed here). */
  iterations?: IterationUsageLike[] | null;
}
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
  calls: number;
}
export const ZERO_USAGE: Readonly<UsageTotals> = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  web_search_requests: 0,
  web_fetch_requests: 0,
  calls: 0,
});

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

/**
 * The tokens one response was billed for: per field, the larger of the top-level usage and the sum over
 * usage.iterations (which, with a server-side fallback, also lists the declined attempt).
 */
export function billedTokens(u: UsageLike | null | undefined): Record<TokenField, number> {
  const its = Array.isArray(u?.iterations) ? u.iterations : [];
  const out = {} as Record<TokenField, number>;
  for (const f of TOKEN_FIELDS) out[f] = Math.max(num(u?.[f]), its.reduce((s, it) => s + num(it?.[f]), 0));
  return out;
}

export function addUsage(t: UsageTotals, u: UsageLike | null | undefined): UsageTotals {
  const b = billedTokens(u);
  return {
    input_tokens: t.input_tokens + b.input_tokens,
    output_tokens: t.output_tokens + b.output_tokens,
    cache_read_input_tokens: t.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: t.cache_creation_input_tokens + b.cache_creation_input_tokens,
    web_search_requests: t.web_search_requests + num(u?.server_tool_use?.web_search_requests),
    web_fetch_requests: t.web_fetch_requests + num(u?.server_tool_use?.web_fetch_requests),
    calls: t.calls + 1,
  };
}

/** A model's price, UNKNOWN_PRICE when the table lacks it. */
export const priceOf = (model: string | null | undefined): Price => (model && PRICES[model]) || UNKNOWN_PRICE;
/** The dearer of two prices, field by field. */
export const dearer = (a: Price, b: Price): Price => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});

function centsAt(p: Price, usage: UsageLike | UsageTotals | null | undefined): number {
  const u = usage as UsageLike & Partial<UsageTotals>;
  const b = billedTokens(u);
  const tokens = b.input_tokens * p.input + b.output_tokens * p.output + b.cache_read_input_tokens * p.cacheRead + b.cache_creation_input_tokens * p.cacheWrite;
  const searches = num(u?.server_tool_use?.web_search_requests) + num((u as Partial<UsageTotals>)?.web_search_requests);
  const cents = (tokens / 1_000_000) * 100 + searches * WEB_SEARCH_CENTS;
  return Math.round(cents * 100) / 100;
}

/** Cents for one response's usage on `model` (two decimals, the ledger's precision). */
export function costCents(model: string | null | undefined, usage: UsageLike | UsageTotals | null | undefined): number {
  return centsAt(priceOf(model), usage);
}

/** The model that served a response: the last `fallback` block's target, else the message's model, else the requested. */
export function servedModel(requested: string, msg: Pick<BankMessage, "model" | "content"> | null | undefined): string {
  let to: string | null = null;
  for (const b of msg?.content ?? []) {
    const t = (b as { type?: string; to?: { model?: unknown } }).type === "fallback" ? (b as { to?: { model?: unknown } }).to?.model : null;
    if (typeof t === "string" && t) to = t;
  }
  return to ?? (typeof msg?.model === "string" && msg.model ? msg.model : requested);
}

/** Whether a server-side fallback ran in this response (a fallback block, a fallback attempt, or another model). */
export function fellBack(requested: string, msg: Pick<BankMessage, "model" | "content" | "usage"> | null | undefined): boolean {
  if ((msg?.content ?? []).some((b) => b.type === "fallback")) return true;
  if ((msg?.usage?.iterations ?? []).some((it) => it?.type === "fallback_message")) return true;
  return servedModel(requested, msg) !== requested;
}

/**
 * Cents for one response of a call that asked for `requested`. Normally the serving model's price; when a fallback
 * ran, the dearer of the requested and the serving model's prices (a declined partial bills at the first, the
 * rescue at the second), over every attempt in usage.iterations: never below what was billed, as far as the
 * response tells.
 */
export function turnCostCents(requested: string, msg: Pick<BankMessage, "model" | "content" | "usage">): number {
  const served = servedModel(requested, msg);
  if (!fellBack(requested, msg)) return costCents(served, msg.usage);
  const p = served === requested ? dearer(priceOf(requested), UNKNOWN_PRICE) : dearer(priceOf(requested), priceOf(served));
  return centsAt(p, msg.usage);
}

/** Search-result tokens a bound assumes per allowed web search (fetches use their max_content_tokens). */
export const BOUND_SEARCH_TOKENS = 8000;
/** Characters per token a bound assumes for the prompt (English runs about 4; JSON and odd text fewer). */
export const BOUND_CHARS_PER_TOKEN = 2.5;

/**
 * A conservative bound, in cents, on what one request can cost: its whole max_tokens of output and its prompt
 * (system + messages + schema + tools, at BOUND_CHARS_PER_TOKEN, at the cache-write rate) at the dearer of the
 * requested model's price and UNKNOWN_PRICE (a server-side fallback may serve it), plus every allowed web search
 * (1 cent and BOUND_SEARCH_TOKENS of results each) and fetch (its max_content_tokens) as input once. It does not
 * multiply for the server tool loop re-reading earlier results or for a refusal mid-stream followed by a fallback
 * answer, which can each cost more; the ledger charges the real usage at finish either way.
 */
export function requestBoundCents(spec: Pick<BankCallSpec, "model" | "system" | "maxTokens" | "tools" | "schema">, messages: unknown[]): number {
  const p = dearer(priceOf(spec.model), UNKNOWN_PRICE);
  const chars = String(spec.system ?? "").length + JSON.stringify(messages ?? []).length
    + (spec.schema ? JSON.stringify(spec.schema).length : 0) + (spec.tools?.length ? JSON.stringify(spec.tools).length : 0);
  const prompt = Math.ceil(chars / BOUND_CHARS_PER_TOKEN);
  let toolTokens = 0;
  let searches = 0;
  for (const t of spec.tools ?? []) {
    const uses = Math.max(0, Math.trunc(t.max_uses) || 0);
    if (t.type === "web_search_20260209") {
      searches += uses;
      toolTokens += uses * BOUND_SEARCH_TOKENS;
    } else if (t.type === "web_fetch_20260209") {
      toolTokens += uses * Math.max(0, Math.trunc(t.max_content_tokens) || 0);
    }
  }
  const out = Math.max(0, Math.trunc(spec.maxTokens) || 0);
  const cents = ((prompt * p.cacheWrite + toolTokens * p.input + out * p.output) / 1_000_000) * 100 + searches * WEB_SEARCH_CENTS;
  return Math.ceil(cents * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

/**
 * `allowed_callers: ["direct"]` on BOTH tools is load-bearing. The `_20260209` versions default to
 * `["code_execution_20260120"]` (dynamic filtering): the model then runs its searches and fetches from a code
 * execution container and reads only what its code prints, so the results never reach it as search / document
 * blocks and its final text carries NO citations. The bank's evidence is exactly those API citations (citedNotes),
 * so without this pin every map / research answer reads as uncited and is stored as `no_sources` (seen on
 * 2026-11-17: 6 searches, 1 text block, 0 sources). "direct" makes the model call the tools itself, which is what
 * produces the `web_search_result_location` / document citations. It also leaves the code execution container (and
 * the ZDR exclusion that comes with dynamic filtering) out of the request.
 */
export interface WebSearchTool {
  type: "web_search_20260209";
  name: "web_search";
  max_uses: number;
  blocked_domains: string[];
  allowed_callers: ["direct"];
}
export interface WebFetchTool {
  type: "web_fetch_20260209";
  name: "web_fetch";
  max_uses: number;
  blocked_domains: string[];
  citations: { enabled: true };
  max_content_tokens: number;
  allowed_callers: ["direct"];
}
export type BankTool = WebSearchTool | WebFetchTool;

export const webSearchTool = (maxUses: number): WebSearchTool => ({
  type: "web_search_20260209",
  name: "web_search",
  max_uses: Math.max(1, Math.trunc(maxUses)),
  blocked_domains: [...BLOCKED_DOMAINS].slice(0, 64),
  allowed_callers: ["direct"],
});
export const webFetchTool = (maxUses: number, maxContentTokens = 12000): WebFetchTool => ({
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: Math.max(1, Math.trunc(maxUses)),
  blocked_domains: [...BLOCKED_DOMAINS].slice(0, 64),
  citations: { enabled: true },
  max_content_tokens: maxContentTokens,
  allowed_callers: ["direct"],
});

/* ------------------------------------------------------------------ */
/* The client this module needs (the SDK's beta stream, structurally)    */
/* ------------------------------------------------------------------ */

export interface BankMessage {
  model?: string | null;
  stop_reason: string | null;
  content: ContentBlockLike[];
  usage?: UsageLike | null;
}
export interface BankStream {
  finalMessage(): Promise<unknown>;
}
export interface BankRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}
export interface BankClient {
  beta: { messages: { stream(params: Record<string, unknown>, options?: BankRequestOptions): BankStream } };
}

/** The SDK client (or a fake) as a BankClient: the one typed widening for the fields 0.80 does not know. */
export function asBankClient(client: { beta: { messages: { stream: (...args: never[]) => unknown } } }): BankClient {
  return client as unknown as BankClient;
}

/** A real client: the SDK retries 429 / 5xx / connection errors twice by itself. */
export function defaultBankClient(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): BankClient {
  return asBankClient(new Anthropic({ apiKey, maxRetries: 2 }));
}

/* ------------------------------------------------------------------ */
/* The call                                                             */
/* ------------------------------------------------------------------ */

export interface BankCallSpec {
  model: BankModel;
  effort: BankEffort;
  /** Stable prefix (cached). Generic: no book details in it; those go in `user`. */
  system: string;
  /** The user turn (book details, evidence JSON inside tags, the answer to grade). */
  user: string;
  maxTokens: number;
  tools?: BankTool[];
  /** JSON schema for output_config.format (not combinable with citations, so never with the web tools). */
  schema?: Record<string, unknown>;
  /** The step: its STEP_MAX_SECONDS is the call's deadline unless timeoutMs is given. */
  step?: BankStep;
  /** The whole call's deadline in ms (every continuation and SDK retry inside it). */
  timeoutMs?: number;
  /**
   * The step's absolute deadline (epoch ms; stepDeadlineAt): the call ends by it whatever timeoutMs / step say. A step
   * that makes two calls (map, build, highlights) passes the same value to both, so the pair stays within
   * STEP_MAX_SECONDS and the worker's own deadline instead of each call taking the full budget.
   */
  deadlineAt?: number;
  maxContinuations?: number;
  /**
   * The most the JOB may have spent in all once a request is done (the claim's headroom_cents, which includes the
   * job's reservation): a request whose bound (requestBoundCents) could pass it is not sent (`cost_limit`). Used only
   * by a caller with no `reserve`; with `reserve` the database decides (and pauses the book at its cap).
   */
  maxCostCents?: number;
  /** What the job spent on earlier calls (a build's structure call, before its verify call). Default 0. */
  priorCostCents?: number;
  /**
   * Called before every request with the job's total if this request cost its whole bound (priorCostCents + this
   * call so far + bound): the worker raises the job's reservation to it with pds.reading_bank_reserve and answers
   * whether that succeeded. false (or a throw) = `cost_limit`, nothing sent.
   */
  reserve?: (totalCents: number) => Promise<boolean>;
}

export type BankCallCode =
  | "refusal"
  | "max_tokens"
  | "bad_output"
  | "pause_limit"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "connection"
  | "timeout"
  | "auth"
  | "bad_request"
  | "web_search_disabled"
  | "cost_limit"
  | "failed";

/** Codes worth another try later (the worker's retry ladder); the rest fail the job. */
export const RETRYABLE_CODES = new Set<BankCallCode>(["max_tokens", "bad_output", "pause_limit", "rate_limited", "overloaded", "server_error", "connection", "timeout", "cost_limit"]);
/** Failures after which a request may have been billed with no usage reported (the worker charges the reservation). */
export const MAYBE_BILLED_CODES = new Set<BankCallCode>(["timeout", "connection", "failed"]);

export type BankCallResult =
  | { ok: true; content: ContentBlockLike[]; text: string; json: unknown; model: string; continuations: number; usage: UsageTotals; costCents: number }
  | { ok: false; code: BankCallCode; retryable: boolean; usage: UsageTotals; costCents: number; maybeBilled: boolean };

/**
 * The time a call may take in ms: timeoutMs, else the step's STEP_MAX_SECONDS, else DEFAULT_CALL_MS; never past
 * deadlineAt (0 when that has passed).
 */
export function callDeadlineMs(spec: Pick<BankCallSpec, "timeoutMs" | "step" | "deadlineAt">, now = Date.now()): number {
  let ms = DEFAULT_CALL_MS;
  if (typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) ms = Math.trunc(spec.timeoutMs);
  else if (spec.step && STEP_MAX_SECONDS[spec.step]) ms = STEP_MAX_SECONDS[spec.step] * 1000;
  if (typeof spec.deadlineAt === "number" && Number.isFinite(spec.deadlineAt)) ms = Math.min(ms, Math.trunc(spec.deadlineAt - now));
  return Math.max(0, ms);
}

/** A step's absolute deadline (epoch ms), for every call it makes: its start + STEP_MAX_SECONDS. */
export const stepDeadlineAt = (step: BankStep, startedAt = Date.now()) => startedAt + (STEP_MAX_SECONDS[step] ?? 0) * 1000;

/** The request body (plain data; see the SDK note at the top). */
export function bankParams(spec: BankCallSpec, messages: unknown[]): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: spec.model,
    max_tokens: spec.maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: [{ type: "text", text: spec.system, cache_control: { type: "ephemeral" } }],
    messages,
    output_config: spec.schema ? { effort: spec.effort, format: { type: "json_schema", schema: spec.schema } } : { effort: spec.effort },
  };
  if (spec.tools?.length) params.tools = spec.tools;
  return params;
}

/** An SDK error as a code (status and class name only; the message is read for one classification, never kept). */
export function classifyError(err: unknown): { code: BankCallCode; retryable: boolean } {
  const e = (err ?? {}) as { status?: unknown; name?: unknown; constructor?: { name?: string }; message?: unknown };
  const status = typeof e.status === "number" ? e.status : null;
  const name = `${typeof e.name === "string" ? e.name : ""} ${e.constructor?.name ?? ""}`;
  const mentionsWeb = typeof e.message === "string" && /web[ _-]?(search|fetch)/i.test(e.message) && /(enabl|not (allowed|permitted|available))/i.test(e.message);
  const out = (code: BankCallCode) => ({ code, retryable: RETRYABLE_CODES.has(code) });
  if (/Timeout|Abort/i.test(name) || status === 408) return out("timeout");
  if (/Connection/i.test(name) && status === null) return out("connection");
  if (status === 429) return out("rate_limited");
  if (status === 529) return out("overloaded");
  if (status !== null && status >= 500) return out("server_error");
  if ((status === 400 || status === 403) && mentionsWeb) return out("web_search_disabled");
  if (status === 401 || status === 403) return out("auth");
  if (status !== null && status >= 400) return out("bad_request");
  return out("failed");
}

const asMessage = (raw: unknown): BankMessage | null => {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as BankMessage;
  return Array.isArray(m.content) ? m : null;
};

/** The text of an answer's text blocks, in order. */
export const messageText = (content: ContentBlockLike[]) =>
  content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");

/**
 * One bank call, with pause_turn continued, stop reasons checked first, and the cost of every response counted.
 * The whole call (continuations and the SDK's own retries) ends by one deadline (callDeadlineMs); no request is sent
 * with less than MIN_TURN_MS left. Before EVERY request (the first included) the job's possible total, priorCostCents
 * + this call so far + max(requestBoundCents, the last turn's cost: a continuation re-sends everything so far), must
 * be reserved through `reserve` when it is given, else fit maxCostCents; otherwise `cost_limit` and nothing is sent.
 */
export async function bankModelCall(client: BankClient, spec: BankCallSpec): Promise<BankCallResult> {
  const max = spec.maxContinuations ?? MAX_CONTINUATIONS;
  const budgetMs = callDeadlineMs(spec);
  const deadline = Date.now() + budgetMs;
  const cap = typeof spec.maxCostCents === "number" && Number.isFinite(spec.maxCostCents) ? Math.max(0, spec.maxCostCents) : null;
  const prior = typeof spec.priorCostCents === "number" && Number.isFinite(spec.priorCostCents) ? Math.max(0, spec.priorCostCents) : 0;
  let usage: UsageTotals = { ...ZERO_USAGE };
  let cost = 0;
  let lastTurnCost = 0;
  const content: ContentBlockLike[] = [];
  let served = spec.model as string;
  const cents = () => Math.round(cost * 100) / 100;
  const fail = (code: BankCallCode, retryable = RETRYABLE_CODES.has(code), maybeBilled = false): BankCallResult => ({
    ok: false, code, retryable, usage, costCents: cents(), maybeBilled,
  });
  if (budgetMs < MIN_TURN_MS) return fail("timeout");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budgetMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    for (let turn = 0; turn <= max; turn++) {
      if (turn > 0 && deadline - Date.now() < MIN_TURN_MS) return fail("timeout");
      const messages: unknown[] = [{ role: "user", content: spec.user }];
      if (content.length) messages.push({ role: "assistant", content: [...content] });
      const total = Math.round((prior + cost + Math.max(requestBoundCents(spec, messages), lastTurnCost)) * 100) / 100;
      if (!spec.reserve && cap !== null && total > cap) return fail("cost_limit");
      if (spec.reserve) {
        let reserved = false;
        try {
          reserved = (await spec.reserve(total)) === true;
        } catch {
          reserved = false;
        }
        if (!reserved) return fail("cost_limit");
        if (deadline - Date.now() < MIN_TURN_MS) return fail("timeout");
      }
      let msg: BankMessage | null;
      try {
        // The abort timer ends the call at the deadline in any case; this keeps the SDK's own timeout within it.
        const timeout = turn === 0 && !spec.reserve ? budgetMs : Math.max(1, deadline - Date.now());
        msg = asMessage(await client.beta.messages.stream(bankParams(spec, messages), { timeout, signal: abort.signal }).finalMessage());
      } catch (err) {
        const c = abort.signal.aborted ? { code: "timeout" as BankCallCode, retryable: true } : classifyError(err);
        return fail(c.code, c.retryable, MAYBE_BILLED_CODES.has(c.code));
      }
      if (!msg) return fail("bad_output", true);
      served = servedModel(spec.model, msg);
      usage = addUsage(usage, msg.usage);
      lastTurnCost = turnCostCents(spec.model, msg);
      cost += lastTurnCost;
      if (msg.stop_reason === "refusal") return fail("refusal", false);
      if (msg.stop_reason === "max_tokens") return fail("max_tokens", true);
      content.push(...msg.content);
      if (msg.stop_reason === "pause_turn") {
        if (turn === max) return fail("pause_limit", true);
        continue;
      }
      if (msg.stop_reason !== "end_turn") return fail("bad_output", true);
      const text = messageText(content);
      let json: unknown = null;
      if (spec.schema) {
        try {
          json = JSON.parse(text);
        } catch {
          return fail("bad_output", true);
        }
        if (!json || typeof json !== "object") return fail("bad_output", true);
      }
      return { ok: true, content, text, json, model: served, continuations: turn, usage, costCents: cents() };
    }
    return fail("pause_limit", true);
  } finally {
    clearTimeout(timer);
  }
}
