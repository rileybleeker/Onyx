/**
 * Replay-safe chat writes (SEC-04, sql/chat_operations.sql).
 *
 * /chat sends one request_id per user message and the SAME id when Riley retries that message unchanged after a
 * lost or failed answer. Each write-tool call of a request becomes one row in pds.chat_operations (its canonical
 * input, a status, the result the model got and the receipt Riley saw). On a retry the model is run again and its
 * write calls are matched to the stored rows BY CONTENT (same tool, same canonical input), in any order:
 *
 *   - a call that matches a stored row is answered from it: done = the stored result and receipt, nothing written;
 *     refused (nothing was written) = run again, but only when nothing earlier was written (see below); pending /
 *     unknown (the try stopped mid-way) = run again under the same operation id only when the write itself is keyed
 *     by that id (RERUN_SAFE), and then only reading back what the key holds when another earlier call wrote (or may
 *     have written) too; a habit answer or a highlight is re-run in check mode (CHECK_ON_RERUN: it never overwrites
 *     what is there now, which may be a change Riley made since); anything else is looked up read-only (reconcilers)
 *     and never created again. A re-run whose answer is a refusal stays unknown: an earlier try may still have
 *     written;
 *   - a call that matches nothing, or matches a call the earlier try refused, is refused whenever an earlier try
 *     wrote, or may have written, anything (any row that is not refused). It may be the same thing asked differently
 *     (a stack logged as single products, another wording, changed details), and no stored plan can prove otherwise,
 *     so a retry never starts a new write next to an earlier one: a different intentional action is a new message.
 *     It is refused again if the model repeats it; an extra copy of a call already answered from a stored row is
 *     refused too;
 *   - only when nothing earlier was written (no rows, or every earlier call was refused) does a new call run, as it
 *     would on a first try.
 *
 * Inside one try (a first try too) the same two rules hold for the calls of that try: while a call of the try is
 * unconfirmed (it threw, or says it may be incomplete) no new write starts (UNSETTLED_ERROR: the next write could be
 * that one in another form, e.g. a stack whose log failed part-way followed by its products one by one), until a
 * re-run of the same call confirms it; and a keyed re-run of an unconfirmed call only reads back what its key holds
 * when any other call, of an earlier try or of this one, wrote or may have written.
 *
 * The operation id is passed into the write (supplement event key, reading client_key, highlight client_key, quiz
 * op_key, playlist audit key), so a write that happened before the ledger could record it is found again rather than repeated. When
 * Riley removed such a write afterwards, the removal leaves a tombstone (sql/chat_operations.sql) and the re-run
 * answers `removed_since` (settled as done, never written again) instead of writing it a second time. What the call depended
 * on when it first ran is stored with it (`context`: the behavioral day, the book being read) and a re-run uses that,
 * so a retry after midnight / 06:00 never moves an omitted "today" to the next day, and a highlight or session never
 * moves to a book started since.
 *
 * Fail closed (the route): a request that carries a request_id runs NO write tool unless its ledger is open, also
 * when the ledger tables are missing; a keyed write whose key column or tombstone table is missing refuses rather
 * than writing unkeyed (a playlist checks before Spotify is asked to make anything).
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
 * A session or highlight an EARLIER call wrote (found under its key) is only read by a re-run: its book finish, habit
 * Yes and Notion entry are never made then (the call may have made them, and Riley may have undone one since, such as
 * a cleared habit answer); each one that shows nothing is listed as `unconfirmed` on the result and the receipt.
 *
 * Known gaps (follow-ups): a playlist created on Spotify whose audit row could not be written stays "unknown" (no
 * read-only Spotify lookup yet); a Notion entry (or habit Yes, or book finish) the earlier call never made stays
 * missing, named on the receipt for Riley to check; a call the earlier try never reached (it died after
 * another call wrote) is refused on the retry and must be sent as a new message; the ledger keeps tool inputs and
 * results with no retention window yet; a request with no request_id (a page loaded before this change) still runs
 * its writes without the ledger, as before.
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

/**
 * "retired" = the ledger once held this id and the 180-day retention removed it (sql/chat_ledger_retention.sql keeps
 * a pds.chat_retired_requests marker): its writes may still exist under keys a new request would not reuse, so it
 * is refused, never run as new (Codex #817 CHAT795-1).
 */
