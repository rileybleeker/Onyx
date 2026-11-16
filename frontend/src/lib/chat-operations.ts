/**
 * Replay-safe chat writes (SEC-04, sql/chat_operations.sql).
 *
 * /chat sends one request_id per user message and the SAME id when Riley retries that message unchanged after a
 * lost or failed answer. Each write-tool call of a request becomes one row in pds.chat_operations (its canonical
 * input, a status, the result the model got and the receipt Riley saw). On a retry the model is run again and its
 * write calls are matched to the stored rows BY CONTENT (same tool, same canonical input), in any order:
 *
 *   - a call that matches a stored row is answered from it: done = the stored result and receipt, nothing written;
 *     refused (nothing was written) = run again; pending / unknown (the try stopped mid-way) = run again only when
 *     the write itself is keyed by the operation id or naturally idempotent (RERUN_SAFE), otherwise looked up
 *     read-only (reconcilers) and never created again;
 *   - a call that matches nothing is refused while any write of an earlier try is still unmatched (it may be the
 *     same thing asked differently: a stack logged as single products, another wording); it is refused again if
 *     the model repeats it; an extra copy of a call already answered from a stored row is refused too;
 *   - only once every earlier write is matched does a new call run (the earlier try stopped before reaching it).
 *
 * The operation id is passed into the write (supplement event key, reading client_key, playlist audit key), so a
 * write that happened before the ledger could record it is found again rather than repeated. The behavioral day the
 * operation first ran on is stored with it (`context`) and a re-run uses that day, so a retry after midnight / 06:00
 * never moves an omitted "today" to the next day.
 *
 * Known gaps (follow-ups): a playlist that exists on Spotify but never reached pds.spotify_playlists stays "unknown"
 * (no read-only Spotify lookup yet); a reading session or highlight replay does not redo the Notion mirror, habit
 * stamp or book finish the first try never reached (lib/reading.ts); a quiz result has no operation key and is
 * matched by book, checkpoint, score and time; a highlight re-run resolves "the book being read" again; the ledger
 * keeps tool inputs and results with no retention window yet.
 *
 * Errors are reported by code only (never a message, which can echo user text). No personal data in this file.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WriteReceipt } from "@/lib/chat-receipts";

export type OperationStatus = "pending" | "done" | "refused" | "unknown";

export interface OperationKey {
  owner_id: string;
  request_id: string;
  tool: string;
  ordinal: number;
}

/** What the call depended on when it first ran, reused by a re-run (e.g. behavioral_today). Plain JSON. */
export type OperationContext = Record<string, unknown>;

export interface OperationRow extends OperationKey {
  op_id: string;
  intent_sha: string;
  intent: unknown;
  status: OperationStatus;
  result: unknown;
  receipt: WriteReceipt | null;
  context: OperationContext | null;
  created_at: string;
}

export type RequestClaim = "new" | "retry" | "conflict";

/** Storage behind the ledger (Supabase in production, an in-memory map in the tests). Methods throw Ledger* errors. */
export interface LedgerStore {
  /** "new" = first time this id is seen; "retry" = seen with the same conversation; "conflict" = seen with another one. */
  claimRequest(owner_id: string, request_id: string, conversation_sha: string): Promise<RequestClaim>;
  /** Insert a pending row for this call, or return the row already in that place (created = false). Atomic. */
  claim(key: OperationKey, intent_sha: string, intent: unknown, context?: OperationContext | null): Promise<{ row: OperationRow; created: boolean }>;
  listForRequest(owner_id: string, request_id: string): Promise<OperationRow[]>;
  /** Take a REFUSED row back to pending (same call, run again); null when it is no longer refused (another try took it). */
  reclaim(row: OperationRow): Promise<OperationRow | null>;
  /** Record the outcome; false when the row had already moved on (a concurrent try finished it). */
  finish(row: OperationRow, status: OperationStatus, result: unknown, receipt: WriteReceipt | null): Promise<boolean>;
}

