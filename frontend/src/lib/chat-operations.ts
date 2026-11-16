/**
 * Replay-safe chat writes (SEC-04, sql/chat_operations.sql).
 *
 * /chat sends one request_id per user message and the SAME id when Riley retries that message unchanged after a
 * lost or failed answer. Each write-tool call of a request becomes one row in pds.chat_operations (its canonical
 * input, a status, the result the model got and the receipt Riley saw). On a retry the model is run again and its
 * write calls are matched to the stored rows BY CONTENT (same tool, same canonical input), in any order:
 *
 *   - a call that matches a stored row is answered from it: done = the stored result and receipt, nothing written;
 *     refused (nothing was written) = run again; pending / unknown (the try stopped mid-way) = run again under the
 *     same operation id only when the write itself is keyed by that id (RERUN_SAFE); a habit answer or a highlight
 *     is re-run in check mode (CHECK_ON_RERUN: it completes only when nothing is there yet and never overwrites what
 *     is there now, which may be a change Riley made since); anything else is looked up read-only (reconcilers) and
 *     never created again. A re-run whose answer is a refusal stays unknown: an earlier try may still have written;
 *   - a call that matches nothing is refused whenever an earlier try wrote, or may have written, anything (any row
 *     that is not refused). It may be the same thing asked differently (a stack logged as single products, another
 *     wording, changed details), and no stored plan can prove otherwise, so a retry never starts a new write next to
 *     an earlier one: a different intentional action is a new message. It is refused again if the model repeats it;
 *     an extra copy of a call already answered from a stored row is refused too;
 *   - only when nothing earlier was written (no rows, or every earlier call was refused) does a new call run, as it
 *     would on a first try.
 *
 * The operation id is passed into the write (supplement event key, reading client_key, playlist audit key), so a
 * write that happened before the ledger could record it is found again rather than repeated. What the call depended
 * on when it first ran is stored with it (`context`: the behavioral day, the book being read) and a re-run uses that,
 * so a retry after midnight / 06:00 never moves an omitted "today" to the next day, and a highlight or session never
 * moves to a book started since.
 *
 * Fail closed (the route): a request that carries a request_id runs NO write tool unless its ledger is open, also
 * when the ledger tables are missing; a keyed write whose key column is missing refuses rather than writing unkeyed.
 *
 * One try at a time: each try of a request holds a lease on its chat_requests row (REQUEST_LEASE_MS, longer than the
 * route's maxDuration, so no try outlives its lease) and a retry that arrives while another try still holds it is
 * turned away before the model runs (openLedger -> "busy"). Two tries can therefore never pick different tools for
 * the same intent at the same time.
 *
 * Matching uses a normalised form of the input (matchingForm: trimmed, the names the tools resolve case-insensitively
 * in lower case, "8:30" = "08:30", empty fields left out), so a retry worded slightly differently by the model still
 * matches; the stored intent is the input as sent.
 *
 * Known gaps (follow-ups): a playlist created on Spotify whose audit row could not be written stays "unknown" (no
 * read-only Spotify lookup yet); a Notion entry made by a try that died before it stored the block id is made again
 * by the re-run; a quiz result has no operation key yet (PR #362 adds one), so a quiz left pending is never
 * confirmed and stays "check this"; the ledger keeps tool inputs and results with no retention window yet.
 *
 * Errors are reported by code only (never a message, which can echo user text). No personal data in this file.
 */
import { createHash, randomUUID } from "node:crypto";
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

export type RequestClaim = "new" | "retry" | "conflict" | "busy";

/**
 * How long one try holds its request (one try at a time). It MUST be longer than the chat route's maxDuration
 * (app/api/chat/route.ts, 300 s): the platform stops a try at maxDuration, so a try never outlives its lease, and a
 * lease left by a try that was stopped before it could give it back frees itself a minute later.
 */
export const REQUEST_LEASE_MS = 6 * 60 * 1000;