export type RequestClaim = "new" | "retry" | "conflict" | "busy" | "retired";

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
   * "busy" = another try of it holds the lease; "conflict" = seen with another conversation; "retired" = its ledger
   * rows were removed by retention (nothing runs). "new" and "retry" give this try (attempt_id) the lease.
   */
  claimRequest(
    owner_id: string, request_id: string, conversation_sha: string, attempt_id: string, context?: OperationContext | null,
  ): Promise<RequestClaim>;
  /**
   * The request context the FIRST try stored with the row (claimRequest "new"): the local time, its time zone and
   * the behavioral day. null = none stored (a row from before the column). Throws Ledger* errors.
   */
  requestContext(owner_id: string, request_id: string): Promise<OperationContext | null>;
  /** Give the lease back (only while attempt_id still holds it). */
  releaseRequest(owner_id: string, request_id: string, attempt_id: string): Promise<void>;
  /** The request's row, or null when this id was never seen for this owner. */
  getRequest(owner_id: string, request_id: string): Promise<{ lease_until: string | null } | null>;
  /**
   * Record this id as abandoned (ABANDONED_CONVERSATION_SHA, no lease) when no row exists for it; one atomic insert.
   * "abandoned" = recorded now or earlier; "exists" = the request itself reached the ledger first.
   */
  abandonRequest(owner_id: string, request_id: string): Promise<"abandoned" | "exists">;
  /** Insert a pending row for this call, or return the row already in that place (created = false). Atomic. */
  claim(key: OperationKey, intent_sha: string, intent: unknown, context?: OperationContext | null): Promise<{ row: OperationRow; created: boolean }>;
  /**
   * EVERY row of the request, oldest first, or a Ledger* error: never part of them (a row left out could be the write
   * that makes a retry refuse new calls).
   */
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
const NUMERIC_FIELDS = new Set(["amount", "chapter_through", "chapter_from", "minutes", "chapter", "score", "total", "question_id", "version"]);
/**
 * The model's own wording about a call, never part of what it asks for: left out of the match, so a retry whose model
 * words the grade or the feedback differently still finds the answer an earlier try stored for the same question and
 * reply (and answers it from the stored result, which holds the grade that was kept).
 */
const UNMATCHED_FIELDS = new Set(["verdict", "feedback"]);

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
    if (v === null || v === undefined || v === "" || UNMATCHED_FIELDS.has(k)) continue;
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
 * session, a quiz result): re-run under the same id, the write finds what an earlier try wrote and never happens
 * twice. When any other call (of an earlier try, or of this try) also wrote or may have written, the re-run is in
 * CHECK mode: it only reads back what its key holds and never writes, because a write that never happened would now
 * be a new write next to that other one (possibly the same thing in another form: a stack whose products were then
 * logged one by one).
 */
export const RERUN_SAFE: ReadonlySet<string> = new Set([
  "log_supplement_intake",
  "log_supplement_stack",
  "log_reading_session",
  // The operation id is the quiz's op_key (pds.reading_record_quiz): the same key answers the stored receipt.
  "record_reading_quiz",
  // Question-bank answers and flags (READ-QUIZ-01): the attempt key / flag key are derived from the operation id
  // (lib/reading-recall-server.ts chatAttemptKey / chatFlagKey), so a re-run finds the row an earlier try stored.
  "record_reading_answer",
  "flag_reading_question",
]);

/**
 * Write tools whose target row can be edited by Riley between two tries (a habit answer, a highlight): an
 * unconfirmed call is re-run in CHECK mode only, which never overwrites what is there. A habit answer (no key of
 * its own) is only read: confirmed when the day holds exactly that answer, otherwise nothing is written and it stays
 * unconfirmed (Riley asks again in a new message), also when the day holds no answer. A highlight is found by its
 * key (the operation id, stored on the highlight it created) and confirmed as that earlier write; with no keyed
 * highlight it is confirmed when the highlight with that passage is what the call asked for, written only when no
 * highlight of the book changed since the operation began (so nothing the earlier try could have changed exists),
 * and otherwise unconfirmed.
 */
export const CHECK_ON_RERUN: ReadonlySet<string> = new Set(["mark_habit_complete", "add_book_highlight"]);
// Every other write tool (Spotify playlist, and any future write tool until it is added above) is never
// re-run by a retry: it is looked up read-only (reconcilers) or reported as unconfirmed.