/** The ledger tables are not there yet (the SQL file is not applied): the route runs as before. */
export class LedgerUnavailable extends Error {
  code: string;
  constructor(code: string) {
    super("chat operation ledger unavailable");
    this.name = "LedgerUnavailable";
    this.code = code;
  }
}

/** Any other ledger failure: the write is refused rather than run without a record. */
export class LedgerFailure extends Error {
  code: string;
  constructor(code: string) {
    super("chat operation ledger failed");
    this.name = "LedgerFailure";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Canonical form and hashes                                           */
/* ------------------------------------------------------------------ */

/** JSON with sorted keys and undefined fields left out, so the same input always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null || typeof value === "function" || typeof value === "symbol") return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const intentSha = (tool: string, input: unknown): string => sha256Hex(`${tool}\n${canonicalJson(input)}`);

/** Hash of the whole conversation as sent (role + text only): a retry sends exactly the same messages. */
export const conversationSha = (messages: ReadonlyArray<{ role: string; content: string }>): string =>
  sha256Hex(canonicalJson(messages.map(({ role, content }) => ({ role, content }))));

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write tools whose write cannot happen twice when re-run with the same operation id: a habit answer is an upsert on
 * (day, question), a highlight is unique on (book, passage), and a supplement intake, a stack log and a reading
 * session carry the operation id as their own key. Any other write tool (quiz result, Spotify playlist, and every
 * future write tool until it is added here) is never re-run by a retry.
 */
export const RERUN_SAFE: ReadonlySet<string> = new Set([
  "mark_habit_complete",
  "log_supplement_intake",
  "log_supplement_stack",
  "log_reading_session",
  "add_book_highlight",
]);

export const REPLAY_NOTE =
  "An earlier try of this same message already did this, so nothing was written again. Tell the user it was already saved, using this result.";
export const REPLAY_DETAIL = "Saved by an earlier try of this message, not written again.";
export const EARLIER_DETAIL = "Saved by an earlier try of this message.";
export const CONFLICT_ERROR =
  "An earlier try of this same message already did this with different details, so nothing new was written. To log something different, the user should send it as a new message.";
export const REPEAT_ERROR =
  "An earlier try of this same message did this once and that was already reported in this answer, so nothing more was written. To do it again, the user should send it as a new message.";
export const LEDGER_ERROR =
  "Onyx could not record this action safely, so it was not done and nothing was written. Tell the user to try again in a moment.";
const UNCERTAIN: Record<string, string> = {
  create_spotify_playlist:
    "An earlier try of this message started this playlist and Onyx cannot confirm Spotify made it. Nothing was created now. Check Spotify; if it is not there, ask again in a new message.",
  record_reading_quiz:
    "An earlier try of this message started recording this quiz result and Onyx cannot confirm it. Nothing was recorded now. Check /reading before asking again in a new message.",
};
const UNCERTAIN_DEFAULT =
  "An earlier try of this message started this and Onyx cannot confirm it finished. Nothing was written now. Check the relevant page before asking again in a new message.";
export const uncertainText = (tool: string): string => UNCERTAIN[tool] ?? UNCERTAIN_DEFAULT;

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

export interface ToolOutcome {
  /** The JSON string the tool returned (what the model gets). */
  result: string;
  /** The tool threw (it may have written part of its work). */
  failed: boolean;
}

export interface LedgerOutcome extends ToolOutcome {
  receipt: WriteReceipt | null;
  /** The stored result of an earlier try was returned; nothing ran now. */
  replayed: boolean;
}

export type ReceiptBuilder = (tool: string, input: unknown, result: string) => WriteReceipt | null;
/** Read-only lookup of what a pending / unknown call left behind; the success result to store, or null. */
export type Reconciler = (row: OperationRow) => Promise<Record<string, unknown> | null>;

export interface LedgerOptions {
  store: LedgerStore;
  ownerId: string;
  requestId: string;
  /** This request id was seen before (a retry). */
  retry: boolean;
  buildReceipt: ReceiptBuilder;
  reconcilers?: Partial<Record<string, Reconciler>>;
  /** Stage + error code only. */
  onError?: (stage: string, code: string) => void;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseResult(result: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(result));
  } catch {
    return null;
  }
}

const withDetail = (receipt: WriteReceipt, line: string): WriteReceipt => ({ ...receipt, details: [...receipt.details, line] });

/** done = the tool confirmed the write; refused = a clean error, nothing written; unknown = it threw or says it may be incomplete. */
export function classifyOutcome(outcome: ToolOutcome): OperationStatus {
  if (outcome.failed) return "unknown";
  const r = parseResult(outcome.result);
  if (!r) return "unknown";
  if (r.success === true) return "done";
  if (r.incomplete === true) return "unknown";
  return "refused";
}

/**
 * What is kept of a result that wrote nothing (or may have): the error line and the incomplete flag only. A refusal
 * can carry long lists (every active product, every stack) that the ledger has no use for; it never replays them.
 */
export function storedResult(status: OperationStatus, parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  if (status === "done" || !parsed) return parsed;
  return {
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    ...(parsed.incomplete === true ? { incomplete: true } : {}),
  };
}

function errorCode(e: unknown): string {
  if (e instanceof LedgerFailure || e instanceof LedgerUnavailable) return e.code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : typeof e;
}

export type Execute = (opId: string, context: OperationContext) => Promise<ToolOutcome>;

export class ChatLedger {
  readonly retry: boolean;
  private readonly opts: LedgerOptions;
  /** First try: the n-th call of each tool, the place its row takes. */
  private readonly ordinals = new Map<string, number>();
  /** Rows this try has already matched to one of its calls, so one stored call answers one call of this try. */
  private readonly used = new Set<string>();
  /** Calls (by intent hash) this retry refused as a possible change of an earlier write: refused again if repeated. */
  private readonly conflicted = new Set<string>();