/** Storage behind the ledger (Supabase in production, an in-memory map in the tests). Methods throw Ledger* errors. */
export interface LedgerStore {
  /**
   * "new" = first time this id is seen; "retry" = seen with the same conversation and no other try is running it;
   * "busy" = another try of it holds the lease; "conflict" = seen with another conversation. "new" and "retry" give
   * this try (attempt_id) the lease.
   */
  claimRequest(owner_id: string, request_id: string, conversation_sha: string, attempt_id: string): Promise<RequestClaim>;
  /** Give the lease back (only while attempt_id still holds it). */
  releaseRequest(owner_id: string, request_id: string, attempt_id: string): Promise<void>;
  /** The request's row, or null when this id was never seen for this owner. */
  getRequest(owner_id: string, request_id: string): Promise<{ lease_until: string | null } | null>;
  /** Insert a pending row for this call, or return the row already in that place (created = false). Atomic. */
  claim(key: OperationKey, intent_sha: string, intent: unknown, context?: OperationContext | null): Promise<{ row: OperationRow; created: boolean }>;
  listForRequest(owner_id: string, request_id: string): Promise<OperationRow[]>;
  /** Take a REFUSED row back to pending (same call, run again); null when it is no longer refused (another try took it). */
  reclaim(row: OperationRow): Promise<OperationRow | null>;
  /** Record the outcome; false when the row had already moved on (a concurrent try finished it). */
  finish(row: OperationRow, status: OperationStatus, result: unknown, receipt: WriteReceipt | null): Promise<boolean>;
}

/**
 * The ledger tables are not there (the SQL file is not applied, or was rolled back): the route answers questions but
 * runs no write tool for the request, exactly as for any other ledger failure (never an unrecorded write).
 */
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

/** Fields the tools resolve case-insensitively, or read as a fixed word (medium, answer, source). */
const CASELESS_FIELDS = new Set(["stack", "product", "unit", "habit", "book", "medium", "source", "answer"]);
/** Fields the tools read with Number(...): "2" and 2 are the same request. */
const NUMERIC_FIELDS = new Set(["amount", "chapter_through", "chapter_from", "minutes", "chapter", "score", "total"]);