export const REPLAY_NOTE =
  "An earlier try of this same message already did this, so nothing was written again. Tell the user it was already saved, using this result.";
export const REPLAY_DETAIL = "Saved by an earlier try of this message, not written again.";
/** Added to REPLAY_NOTE when the result lists follow-up steps the earlier write may lack (`unconfirmed`). */
export const UNCONFIRMED_NOTE =
  "Some follow-up steps of that earlier write could not be confirmed and were not done now: tell the user each line in `unconfirmed`.";
export const EARLIER_DETAIL = "Saved by an earlier try of this message.";
export const CONFLICT_ERROR =
  "An earlier try of this same message already did this with different details, so nothing new was written. To log something different, the user should send it as a new message.";
export const REPEAT_ERROR =
  "An earlier try of this same message did this once and that was already reported in this answer, so nothing more was written. To do it again, the user should send it as a new message.";
export const FRESH_ERROR =
  "An earlier try of this same message already saved something, so this retry starts nothing new and nothing was written. If this is still wanted, the user should send it as a new message.";
export const UNSETTLED_ERROR =
  "Another action in this message could not be confirmed and may have been saved, so Onyx started nothing new and nothing was written for this. Tell the user to check that one first; anything still wanted can then be sent as a new message.";
export const LEDGER_ERROR =
  "Onyx could not record this action safely, so it was not done and nothing was written. Tell the user to try again in a moment.";
const UNCERTAIN: Record<string, string> = {
  create_spotify_playlist:
    "An earlier try of this message started this playlist and Onyx cannot confirm Spotify made it. Nothing was created now. Check Spotify; if it is not there, ask again in a new message.",
  record_reading_quiz:
    "An earlier try of this message started recording this quiz result and Onyx cannot confirm it. Nothing was recorded now. Check /reading before asking again in a new message.",
};
export const PLAYLIST_TRACKS_UNCONFIRMED = "The playlist exists; Onyx cannot confirm all its tracks were added. Check it in Spotify.";
const UNCERTAIN_BANK: Record<string, string> = {
  record_reading_answer:
    "An earlier try of this message started recording this answer and Onyx cannot confirm it. Nothing was recorded now. Check /reading before answering it again in a new message.",
  flag_reading_question:
    "An earlier try of this message started flagging this question and Onyx cannot confirm it. Nothing was flagged now. Check /reading before flagging it again in a new message.",
};
const UNCERTAIN_DEFAULT =
  "An earlier try of this message started this and Onyx cannot confirm it finished. Nothing was written now. Check the relevant page before asking again in a new message.";
export const uncertainText = (tool: string): string => UNCERTAIN[tool] ?? UNCERTAIN_BANK[tool] ?? UNCERTAIN_DEFAULT;
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
  /**
   * What the request ran with (its time, time zone and behavioral day): on a first try the values it was given, on a
   * retry the ones the first try stored. null = a retry of a row that stored none (from before the column).
   */
  requestContext?: OperationContext | null;
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

/** A done row whose earlier write was removed since (its result says `removed_since`): settled, nothing saved now. */
const removedSince = (row: OperationRow): boolean => asObject(row.result)?.removed_since === true;

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

/**
 * done = the tool confirmed the write, or found that what an earlier try wrote under this operation id was removed
 * since (`removed_since`: settled, never written again); refused = a clean error, nothing written; unknown = it threw
 * or says it may be incomplete.
 */