  constructor(opts: LedgerOptions) {
    this.opts = opts;
    this.retry = opts.retry;
  }

  private report(stage: string, e: unknown) {
    this.opts.onError?.(stage, errorCode(e));
  }

  /**
   * Run one write-tool call through the ledger. `execute` gets the operation id to pass into the write as its key and
   * the context the operation first ran with (`context` for a new one); it must not throw (the route turns a throw
   * into an "incomplete" result), but a throw is still treated as unknown here.
   */
  async run(tool: string, input: unknown, execute: Execute, context: OperationContext = {}): Promise<LedgerOutcome> {
    const canonical = canonicalJson(input ?? {});
    const intent: unknown = JSON.parse(canonical);
    const sha = sha256Hex(`${tool}\n${canonical}`);
    return this.retry
      ? this.runRetry(tool, input, sha, intent, execute, context)
      : this.runFirst(tool, input, sha, intent, execute, context);
  }

  /** A first try: every call takes the next place of its tool. */
  private async runFirst(
    tool: string, input: unknown, sha: string, intent: unknown, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    const ordinal = (this.ordinals.get(tool) ?? 0) + 1;
    this.ordinals.set(tool, ordinal);
    return this.claimAndRun(tool, input, sha, intent, ordinal, execute, context);
  }

  /** A retry: match the call to a stored row by content; a call that matches nothing runs only past every earlier write. */
  private async runRetry(
    tool: string, input: unknown, sha: string, intent: unknown, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    let rows: OperationRow[];
    try {
      rows = await this.opts.store.listForRequest(this.opts.ownerId, this.opts.requestId);
    } catch (e) {
      this.report("list", e);
      return this.refuse(tool, input);
    }
    const same = rows
      .filter((r) => r.tool === tool && r.intent_sha === sha && !this.used.has(r.op_id))
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (same) return this.resume(same, tool, input, execute);
    // One more copy of a call already answered from a stored row: the earlier try made it fewer times.
    if (rows.some((r) => r.tool === tool && r.intent_sha === sha)) return this.conflict(tool, input, null, REPEAT_ERROR);
    // The model asks again for a change this retry already refused.
    if (this.conflicted.has(sha)) return this.conflict(tool, input, null);
    // An earlier write not matched yet may be this same thing asked differently: refuse rather than risk a second one.
    const outstanding = rows.filter((r) => !this.used.has(r.op_id) && r.status !== "refused");
    if (outstanding.length > 0) {
      this.conflicted.add(sha);
      return this.conflict(tool, input, outstanding.find((r) => r.tool === tool) ?? outstanding[0]);
    }
    // Every write the earlier tries made is accounted for: this call goes past where they stopped.
    const ordinal = rows.filter((r) => r.tool === tool).reduce((n, r) => Math.max(n, r.ordinal), 0) + 1;
    return this.claimAndRun(tool, input, sha, intent, ordinal, execute, context);
  }