/** "8:30" and "08:30" (and "8:30 PM" / "08:30pm") are the same clock time. */
function clockTime(value: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i.exec(value) ?? /^(\d{1,2}):(\d{2})()$/.exec(value);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}${m[3] ? `${m[3].toLowerCase()}m` : ""}` : value;
}

/**
 * The form two calls are compared in: strings trimmed, the fields the tools resolve case-insensitively in lower case,
 * clock times zero-padded, numeric strings as numbers for the numeric fields, and empty / null fields left out (the
 * tools treat them as not given). Only the hash uses it; the stored intent is the input as sent.
 */
export function matchingForm(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    let v: unknown = typeof raw === "string" ? raw.trim() : raw;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" && CASELESS_FIELDS.has(k)) v = v.toLowerCase();
    if (typeof v === "string" && NUMERIC_FIELDS.has(k) && Number.isFinite(Number(v))) v = Number(v);
    if (Array.isArray(v)) v = v.map((t) => (typeof t !== "string" ? t : k === "times" ? clockTime(t.trim().toLowerCase()) : t.trim()));
    out[k] = v;
  }
  return out;
}

export const intentSha = (tool: string, input: unknown): string => sha256Hex(`${tool}\n${canonicalJson(matchingForm(input))}`);

/** Hash of the whole conversation as sent (role + text only): a retry sends exactly the same messages. */
export const conversationSha = (messages: ReadonlyArray<{ role: string; content: string }>): string =>
  sha256Hex(canonicalJson(messages.map(({ role, content }) => ({ role, content }))));

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write tools whose write carries the operation id as its own key (a supplement intake, a stack log, a reading
 * session): re-run under the same id, the write finds what an earlier try wrote and never happens twice.
 */
export const RERUN_SAFE: ReadonlySet<string> = new Set([
  "log_supplement_intake",
  "log_supplement_stack",
  "log_reading_session",
]);

/**
 * Write tools with no key of their own whose target row can be edited by Riley between two tries (a habit answer, a
 * highlight): an unconfirmed call is re-run in CHECK mode only. The tool then confirms what is there when it is
 * exactly what the call asked for, completes the write only when nothing is there yet and nothing Riley does could
 * have removed it, and otherwise writes nothing and reports the outcome as unconfirmed. Never an overwrite.
 */
export const CHECK_ON_RERUN: ReadonlySet<string> = new Set(["mark_habit_complete", "add_book_highlight"]);
// Every other write tool (quiz result, Spotify playlist, and any future write tool until it is added above) is never
// re-run by a retry: it is looked up read-only (reconcilers) or reported as unconfirmed.

export const REPLAY_NOTE =
  "An earlier try of this same message already did this, so nothing was written again. Tell the user it was already saved, using this result.";
export const REPLAY_DETAIL = "Saved by an earlier try of this message, not written again.";
export const EARLIER_DETAIL = "Saved by an earlier try of this message.";
export const CONFLICT_ERROR =
  "An earlier try of this same message already did this with different details, so nothing new was written. To log something different, the user should send it as a new message.";
export const REPEAT_ERROR =
  "An earlier try of this same message did this once and that was already reported in this answer, so nothing more was written. To do it again, the user should send it as a new message.";
export const FRESH_ERROR =
  "An earlier try of this same message already saved something, so this retry starts nothing new and nothing was written. If this is still wanted, the user should send it as a new message.";
export const LEDGER_ERROR =
  "Onyx could not record this action safely, so it was not done and nothing was written. Tell the user to try again in a moment.";
const UNCERTAIN: Record<string, string> = {
  create_spotify_playlist:
    "An earlier try of this message started this playlist and Onyx cannot confirm Spotify made it. Nothing was created now. Check Spotify; if it is not there, ask again in a new message.",
  record_reading_quiz:
    "An earlier try of this message started recording this quiz result and Onyx cannot confirm it. Nothing was recorded now. Check /reading before asking again in a new message.",
};
export const PLAYLIST_TRACKS_UNCONFIRMED = "The playlist exists; Onyx cannot confirm all its tracks were added. Check it in Spotify.";
const UNCERTAIN_DEFAULT =
  "An earlier try of this message started this and Onyx cannot confirm it finished. Nothing was written now. Check the relevant page before asking again in a new message.";
export const uncertainText = (tool: string): string => UNCERTAIN[tool] ?? UNCERTAIN_DEFAULT;
export const RUNNING_TEXT = "This was still being saved when Onyx checked. Check again in a minute before sending anything again.";

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
  /** This try's lease on the request (openLedger sets it; release() gives it back). */
  attemptId?: string;
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

/** A receipt of something an earlier try saved, shown again: nothing new was written now, so "saved" reads "unchanged". */
const asReplay = (receipt: WriteReceipt, line: string): WriteReceipt =>
  withDetail(receipt.status === "saved" ? { ...receipt, status: "unchanged" } : receipt, line);

/**
 * The receipt for a stored row as it stands (null for a refused row: nothing was written): done = its stored receipt,
 * pending / unknown = "check this", with `running` when a try is still on it.
 */
function rowReceipt(row: OperationRow, buildReceipt: ReceiptBuilder, running = false): WriteReceipt | null {
  if (row.status === "refused") return null;
  if (row.status === "done") return row.receipt ?? buildReceipt(row.tool, row.intent, JSON.stringify(asObject(row.result) ?? {}));
  const text = running ? RUNNING_TEXT : uncertainText(row.tool);
  return buildReceipt(row.tool, row.intent, JSON.stringify({ error: text, incomplete: true }));
}

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

/**
 * Runs the tool. `check` = an unconfirmed earlier call of a CHECK_ON_RERUN tool is being re-run: the tool must not
 * overwrite what is there (see CHECK_ON_RERUN).
 */
export type Execute = (opId: string, context: OperationContext, check: boolean) => Promise<ToolOutcome>;

export class ChatLedger {
  readonly retry: boolean;
  private readonly opts: LedgerOptions;
  /** First try: the n-th call of each tool, the place its row takes. */
  private readonly ordinals = new Map<string, number>();
  /** Rows this try has already matched to one of its calls, so one stored call answers one call of this try. */
  private readonly used = new Set<string>();
  /** Calls (by intent hash) this retry refused as a possible change of an earlier write: refused again if repeated. */
  private readonly conflicted = new Set<string>();
  /** Calls (by intent hash) of this try whose outcome is unknown: a repeat of one runs as the same operation. */
  private readonly unsettled = new Map<string, OperationRow>();
  /**
   * A retry: whether an earlier try wrote, or may have written, anything (a row that is not refused), as the rows
   * stood when this try first read them (before it made any row itself). Then no new call runs. null = not read yet.
   */
  private earlierWritten: boolean | null = null;

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
    const intent: unknown = JSON.parse(canonicalJson(input ?? {}));
    const sha = intentSha(tool, input ?? {});
    // The model asks again, in this same try, for a call whose outcome this try could not confirm: the same operation
    // (same key), never a second one.
    const unsettled = this.unsettled.get(sha);
    if (unsettled) return this.resume(unsettled, tool, input, execute);
    return this.retry
      ? this.runRetry(tool, input, sha, intent, execute, context)
      : this.runFirst(tool, input, sha, intent, execute, context);
  }

  /** Give the request's lease back so the next try of it can run. Never throws. */
  async release(): Promise<void> {
    if (!this.opts.attemptId) return;
    try {
      await this.opts.store.releaseRequest(this.opts.ownerId, this.opts.requestId, this.opts.attemptId);
    } catch (e) {
      this.report("release", e);
    }
  }

  /** A first try: every call takes the next place of its tool. */
  private async runFirst(
    tool: string, input: unknown, sha: string, intent: unknown, execute: Execute, context: OperationContext,
  ): Promise<LedgerOutcome> {
    const ordinal = (this.ordinals.get(tool) ?? 0) + 1;
    this.ordinals.set(tool, ordinal);
    return this.claimAndRun(tool, input, sha, intent, ordinal, execute, context);
  }

  /**
   * A retry: match the call to a stored row by content. A call that matches nothing runs only when no earlier try
   * wrote, or may have written, anything; otherwise it is refused (it could repeat an earlier write in another form:
   * a stack's products asked for one by one, changed details), and a new message is the way to ask for more.
   */
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
    // The first read happens before this try makes any row of its own (every row it makes comes after a read here),
    // so every row seen now is an earlier try's.
    if (this.earlierWritten === null) this.earlierWritten = rows.some((r) => r.status !== "refused");
    const same = rows
      .filter((r) => r.tool === tool && r.intent_sha === sha && !this.used.has(r.op_id))
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (same) return this.resume(same, tool, input, execute);
    // One more copy of a call already answered from a stored row: the earlier try made it fewer times.
    if (rows.some((r) => r.tool === tool && r.intent_sha === sha)) return this.conflict(tool, input, null, REPEAT_ERROR);
    // The model asks again for a call this retry already refused.
    if (this.conflicted.has(sha)) return this.conflict(tool, input, null, this.earlierWritten ? FRESH_ERROR : CONFLICT_ERROR);
    if (this.earlierWritten) {
      // Something was (or may have been) written by an earlier try: never a new write next to it. The earlier write
      // named in the answer is one not matched yet, of this tool when there is one, else any earlier write.
      this.conflicted.add(sha);
      const earlier = rows.filter((r) => r.status !== "refused");
      const unmatched = earlier.filter((r) => !this.used.has(r.op_id));
      const named = unmatched.find((r) => r.tool === tool) ?? unmatched[0] ?? earlier.find((r) => r.tool === tool) ?? earlier[0] ?? null;
      return this.conflict(tool, input, named, unmatched.length > 0 ? CONFLICT_ERROR : FRESH_ERROR);
    }
    // Nothing earlier was written (no rows, or only refused ones): this call runs as on a first try.
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
      if (this.used.has(row.op_id)) continue;
      const receipt = rowReceipt(row, this.opts.buildReceipt);
      if (receipt) out.push(row.status === "done" ? asReplay(receipt, EARLIER_DETAIL) : receipt);
    }
    return out;
  }

  /** A stored row matched by content. */
  private async resume(row: OperationRow, tool: string, input: unknown, execute: Execute): Promise<LedgerOutcome> {
    this.used.add(row.op_id);
    const context = asObject(row.context) ?? {};
    if (row.status === "done") return this.replay(row, tool);
    if (row.status === "refused") return this.reclaimAndRun(row, tool, input, execute, context);
    // pending (a try still running, or one that stopped mid-way) or unknown (one that failed part-way): it may have
    // written. Keyed writes re-run under the same id; habit answers and highlights re-run in check mode only.
    if (RERUN_SAFE.has(tool)) return this.execute(row, tool, input, execute, context, { rerun: true, check: false });
    if (CHECK_ON_RERUN.has(tool)) return this.execute(row, tool, input, execute, context, { rerun: true, check: true });
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

  /**
   * `rerun` = the row was pending / unknown (an earlier try may have written): a refusal now does not prove nothing
   * was written (the earlier write may exist and the lookup that would find it may have failed), so it is kept as
   * unknown and reported as unconfirmed, never as "not saved". `check` is passed to the tool (CHECK_ON_RERUN).
   */
  private async execute(
    row: OperationRow, tool: string, input: unknown, execute: Execute, context: OperationContext,
    mode: { rerun: boolean; check: boolean } = { rerun: false, check: false },
  ): Promise<LedgerOutcome> {
    this.used.add(row.op_id);
    let outcome: ToolOutcome;
    try {
      outcome = await execute(row.op_id, context, mode.check);
    } catch (e) {
      this.report("execute", e);
      outcome = {
        failed: true,
        result: JSON.stringify({ error: "This tool failed unexpectedly and may have completed only part of its work. Do not retry it; tell the user to check the relevant page.", incomplete: true }),
      };
    }
    if (mode.rerun && classifyOutcome(outcome) === "refused") {
      const unconfirmed = this.uncertain(row, tool, input);
      try {
        await this.opts.store.finish(row, "unknown", storedResult("unknown", parseResult(unconfirmed.result)), unconfirmed.receipt);
      } catch (e) {
        this.report("finish", e);
      }
      this.unsettled.set(row.intent_sha, { ...row, status: "unknown" });
      return unconfirmed;
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
    if (status === "unknown") this.unsettled.set(row.intent_sha, { ...row, status });
    else this.unsettled.delete(row.intent_sha);
    // A re-run whose keyed write found the rows an earlier try had already written (the earlier try stopped before the
    // ledger recorded it): say so, to the model and on the receipt.
    if (parsed?.replayed === true && parsed.success === true) {
      return {
        result: JSON.stringify({ ...parsed, note: REPLAY_NOTE }),
        failed: false,
        receipt: receipt ? asReplay(receipt, REPLAY_DETAIL) : null,
        replayed: true,
      };
    }
    return { ...outcome, receipt, replayed: false };
  }

  private replay(row: OperationRow, tool: string): LedgerOutcome {
    this.unsettled.delete(row.intent_sha);
    const stored = asObject(row.result) ?? {};
    const base = row.receipt ?? this.opts.buildReceipt(tool, row.intent, JSON.stringify(stored));
    return {
      result: JSON.stringify({ ...stored, replayed: true, note: REPLAY_NOTE }),
      failed: false,
      receipt: base ? asReplay(base, REPLAY_DETAIL) : null,
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
    let receipt = this.opts.buildReceipt(tool, row.intent ?? input, JSON.stringify(found));
    // Found, but only part of it is confirmed (a playlist whose tracks were not confirmed): it exists, so it is never
    // made again, and the receipt says what to check.
    if (receipt && typeof found.partly_confirmed === "string") {
      receipt = { ...receipt, status: "unknown", details: [...receipt.details, found.partly_confirmed] };
    }
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
  /** Another try of this request is still running (it holds the lease): nothing runs now. */
  | { kind: "busy" }
  | { kind: "unavailable"; code: string }
  | { kind: "failed"; code: string };

/**
 * Record the request (first try or retry), take its lease for this try and return its ledger; never throws. The
 * caller MUST call ledger.release() when the try ends (a lease that is not given back frees itself after
 * REQUEST_LEASE_MS).
 */
export async function openLedger(
  store: LedgerStore,
  opts: Omit<LedgerOptions, "store" | "retry" | "attemptId"> & { conversationSha: string },
): Promise<OpenedLedger> {
  const attemptId = randomUUID();
  try {
    const claim = await store.claimRequest(opts.ownerId, opts.requestId, opts.conversationSha, attemptId);
    if (claim === "conflict") return { kind: "conflict" };
    if (claim === "busy") return { kind: "busy" };
    return { kind: "ledger", ledger: new ChatLedger({ ...opts, store, retry: claim === "retry", attemptId }) };
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { kind: "unavailable", code: e.code };
    return { kind: "failed", code: errorCode(e) };
  }
}

/**
 * What a request saved, read back by its id alone (the /chat page asks after a reload lost the conversation):
 * "none" = this id never reached the ledger (nothing was written under it); "running" = a try still holds it;
 * "settled" = no try is running. Receipts: one per write that was saved or may have been (refused calls wrote
 * nothing and are left out). Read-only. Never throws.
 */
export type RequestOutcome =
  | { status: "none" | "running" | "settled"; receipts: WriteReceipt[] }
  | { status: "unavailable" | "failed"; code: string; receipts: [] };

export async function requestOutcome(
  store: LedgerStore,
  ownerId: string,
  requestId: string,
  buildReceipt: ReceiptBuilder,
  now: number = Date.now(),
): Promise<RequestOutcome> {
  try {
    const request = await store.getRequest(ownerId, requestId);
    if (!request) return { status: "none", receipts: [] };
    const until = request.lease_until ? Date.parse(request.lease_until) : NaN;
    const running = Number.isFinite(until) && until > now;
    const rows = await store.listForRequest(ownerId, requestId);
    const receipts = rows.map((r) => rowReceipt(r, buildReceipt, running)).filter((r): r is WriteReceipt => r !== null);
    return { status: running ? "running" : "settled", receipts };
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { status: "unavailable", code: e.code, receipts: [] };
    return { status: "failed", code: errorCode(e), receipts: [] };
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
  const requests = () => supabase.from("chat_requests");
  const leaseUntil = () => new Date(Date.now() + REQUEST_LEASE_MS).toISOString();
  return {
    async claimRequest(owner_id, request_id, conversation_sha, attempt_id) {
      const { error } = await requests().insert({ owner_id, request_id, conversation_sha, lease_id: attempt_id, lease_until: leaseUntil() });
      if (!error) return "new";
      if (error.code !== "23505") fail(error);
      const { data, error: readError } = await requests()
        .select("conversation_sha")
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .maybeSingle();
      if (readError) fail(readError);
      if (!data) fail({ code: "missing_after_conflict" });
      if ((data as { conversation_sha?: unknown }).conversation_sha !== conversation_sha) return "conflict";
      // The lease is taken only when it is free (the last try gave it back) or has run out (the last try was stopped
      // before it could); each is one conditional update, so two tries arriving together cannot both take it.
      const nowIso = new Date().toISOString();
      const take = { lease_id: attempt_id, lease_until: leaseUntil(), last_attempt_at: nowIso };
      const free = await requests()
        .update(take)
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .eq("conversation_sha", conversation_sha)
        .is("lease_until", null)
        .select("request_id");
      if (free.error) fail(free.error);
      if (((free.data as unknown[] | null) ?? []).length > 0) return "retry";
      const expired = await requests()
        .update(take)
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .eq("conversation_sha", conversation_sha)
        .lt("lease_until", nowIso)
        .select("request_id");
      if (expired.error) fail(expired.error);
      return ((expired.data as unknown[] | null) ?? []).length > 0 ? "retry" : "busy";
    },

    async releaseRequest(owner_id, request_id, attempt_id) {
      const { error } = await requests()
        .update({ lease_id: null, lease_until: null })
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .eq("lease_id", attempt_id);
      if (error) fail(error);
    },

    async getRequest(owner_id, request_id) {
      const { data, error } = await requests().select("lease_until").eq("owner_id", owner_id).eq("request_id", request_id).maybeSingle();
      if (error) fail(error);
      if (!data) return null;
      const until = (data as { lease_until?: unknown }).lease_until;
      return { lease_until: typeof until === "string" ? until : null };
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
 * Read-only lookups for the write tools that are never re-run. Exactly one matching row counts; two is ambiguous.
 * A playlist is found by its audit key (pds.spotify_playlists.client_key = the operation id, set by createPlaylist).
 * A quiz result has no operation key yet, so there is deliberately no lookup for it: a match by book, checkpoint,
 * score and time could take a later attempt for this one. A quiz left pending stays "check this" until the quiz write
 * carries the operation id (PR #362's op_key) and is read back by it.
 */
export function supabaseReconcilers(supabase: Pds): Partial<Record<string, Reconciler>> {
  return {
    create_spotify_playlist: async (row) => {
      const { data, error } = await supabase
        .from("spotify_playlists")
        .select("playlist_id,name,spotify_url,track_count")
        .eq("client_key", row.op_id)
        .limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return null;
      const p = data[0] as { playlist_id: string; name: string; spotify_url: string | null; track_count: number | null };
      // createPlaylist writes the audit row as soon as Spotify made the playlist (track_count NULL) and sets the count
      // once every track was added: a NULL count = the playlist exists, its tracks are not confirmed.
      return {
        success: true,
        playlist_id: p.playlist_id,
        spotify_url: p.spotify_url,
        name: p.name,
        track_count: p.track_count,
        reconciled: true,
        ...(p.track_count == null ? { partly_confirmed: PLAYLIST_TRACKS_UNCONFIRMED } : {}),
      };
    },
  };
}