export function classifyOutcome(outcome: ToolOutcome): OperationStatus {
  if (outcome.failed) return "unknown";
  const r = parseResult(outcome.result);
  if (!r) return "unknown";
  if (r.success === true) return "done";
  if (r.removed_since === true) return "done";
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
  /** See LedgerOptions.requestContext. */
  readonly requestContext: OperationContext | null;
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
  /** A retry: the rows as this try first read them (every one an earlier try's); empty on a first try. */
  private earlierRows: OperationRow[] = [];
  /**
   * Rows of calls this try ran (or answered from a stored write) that wrote, or may have written, something. Together
   * with earlierRows they decide whether a keyed re-run may write (othersWritten): a stack this try could not confirm,
   * then its products logged one by one, then the stack again must only read back, never log the stack on top.
   */
  private readonly wroteNow = new Set<string>();
  /**
   * Calls of this try whose outcome is unknown (they may have written, possibly in part), by row. While one is open no
   * new write starts in this try (a first try too): the next write could be the same thing in another form (the
   * products of a stack whose log failed part-way). Settled (confirmed by a re-run of the same call), it is removed.
   */
  private readonly openNow = new Map<string, OperationRow>();

  constructor(opts: LedgerOptions) {
    this.opts = opts;
    this.retry = opts.retry;
    this.requestContext = opts.requestContext ?? null;
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

  /**
   * A retry: the context an earlier try stored with this same call (same tool and arguments) when it ran, or null (a
   * first try, no such call, a call that was refused, or the rows could not be read). Read-only; never throws. Lets the
   * caller check a retried call against what it first ran with (the book it was pinned to), not this moment's state.
   */
  async storedContext(tool: string, input: unknown): Promise<OperationContext | null> {
    if (!this.retry) return null;
    const sha = intentSha(tool, input ?? {});
    try {
      const rows = await this.opts.store.listForRequest(this.opts.ownerId, this.opts.requestId);
      const row = rows.filter((r) => r.tool === tool && r.intent_sha === sha && r.status !== "refused").sort((a, b) => a.ordinal - b.ordinal)[0];
      return row ? asObject(row.context) ?? null : null;
    } catch (e) {
      this.report("list", e);
      return null;
    }
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
    // Another call of this try may have written (part of) its work: nothing new starts next to it.
    if (this.openNow.size > 0) return this.blockAfterOpen(tool, input);
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
    if (this.earlierWritten === null) {
      this.earlierWritten = rows.some((r) => r.status !== "refused");
      this.earlierRows = rows;
    }
    const same = rows
      .filter((r) => r.tool === tool && r.intent_sha === sha && !this.used.has(r.op_id))
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    // A call the earlier try refused wrote nothing, so running it now is a new write like any other: once an earlier
    // call wrote (or may have written) something it is refused too. It may be that same thing in another form (a
    // stack refused, its products then logged one by one, now the stack again).
    if (same?.status === "refused" && this.earlierWritten) return this.blockNew(tool, input, sha, rows, FRESH_ERROR);
    // Running a refused call again is a new write too: not next to a call of this try that may have written.
    if (same?.status === "refused" && this.openNow.size > 0) return this.blockAfterOpen(tool, input);
    if (same) return this.resume(same, tool, input, execute);
    // One more copy of a call an earlier try made and that was already answered from its stored row: the earlier try
    // made it fewer times. (Copies of a call this retry itself started, when nothing earlier was written, run as they
    // would on a first try.)
    if (this.earlierWritten && this.earlierRows.some((r) => r.tool === tool && r.intent_sha === sha)) {
      return this.conflict(tool, input, null, REPEAT_ERROR);
    }
    // The model asks again for a call this retry already refused.
    if (this.conflicted.has(sha)) return this.conflict(tool, input, null, this.earlierWritten ? FRESH_ERROR : CONFLICT_ERROR);
    // Something was (or may have been) written by an earlier try: never a new write next to it.
    if (this.earlierWritten) return this.blockNew(tool, input, sha, rows);
    // Nor next to a call of this try that may have written.
    if (this.openNow.size > 0) return this.blockAfterOpen(tool, input);
    // Nothing earlier was written (no rows, or only refused ones): this call runs as on a first try.
    const ordinal = rows.filter((r) => r.tool === tool).reduce((n, r) => Math.max(n, r.ordinal), 0) + 1;
    return this.claimAndRun(tool, input, sha, intent, ordinal, execute, context);
  }

  /**
   * A retry's new write (a call that matches nothing, or one the earlier try refused) next to what an earlier try
   * wrote: refused, and again when the model repeats it. The earlier write named in the answer is one not matched
   * yet, of this tool when there is one, else any earlier write.
   */
  private blockNew(tool: string, input: unknown, sha: string, rows: OperationRow[], error?: string): LedgerOutcome {
    this.conflicted.add(sha);
    const earlier = rows.filter((r) => r.status !== "refused");
    const unmatched = earlier.filter((r) => !this.used.has(r.op_id));
    const named = unmatched.find((r) => r.tool === tool) ?? unmatched[0] ?? earlier.find((r) => r.tool === tool) ?? earlier[0] ?? null;
    return this.conflict(tool, input, named, error ?? (unmatched.length > 0 ? CONFLICT_ERROR : FRESH_ERROR));
  }

  /**
   * A new write while a call of this try is unconfirmed (it may have written, possibly in part): refused, and the
   * unconfirmed call is named. It is refused again if the model repeats it while that call stays unconfirmed.
   */
  private blockAfterOpen(tool: string, input: unknown): LedgerOutcome {
    const open = [...this.openNow.values()];
    return this.conflict(tool, input, open.find((r) => r.tool === tool) ?? open[0] ?? null, UNSETTLED_ERROR);
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
   * asked for something else), so Riley still sees what was already saved. Empty on a first try. null = the ledger
   * could not be read: what the earlier try saved is UNKNOWN, never "nothing" (the route then says so and the page
   * keeps the request remembered, so its account can still be read back after a reload).
   */
  async earlierReceipts(): Promise<WriteReceipt[] | null> {
    if (!this.retry) return [];
    let rows: OperationRow[];
    try {
      rows = await this.opts.store.listForRequest(this.opts.ownerId, this.opts.requestId);
    } catch (e) {
      this.report("list", e);
      return null;
    }
    const out: WriteReceipt[] = [];
    for (const row of rows) {
      if (this.used.has(row.op_id)) continue;
      const receipt = rowReceipt(row, this.opts.buildReceipt);
      // A write removed since already says so on its receipt (nothing is saved now).
      if (receipt) out.push(row.status === "done" && !removedSince(row) ? asReplay(receipt, EARLIER_DETAIL) : receipt);
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
    // written. Keyed writes re-run under the same id, in check mode (read back only) when another earlier call wrote
    // or may have written; habit answers and highlights re-run in check mode only.
    if (RERUN_SAFE.has(tool)) return this.execute(row, tool, input, execute, context, { rerun: true, check: this.othersWritten(row) });
    if (CHECK_ON_RERUN.has(tool)) return this.execute(row, tool, input, execute, context, { rerun: true, check: true });
    return this.reconcile(row, tool, input);
  }

  /**
   * Did any call other than this row write, or may it have written, something: a call of an earlier try (a retry's
   * earlierRows) or one of this try (wroteNow, a first try too)?
   */
  private othersWritten(row: OperationRow): boolean {
    if (this.earlierRows.some((r) => r.op_id !== row.op_id && r.status !== "refused")) return true;
    for (const id of this.wroteNow) if (id !== row.op_id) return true;
    return false;
  }

  /** Record what this call's outcome means for the rest of this try (see wroteNow and openNow). */
  private settle(row: OperationRow, status: OperationStatus) {
    if (status === "done" || status === "unknown") this.wroteNow.add(row.op_id);
    if (status === "unknown") this.openNow.set(row.op_id, row);
    else this.openNow.delete(row.op_id);
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
      this.settle(row, "unknown");
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
    this.settle(row, status);
    // A re-run whose keyed write found the rows an earlier try had already written (the earlier try stopped before the
    // ledger recorded it): say so, to the model and on the receipt.
    if (parsed?.replayed === true && parsed.success === true) {
      const unconfirmed = Array.isArray(parsed.unconfirmed) && parsed.unconfirmed.length > 0;
      return {
        result: JSON.stringify({ ...parsed, note: unconfirmed ? `${REPLAY_NOTE} ${UNCONFIRMED_NOTE}` : REPLAY_NOTE }),
        failed: false,
        receipt: receipt ? asReplay(receipt, REPLAY_DETAIL) : null,
        replayed: true,
      };
    }
    return { ...outcome, receipt, replayed: false };
  }

  private replay(row: OperationRow, tool: string): LedgerOutcome {
    this.unsettled.delete(row.intent_sha);
    this.settle(row, "done");
    const stored = asObject(row.result) ?? {};
    const base = row.receipt ?? this.opts.buildReceipt(tool, row.intent, JSON.stringify(stored));
    return {
      // Removed since: its own error line tells the model and the receipt what to say (not "it was already saved").
      result: JSON.stringify({
        ...stored,
        replayed: true,
        ...(removedSince(row)
          ? {}
          : { note: Array.isArray(stored.unconfirmed) && stored.unconfirmed.length > 0 ? `${REPLAY_NOTE} ${UNCONFIRMED_NOTE}` : REPLAY_NOTE }),
      }),
      failed: false,
      receipt: base ? (removedSince(row) ? base : asReplay(base, REPLAY_DETAIL)) : null,
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

  /** The row's outcome cannot be confirmed: it may have written, so it stays open for the rest of this try. */
  private uncertain(row: OperationRow, tool: string, input: unknown): LedgerOutcome {
    this.settle(row, "unknown");
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
      ...(earlier
        ? { earlier_tool: earlier.tool, earlier_outcome: earlier.status !== "done" ? "unknown" : earlierResult?.removed_since === true ? "removed_since" : "saved" }
        : {}),
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
  /** The id's ledger rows were removed by retention: an old send replayed. Nothing runs (it could write twice). */
  | { kind: "retired" }
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
    const claim = await store.claimRequest(opts.ownerId, opts.requestId, opts.conversationSha, attemptId, opts.requestContext ?? null);
    if (claim === "conflict") return { kind: "conflict" };
    if (claim === "retired") return { kind: "retired" };
    if (claim === "busy") return { kind: "busy" };
    const retry = claim === "retry";
    // A retry runs with what the FIRST try ran with (its local time and behavioral day), never this moment's: a first
    // try that stopped before any operation was recorded leaves nothing else to pin, and a retry after midnight /
    // 06:00 must not log "today" on the next day. Unreadable: the ledger fails (writes pause), never a fresh day.
    const requestContext = retry ? await store.requestContext(opts.ownerId, opts.requestId) : opts.requestContext ?? null;
    return { kind: "ledger", ledger: new ChatLedger({ ...opts, store, retry, attemptId, requestContext }) };
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

/**
 * The conversation hash an abandoned request id is recorded under. No conversation hashes to it, so when the request
 * itself arrives later (it was still on its way when the page asked), its claim is a conflict and it runs nothing.
 */
export const ABANDONED_CONVERSATION_SHA = "0".repeat(64);

/**
 * Riley dismissed "this message never reached Onyx" after a reload (POST /api/chat/operations). An id that is not in
 * the ledger is not proof that it never will be: the request may still be on its way (another tab, a slow network),
 * and the page forgetting the id would let the same message be sent again under a new id, so both would write. So
 * the id is recorded as abandoned first, in one insert: from then on the request itself is refused if it arrives. If
 * it reached the ledger before that insert, nothing is recorded and its account is returned instead (what it saved),
 * exactly as GET answers. "abandoned" is the only answer after which the page forgets the id. Never throws.
 */
export type AbandonOutcome = { status: "abandoned"; receipts: [] } | RequestOutcome;

export async function abandonRequest(
  store: LedgerStore,
  ownerId: string,
  requestId: string,
  buildReceipt: ReceiptBuilder,
  now: number = Date.now(),
): Promise<AbandonOutcome> {
  try {
    if ((await store.abandonRequest(ownerId, requestId)) === "abandoned") return { status: "abandoned", receipts: [] };
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { status: "unavailable", code: e.code, receipts: [] };
    return { status: "failed", code: errorCode(e), receipts: [] };
  }
  return requestOutcome(store, ownerId, requestId, buildReceipt, now);
}

/* ------------------------------------------------------------------ */
/* Supabase store and read-only reconcilers                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pds = SupabaseClient<any, any, any>;

const OP_COLS = "op_id,owner_id,request_id,tool,ordinal,intent_sha,intent,status,result,receipt,context,created_at";
/** Rows read per round trip when a request's operations are listed (under Supabase's default max-rows of 1000). */
const LIST_PAGE = 200;
/**
 * More operation rows than one request can reach in practice (a try adds at most MAX_TOOL_CALLS = 32, and a retry
 * adds new ones only while every earlier call was refused). Past it the listing fails closed (a LedgerFailure: the
 * retry writes nothing and its earlier account reads as unknown) instead of answering with part of the rows.
 */
const LIST_MAX = 5000;
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
  /**
   * Whether retention retired this id (pds.chat_retired_requests, written by pds.chat_ledger_purge in the same
   * transaction as the delete). A missing marker table means the marker-writing purge is not applied either, so
   * nothing was retired by it: false, as before the table existed. Any other read error fails closed.
   */
  const retired = async (owner_id: string, request_id: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from("chat_retired_requests")
      .select("request_id")
      .eq("owner_id", owner_id)
      .eq("request_id", request_id)
      .maybeSingle();
    if (error) {
      if (typeof error.code === "string" && MISSING_CODES.has(error.code)) return false;
      fail(error);
    }
    return data !== null && data !== undefined;
  };
  return {
    async claimRequest(owner_id, request_id, conversation_sha, attempt_id, context) {
      // A retired id is refused before anything is written (Codex #817 CHAT795-1): its first try's writes may exist
      // under operation ids a new ledger row would not reuse, so running it as new could write them again.
      if (await retired(owner_id, request_id)) return "retired";
      // The context goes in with the row (one insert): a first try that stops right after it still leaves it pinned.
      const { error } = await requests().insert({
        owner_id, request_id, conversation_sha, lease_id: attempt_id, lease_until: leaseUntil(), context: context ?? null,
      });
      if (!error) {
        // The purge may have retired the old row between the check above and this insert (the insert then waited
        // for it and found the id free). The marker commits with the delete, so it is visible now: take the new row
        // back and refuse. Our row holds a live lease, so no later purge removes it in between.
        if (!(await retired(owner_id, request_id))) return "new";
        const undo = await requests().delete().eq("owner_id", owner_id).eq("request_id", request_id).eq("lease_id", attempt_id);
        if (undo.error) fail(undo.error);
        return "retired";
      }
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

    async requestContext(owner_id, request_id) {
      const { data, error } = await requests().select("context").eq("owner_id", owner_id).eq("request_id", request_id).maybeSingle();
      if (error) fail(error);
      if (!data) fail({ code: "missing_request" });
      return asObject((data as { context?: unknown }).context);
    },

    async getRequest(owner_id, request_id) {
      const { data, error } = await requests().select("lease_until").eq("owner_id", owner_id).eq("request_id", request_id).maybeSingle();
      if (error) fail(error);
      if (!data) return null;
      const until = (data as { lease_until?: unknown }).lease_until;
      return { lease_until: typeof until === "string" ? until : null };
    },

    async abandonRequest(owner_id, request_id) {
      // No lease: nothing runs under an abandoned id. A lost answer to this insert is a failure (the page keeps the
      // id); the next check then finds the row (settled, nothing saved).
      const { error } = await requests().insert({ owner_id, request_id, conversation_sha: ABANDONED_CONVERSATION_SHA });
      if (!error) return "abandoned";
      if (error.code !== "23505") fail(error);
      const { data, error: readError } = await requests()
        .select("conversation_sha")
        .eq("owner_id", owner_id)
        .eq("request_id", request_id)
        .maybeSingle();
      if (readError) fail(readError);
      if (!data) fail({ code: "missing_after_conflict" });
      return (data as { conversation_sha?: unknown }).conversation_sha === ABANDONED_CONVERSATION_SHA ? "abandoned" : "exists";
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
      // Every row of the request, never the first N: a row left out could be the one that wrote, and a retry that
      // misses it would treat the request as "nothing written" and run new writes next to it. Read page by page in a
      // total order (op_id breaks ties), advancing by the rows actually returned (a PostgREST max-rows cap smaller
      // than the page cannot skip any), and checked against the exact count: short of it = fail closed.
      const out: OperationRow[] = [];
      const seen = new Set<string>();
      for (let from = 0; ; ) {
        const { data, error, count } = await ops()
          .select(OP_COLS, { count: "exact" })
          .eq("owner_id", owner_id)
          .eq("request_id", request_id)
          .order("created_at", { ascending: true })
          .order("ordinal", { ascending: true })
          .order("op_id", { ascending: true })
          .range(from, from + LIST_PAGE - 1);
        if (error) fail(error);
        if (typeof count !== "number") fail({ code: "list_count_missing" });
        const page = (data ?? []) as OperationRow[];
        // A row inserted meanwhile ahead of this page shifts the rest: they are read twice (kept once), never skipped,
        // and the new row itself is then short of the count, which fails closed.
        for (const row of page) {
          if (seen.has(row.op_id)) continue;
          seen.add(row.op_id);
          out.push(row);
        }
        if (out.length >= count) return out;
        if (page.length === 0) fail({ code: "list_incomplete" });
        from += page.length;
        if (from >= LIST_MAX) fail({ code: "list_too_long" });
      }
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
 * A quiz result is not here: it is re-run under its op_key (RERUN_SAFE), never matched by book, checkpoint, score
 * or time (a match like that could take a later attempt for this one).
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