  private async claimAndRun(
    tool: string, input: unknown, sha: string, intent: unknown, ordinal: number, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    const key: OperationKey = { owner_id: this.opts.ownerId, request_id: this.opts.requestId, tool, ordinal };
    let claimed: { row: OperationRow; created: boolean };
    try {
      claimed = await this.opts.store.claim(key, sha, intent, context);
    } catch (e) {
      this.report("claim", e);
      return this.refuse(tool, input);
    }
    if (claimed.created) return this.execute(claimed.row, tool, input, execute, context);
    // Another try of this message took the place at the same moment: the same call joins it, anything else is refused.
    const row = claimed.row;
    if (row.intent_sha === sha && !this.used.has(row.op_id)) return this.resume(row, tool, input, execute);
    this.conflicted.add(sha);
    return this.conflict(tool, input, row);
  }

  /**
   * Receipts of calls an earlier try made that this try did not repeat (the model answered differently this time, or
   * asked for something else), so Riley still sees what was already saved. Empty on a first try.
   */
  async earlierReceipts(): Promise<WriteReceipt[]> {
    if (!this.retry) return [];
    let rows: OperationRow[];
    try {
      rows = await this.opts.store.listForRequest(this.opts.ownerId, this.opts.requestId);
    } catch (e) {
      this.report("list", e);
      return [];
    }
    const out: WriteReceipt[] = [];
    for (const row of rows) {
      if (this.used.has(row.op_id) || row.status === "refused") continue;
      if (row.status === "done") {
        const receipt = row.receipt ?? this.opts.buildReceipt(row.tool, row.intent, JSON.stringify(asObject(row.result) ?? {}));
        if (receipt) out.push(withDetail(receipt, EARLIER_DETAIL));
      } else {
        const receipt = this.opts.buildReceipt(row.tool, row.intent, JSON.stringify({ error: uncertainText(row.tool), incomplete: true }));
        if (receipt) out.push(receipt);
      }
    }
    return out;
  }

  /** A stored row matched by content. */
  private async resume(row: OperationRow, tool: string, input: unknown, execute: Execute): Promise<LedgerOutcome> {
    this.used.add(row.op_id);
    const context = asObject(row.context) ?? {};
    if (row.status === "done") return this.replay(row, tool);
    if (row.status === "refused") return this.reclaimAndRun(row, tool, input, execute, context);
    // pending (a try still running, or one that stopped mid-way) or unknown (one that failed part-way).
    if (RERUN_SAFE.has(tool)) return this.execute(row, tool, input, execute, context);
    return this.reconcile(row, tool, input);
  }

  /** The earlier try's call was refused (nothing written): run the same call again under the same operation id. */
  private async reclaimAndRun(
    row: OperationRow, tool: string, input: unknown, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    let fresh: OperationRow | null;
    try {
      fresh = await this.opts.store.reclaim(row);
    } catch (e) {
      this.report("reclaim", e);
      return this.refuse(tool, input);
    }
    // Another try took this place at the same moment and is running it.
    if (!fresh) return this.uncertain(row, tool, input);
    return this.execute(fresh, tool, input, execute, context);
  }

