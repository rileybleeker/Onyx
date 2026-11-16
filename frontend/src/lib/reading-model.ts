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
 * - cost from usage (input, output, cache read / write, web searches) with PRICES;
 * - ONE deadline for the whole call (every continuation and every SDK retry): the step's STEP_MAX_SECONDS unless
 *   timeoutMs says otherwise, enforced with an abort signal, so a call cannot outlive the worker's budget (an
 *   unbounded call is what lets a lease run out after a billed request);
 * - maxCostCents: a continuation is not sent once the next turn could pass it (the claim's headroom_cents);
 * - a failure that may have been billed without a usage report (timeout, connection, abort) says so
 *   (maybeBilled), so the worker charges the job's reservation instead of 0;
 * - errors leave as codes only: no prompt, book text or API message is ever returned or logged.
 *
 * SDK note: the installed @anthropic-ai/sdk (0.80) types the web_*_20260209 tools but not `fallbacks`, so the
 * request is built here as plain data and passed through a client typed by this module (BankClient). That one
 * local widening is the only place the extra field crosses the SDK's types.
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

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
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

export function addUsage(t: UsageTotals, u: UsageLike | null | undefined): UsageTotals {
  return {
    input_tokens: t.input_tokens + num(u?.input_tokens),
    output_tokens: t.output_tokens + num(u?.output_tokens),
    cache_read_input_tokens: t.cache_read_input_tokens + num(u?.cache_read_input_tokens),
    cache_creation_input_tokens: t.cache_creation_input_tokens + num(u?.cache_creation_input_tokens),
    web_search_requests: t.web_search_requests + num(u?.server_tool_use?.web_search_requests),
    web_fetch_requests: t.web_fetch_requests + num(u?.server_tool_use?.web_fetch_requests),
    calls: t.calls + 1,
  };
}

/** Cents for one response's usage on `model` (two decimals, the ledger's precision). */
export function costCents(model: string | null | undefined, usage: UsageLike | UsageTotals | null | undefined): number {
  const p = (model && PRICES[model]) || UNKNOWN_PRICE;
  const u = usage as UsageLike & Partial<UsageTotals>;
  const tokens =
    num(u?.input_tokens) * p.input +
    num(u?.output_tokens) * p.output +
    num(u?.cache_read_input_tokens) * p.cacheRead +
    num(u?.cache_creation_input_tokens) * p.cacheWrite;
  const searches = num(u?.server_tool_use?.web_search_requests) + num((u as Partial<UsageTotals>)?.web_search_requests);
  const cents = (tokens / 1_000_000) * 100 + searches * WEB_SEARCH_CENTS;
  return Math.round(cents * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

export interface WebSearchTool {
  type: "web_search_20260209";
  name: "web_search";
  max_uses: number;
  blocked_domains: string[];
}
export interface WebFetchTool {
  type: "web_fetch_20260209";
  name: "web_fetch";
  max_uses: number;
  blocked_domains: string[];
  citations: { enabled: true };
  max_content_tokens: number;
}
export type BankTool = WebSearchTool | WebFetchTool;

export const webSearchTool = (maxUses: number): WebSearchTool => ({
  type: "web_search_20260209",
  name: "web_search",
  max_uses: Math.max(1, Math.trunc(maxUses)),
  blocked_domains: [...BLOCKED_DOMAINS].slice(0, 64),
});
export const webFetchTool = (maxUses: number, maxContentTokens = 12000): WebFetchTool => ({
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: Math.max(1, Math.trunc(maxUses)),
  blocked_domains: [...BLOCKED_DOMAINS].slice(0, 64),
  citations: { enabled: true },
  max_content_tokens: maxContentTokens,
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
  maxContinuations?: number;
  /** The most the call may cost in all (the claim's headroom_cents): no continuation that could pass it. */
  maxCostCents?: number;
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

/** The deadline of a call in ms: timeoutMs, else the step's STEP_MAX_SECONDS, else DEFAULT_CALL_MS. */
export function callDeadlineMs(spec: Pick<BankCallSpec, "timeoutMs" | "step">): number {
  if (typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) return Math.trunc(spec.timeoutMs);
  if (spec.step && STEP_MAX_SECONDS[spec.step]) return STEP_MAX_SECONDS[spec.step] * 1000;
  return DEFAULT_CALL_MS;
}

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
 * The whole call (continuations and the SDK's own retries) ends by one deadline (callDeadlineMs); a continuation is
 * not sent when less than MIN_TURN_MS is left or when the next turn could pass maxCostCents (it re-sends everything
 * so far, so it is assumed to cost at least what the last turn did).
 */
export async function bankModelCall(client: BankClient, spec: BankCallSpec): Promise<BankCallResult> {
  const max = spec.maxContinuations ?? MAX_CONTINUATIONS;
  const budgetMs = callDeadlineMs(spec);
  const deadline = Date.now() + budgetMs;
  const cap = typeof spec.maxCostCents === "number" && Number.isFinite(spec.maxCostCents) ? Math.max(0, spec.maxCostCents) : null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budgetMs);
  (timer as { unref?: () => void }).unref?.();
  let usage: UsageTotals = { ...ZERO_USAGE };
  let cost = 0;
  let lastTurnCost = 0;
  const content: ContentBlockLike[] = [];
  let served = spec.model as string;
  const cents = () => Math.round(cost * 100) / 100;
  const fail = (code: BankCallCode, retryable = RETRYABLE_CODES.has(code), maybeBilled = false): BankCallResult => ({
    ok: false, code, retryable, usage, costCents: cents(), maybeBilled,
  });
  try {
    for (let turn = 0; turn <= max; turn++) {
      if (turn > 0) {
        if (deadline - Date.now() < MIN_TURN_MS) return fail("timeout");
        if (cap !== null && cost + lastTurnCost > cap) return fail("cost_limit");
      }
      const messages: unknown[] = [{ role: "user", content: spec.user }];
      if (content.length) messages.push({ role: "assistant", content: [...content] });
      let msg: BankMessage | null;
      try {
        const timeout = turn === 0 ? budgetMs : Math.max(1, deadline - Date.now());
        msg = asMessage(await client.beta.messages.stream(bankParams(spec, messages), { timeout, signal: abort.signal }).finalMessage());
      } catch (err) {
        const c = abort.signal.aborted ? { code: "timeout" as BankCallCode, retryable: true } : classifyError(err);
        return fail(c.code, c.retryable, MAYBE_BILLED_CODES.has(c.code));
      }
      if (!msg) return fail("bad_output", true);
      served = typeof msg.model === "string" && msg.model ? msg.model : spec.model;
      usage = addUsage(usage, msg.usage);
      lastTurnCost = costCents(served, msg.usage);
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