  private async execute(
    row: OperationRow, tool: string, input: unknown, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    this.used.add(row.op_id);
    let outcome: ToolOutcome;
    try {
      outcome = await execute(row.op_id, context);
    } catch (e) {
      this.report("execute", e);
      outcome = {
        failed: true,
        result: JSON.stringify({ error: "This tool failed unexpectedly and may have completed only part of its work. Do not retry it; tell the user to check the relevant page.", incomplete: true }),
      };
    }
    const parsed = parseResult(outcome.result);
    const status = classifyOutcome(outcome);
    const receipt = this.opts.buildReceipt(tool, input, outcome.result);
    try {
      // A failed record leaves the row pending: a retry then re-runs (keyed, so no second write) or looks it up.
      await this.opts.store.finish(row, status, storedResult(status, parsed), receipt);
    } catch (e) {
      this.report("finish", e);
    }
    // A re-run whose keyed write found the rows an earlier try had already written (the earlier try stopped before the
    // ledger recorded it): say so, to the model and on the receipt.
    if (parsed?.replayed === true && parsed.success === true) {
      return {
        result: JSON.stringify({ ...parsed, note: REPLAY_NOTE }),
        failed: false,
        receipt: receipt ? withDetail(receipt, REPLAY_DETAIL) : null,
        replayed: true,
      };
    }
    return { ...outcome, receipt, replayed: false };
  }

  private replay(row: OperationRow, tool: string): LedgerOutcome {
    const stored = asObject(row.result) ?? {};
    const base = row.receipt ?? this.opts.buildReceipt(tool, row.intent, JSON.stringify(stored));
    return {
      result: JSON.stringify({ ...stored, replayed: true, note: REPLAY_NOTE }),
      failed: false,
      receipt: base ? withDetail(base, REPLAY_DETAIL) : null,
      replayed: true,
    };
  }

  private async reconcile(row: OperationRow, tool: string, input: unknown): Promise<LedgerOutcome> {
    const lookup = this.opts.reconcilers?.[tool];
    let found: Record<string, unknown> | null = null;
    if (lookup) {
      try {
        found = await lookup(row);
      } catch (e) {
        this.report("reconcile", e);
      }
    }
    if (!found) return this.uncertain(row, tool, input);
    const receipt = this.opts.buildReceipt(tool, row.intent ?? input, JSON.stringify(found));
    try {
      await this.opts.store.finish(row, "done", found, receipt);
    } catch (e) {
      this.report("finish", e);
    }
    return this.replay({ ...row, status: "done", result: found, receipt }, tool);
  }

  private uncertain(row: OperationRow, tool: string, input: unknown): LedgerOutcome {
    const result = JSON.stringify({ error: uncertainText(tool), incomplete: true, uncertain: true });
    return { result, failed: false, receipt: this.opts.buildReceipt(tool, row.intent ?? input, result), replayed: false };
  }

  /**
   * This call was refused because of an earlier try: nothing was written for it, and its receipt says so. The earlier
   * write itself is shown once, by earlierReceipts() (or by the call that matches it later in this try).
   */
  private conflict(tool: string, input: unknown, earlier: OperationRow | null, error = CONFLICT_ERROR): LedgerOutcome {
    const earlierResult = earlier?.status === "done" ? asObject(earlier.result) ?? {} : null;
    const result = JSON.stringify({
      error,
      conflict: true,
      ...(earlier ? { earlier_tool: earlier.tool, earlier_outcome: earlier.status === "done" ? "saved" : "unknown" } : {}),
      ...(earlierResult ? { earlier_result: earlierResult } : {}),
    });
    return { result, failed: false, receipt: this.opts.buildReceipt(tool, input, result), replayed: false };
  }

  private refuse(tool: string, input: unknown): LedgerOutcome {
    const result = JSON.stringify({ error: LEDGER_ERROR });
    return { result, failed: false, receipt: this.opts.buildReceipt(tool, input, result), replayed: false };
  }
}

export type OpenedLedger =
  | { kind: "ledger"; ledger: ChatLedger }
  | { kind: "conflict" }
  | { kind: "unavailable"; code: string }
  | { kind: "failed"; code: string };

/** Record the request (first try or retry) and return its ledger; never throws. */
export async function openLedger(
  store: LedgerStore,
  opts: Omit<LedgerOptions, "store" | "retry"> & { conversationSha: string },
): Promise<OpenedLedger> {
  try {
    const claim = await store.claimRequest(opts.ownerId, opts.requestId, opts.conversationSha);
    if (claim === "conflict") return { kind: "conflict" };
    return { kind: "ledger", ledger: new ChatLedger({ ...opts, store, retry: claim === "retry" }) };
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { kind: "unavailable", code: e.code };
    return { kind: "failed", code: errorCode(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Supabase store and read-only reconcilers                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pds = SupabaseClient<any, any, any>;

const OP_COLS = "op_id,owner_id,request_id,tool,ordinal,intent_sha,intent,status,result,receipt,context,created_at";
/** Missing table / column (the SQL file is not applied yet). */
const MISSING_CODES = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);

function fail(error: { code?: unknown } | null | undefined): never {
  const code = typeof error?.code === "string" && error.code ? error.code : "unknown";
  throw MISSING_CODES.has(code) ? new LedgerUnavailable(code) : new LedgerFailure(code);
}

/** The production store. The client MUST be the service-role client scoped to schema "pds". */
export function supabaseLedgerStore(supabase: Pds): LedgerStore {
  const ops = () => supabase.from("chat_operations");
  return {
    async claimRequest(owner_id, request_id, conversation_sha) {
      const { error } = await supabase.from("chat_requests").insert({ owner_id, request_id, conversation_sha });
      if (!error) return "new";
      if (error.code !== "23505") fail(error);
      const { data, error: readError } = await supabase
        .from("chat_requests")
        .select("conversation_sha")
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .maybeSingle();
      if (readError) fail(readError);
      if (!data) fail({ code: "missing_after_conflict" });
      if ((data as { conversation_sha?: unknown }).conversation_sha !== conversation_sha) return "conflict";
      // Informational only; a failure here does not matter.
      await supabase.from("chat_requests").update({ last_attempt_at: new Date().toISOString() }).eq("owner_id", owner_id).eq("request_id", request_id);
      return "retry";
    },

    async claim(key, intent_sha, intent, context) {
      const { data, error } = await ops().insert({ ...key, intent_sha, intent, context: context ?? null, status: "pending" }).select(OP_COLS).single();
      if (!error && data) return { row: data as OperationRow, created: true };
      if (error && error.code !== "23505") fail(error);
      const { data: existing, error: readError } = await ops()
        .select(OP_COLS)
        .eq("owner_id", key.owner_id)
        .eq("request_id", key.request_id)
        .eq("tool", key.tool)
        .eq("ordinal", key.ordinal)
        .maybeSingle();
      if (readError) fail(readError);
      if (!existing) fail({ code: "missing_after_conflict" });
      return { row: existing as OperationRow, created: false };
    },

    async listForRequest(owner_id, request_id) {
      const { data, error } = await ops()
        .select(OP_COLS)
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .order("created_at", { ascending: true })
        .order("ordinal", { ascending: true })
        .limit(200);
      if (error) fail(error);
      return (data ?? []) as OperationRow[];
    },

    async reclaim(row) {
      // Same call, same operation id: only the status moves (a refused row has nothing worth keeping).
      const { data, error } = await ops()
        .update({ status: "pending", result: null, receipt: null, updated_at: new Date().toISOString() })
        .eq("op_id", row.op_id)
        .eq("owner_id", row.owner_id)
        .eq("status", "refused")
        .eq("intent_sha", row.intent_sha)
        .select(OP_COLS)
        .maybeSingle();
      if (error) fail(error);
      return (data as OperationRow | null) ?? null;
    },

    async finish(row, status, result, receipt) {
      // A confirmed write may overwrite a refusal a concurrent try recorded for the same call; nothing overwrites done.
      const from: OperationStatus[] = status === "done" ? ["pending", "unknown", "refused"] : ["pending", "unknown"];
      const { data, error } = await ops()
        .update({ status, result, receipt, updated_at: new Date().toISOString() })
        .eq("op_id", row.op_id)
        .eq("owner_id", row.owner_id)
        .eq("intent_sha", row.intent_sha)
        .in("status", from)
        .select("op_id");
      if (error) fail(error);
      return ((data as unknown[] | null) ?? []).length > 0;
    },
  };
}

/**
 * The quiz row gets its timestamp from the database clock after the operation row was inserted, so a small margin is
 * enough; it keeps an older row with the same details from being taken for this one.
 */
const RECONCILE_MARGIN_MS = 5_000;

/**
 * Read-only lookups for the write tools that are never re-run. Exactly one matching row counts; two is ambiguous.
 * A playlist is found by its audit key (pds.spotify_playlists.client_key = the operation id, set by createPlaylist);
 * a quiz result, which has no key, by its book, checkpoint, score and total, taken after the operation began.
 */
export function supabaseReconcilers(supabase: Pds): Partial<Record<string, Reconciler>> {
  const since = (row: OperationRow) => {
    const t = Date.parse(row.created_at);
    return new Date((Number.isFinite(t) ? t : Date.now()) - RECONCILE_MARGIN_MS).toISOString();
  };
  return {
    create_spotify_playlist: async (row) => {
      const { data, error } = await supabase
        .from("spotify_playlists")
        .select("playlist_id,name,spotify_url,track_count")
        .eq("client_key", row.op_id)
        .limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return null;
      const p = data[0] as { playlist_id: string; name: string; spotify_url: string | null; track_count: number | null };
      return { success: true, playlist_id: p.playlist_id, spotify_url: p.spotify_url, name: p.name, track_count: p.track_count, reconciled: true };
    },

    record_reading_quiz: async (row) => {
      const intent = asObject(row.intent) ?? {};
      const checkpoint = typeof intent.checkpoint === "string" ? intent.checkpoint.trim() : "";
      const score = Math.round(Number(intent.score));
      const total = Math.round(Number(intent.total));
      if (!checkpoint || !Number.isFinite(score) || !Number.isFinite(total) || total <= 0) return null;
      // The book the tool would have used: the named one, else the book being read (lib/reading.ts getBook).
      const slug = typeof intent.book === "string" && intent.book.trim() ? intent.book.trim() : null;
      let books = supabase.from("books").select("book_id");
      books = slug ? books.eq("slug", slug) : books.eq("status", "reading");
      const { data: book, error: bookError } = await books.order("created_at", { ascending: false }).limit(1);
      const bookId = !bookError && Array.isArray(book) ? (book[0] as { book_id?: unknown } | undefined)?.book_id : undefined;
      if (typeof bookId !== "number") return null;
      const { data, error } = await supabase
        .from("reading_quizzes")
        .select("quiz_id,checkpoint,score,total,quiz_date")
        .eq("book_id", bookId)
        .eq("checkpoint", checkpoint)
        .eq("score", score)
        .eq("total", total)
        .gte("taken_at", since(row))
        .limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return null;
      const q = data[0] as { quiz_id: number; checkpoint: string; score: number; total: number; quiz_date: string };
      return { success: true, passed: q.score / q.total >= 0.8, score: `${q.score}/${q.total}`, checkpoint: q.checkpoint, quiz_date: q.quiz_date, quiz_id: q.quiz_id, reconciled: true };
    },
  };
}
