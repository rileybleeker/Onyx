import type { SupabaseClient } from "@supabase/supabase-js";
import { bankCode } from "./reading-bank";
import { isMissingSchema } from "./reading-practice";

/**
 * The finish of a queue job (pds.reading_bank_finish): what the database answered and what the job's own row shows.
 * Shared by the generation worker (lib/reading-bank-server.ts JobRun.finish) and the grade job
 * (lib/reading-recall-server.ts runGradeJob), so both report the QUEUE's state the same way: the status the database
 * stored (a retry at the third attempt is failed), and, when the answer is lost (the reply can be lost after the
 * commit), a readback of the row bound to the claim's fence (job_id, attempts AND claim_seq) that says recorded, not
 * recorded or unknown. No `server-only` marker and no text from a book, an answer or a question: codes and numbers.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export type FinishOutcome = "done" | "retry" | "failed" | "skipped";

/**
 * One pds.reading_bank_finish call as it was sent (sql/reading_question_bank.sql: `p`). The fence is the claim's own
 * numbers; `outcome` is what the SQL was asked to record (not necessarily what the caller reports: a grade job that
 * is no longer pending is reported skipped and sent done), and `error_code` is stored as sent.
 */
export interface FinishSent {
  job_id: number;
  attempts: number;
  claim_seq: number;
  outcome: FinishOutcome;
  cost_cents: number;
  error_code: string | null;
}

/** The refusals to spend that give a retry back without using up its try, when nothing was billed (the SQL's v_defer). */
const FINISH_DEFER_CODES: ReadonlySet<string> = new Set(["cost_limit", "monthly_cap", "budget", "paused"]);

/**
 * Whether pds.reading_bank_finish treats this call as a deferral: a retry with a refusal-to-spend code and a cost of
 * 0 is queued again and the try is given back (attempts goes down by one). Mirrors the SQL; the readback below uses
 * it to know which attempts number the row must carry after the call committed.
 */
export function finishDefers(sent: Pick<FinishSent, "outcome" | "cost_cents" | "error_code">): boolean {
  return sent.outcome === "retry" && Number(sent.cost_cents ?? 0) === 0 && FINISH_DEFER_CODES.has(sent.error_code ?? "");
}

/**
 * The queue state a finish the database ACCEPTED left, as an outcome. pds.reading_bank_finish answers `{ok: true,
 * status}` with the status it stored: done, failed and skipped are stored as requested, and a retry as queued, or as
 * failed once the job is at its third attempt (the same rule the claim applies to an expired lease), so a worker that
 * reports "retry" for that answer reports a job that will never be claimed again as one that will. Returns null when
 * `status` is none of the states `requested` can produce (missing, or another job's state): the caller then reads the
 * job's row back, or reports the outcome as unconfirmed, and never guesses.
 */
export function reconcileFinishStatus(requested: FinishOutcome, status: unknown): FinishOutcome | null {
  if (requested === "retry") return status === "queued" ? "retry" : status === "failed" ? "failed" : null;
  return status === requested ? requested : null;
}

/** The job columns a fenced readback needs. */
export const FINISH_READBACK_COLUMNS = "job_id,status,attempts,claim_seq,error_code";

/**
 * What the job's own row says about a finish whose answer did not arrive (a transport error, a database error
 * answer, a reply that was lost after the commit):
 * - recorded: the row shows exactly what that call would have stored, under the same fence (`outcome` is the queue
 *   state, as reconcileFinishStatus gives it);
 * - not_recorded: the row shows the job still running under the same fence (the call had not committed when the row
 *   was read; the lease may still run out and the next claim settles it), or settled by the claim for an expired lease
 *   under that fence (the call can no longer commit: the settlement only touches a running job);
 * - unknown: anything else, above all a row that no longer carries the same fence (the job was claimed again, so
 *   whether the call committed before that cannot be told), a row that was not read, or one that cannot be told from
 *   a lease settlement. Callers keep it as unknown and never count it as recorded.
 */
export type FinishReadback = { state: "recorded"; outcome: FinishOutcome } | { state: "not_recorded" } | { state: "unknown" };

/** An integer column as PostgREST returns it (a number, or a string for a bigint past 2^53); NaN for anything else, null included. */
const intCol = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : Number.NaN);

/**
 * Judge a job row read back after an ambiguous finish. The row must match the call on job_id, attempts AND claim_seq:
 * attempts alone is not a fence (a re-queue resets it, a deferral lowers it by one), and job_id alone says nothing
 * about which claim the row belongs to. After a deferral the row carries one attempt fewer than the call did (the SQL
 * gives the try back); every other finish leaves attempts as it was.
 */
export function judgeFinishReadback(row: unknown, sent: FinishSent): FinishReadback {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { state: "unknown" };
  const r = row as Record<string, unknown>;
  const jobId = intCol(r.job_id);
  const attempts = intCol(r.attempts);
  const seq = intCol(r.claim_seq);
  if (!Number.isInteger(jobId) || !Number.isInteger(attempts) || !Number.isInteger(seq) || typeof r.status !== "string") return { state: "unknown" };
  // Another claim since (or another job): the call may have committed before it, or never have, and the row cannot say.
  if (jobId !== sent.job_id || seq !== sent.claim_seq) return { state: "unknown" };
  const code = r.error_code == null ? null : String(r.error_code);
  if (r.status === "running") return attempts === sent.attempts ? { state: "not_recorded" } : { state: "unknown" };
  // A lease settlement writes lease_expired; a call that sent that very code cannot be told from it.
  if (sent.error_code === "lease_expired") return { state: "unknown" };
  if (code === "lease_expired") return attempts === sent.attempts ? { state: "not_recorded" } : { state: "unknown" };
  const wantAttempts = finishDefers(sent) ? Math.max(sent.attempts - 1, 0) : sent.attempts;
  if (attempts !== wantAttempts || code !== (sent.error_code ?? null)) return { state: "unknown" };
  const outcome = reconcileFinishStatus(sent.outcome, r.status);
  return outcome ? { state: "recorded", outcome } : { state: "unknown" };
}

/**
 * What the database said to one pds.reading_bank_finish call:
 * - recorded: `{ok: true, status}`; `status` is the queue state it stored, as the answer carried it;
 * - refused: `{ok: false, code}` (not_running, lease_lost, bad_request, ...) or a missing function: nothing was
 *   written, and the call cannot commit later;
 * - ambiguous: a database error answer, a thrown call (a transport error) or an answer that is not an object: the
 *   call may have committed, and the reply may be what was lost.
 */
export type FinishAnswer =
  | { kind: "recorded"; status: unknown }
  | { kind: "refused"; code: string }
  | { kind: "ambiguous" };

/** One pds.reading_bank_finish call (`p` = FinishSent + usage, counts, output ...). Never throws. */
export async function sendFinish(supabase: Supa, p: object): Promise<FinishAnswer> {
  try {
    const { data, error } = await supabase.rpc("reading_bank_finish", { p });
    if (error) return isMissingSchema(error) ? { kind: "refused", code: "schema_missing" } : { kind: "ambiguous" };
    if (plainObject(data) && data.ok === true) return { kind: "recorded", status: data.status };
    if (plainObject(data) && data.ok === false) return { kind: "refused", code: typeof data.code === "string" ? bankCode(data.code) : "other" };
    return { kind: "ambiguous" };
  } catch {
    return { kind: "ambiguous" };
  }
}

/**
 * Read the job's own row back after an ambiguous finish and judge it against the call (judgeFinishReadback): it must
 * match on job_id, attempts AND claim_seq. The query is bound to the fence (a row of another claim is never returned)
 * and the row is judged again in code. A deferral lowers attempts by one, so for it attempts is left to the judge
 * (the row may still carry the claim's own number, or the lowered one). A failed read is unknown, never "not recorded".
 */
export async function readbackFinish(supabase: Supa, sent: FinishSent): Promise<FinishReadback> {
  try {
    let q = supabase.from("reading_bank_jobs").select(FINISH_READBACK_COLUMNS).eq("job_id", sent.job_id);
    if (!finishDefers(sent)) q = q.eq("attempts", sent.attempts);
    const { data, error } = await q.eq("claim_seq", sent.claim_seq).limit(1);
    if (error) return { state: "unknown" };
    return judgeFinishReadback(Array.isArray(data) ? data[0] : null, sent);
  } catch {
    return { state: "unknown" };
  }
}

/** What a finish came to once its answer (and, when it was not usable, the job's row) was read. */
export type FinishSettled =
  | { state: "recorded"; outcome: FinishOutcome }
  | { state: "not_recorded"; code: string }
  | { state: "unknown" };

/**
 * Turn the answer to a finish into what the queue holds: the state the database stored, reconciled with the status
 * it answered (a retry it stored as failed is failed), "not_recorded" with a code, or "unknown". A transport error
 * does not establish that the call never committed or that the lease is still running (the reply can be lost after
 * the commit), so an ambiguous answer, an `ok` answer whose status the requested outcome cannot produce, and (with
 * `earlierAmbiguous`: a first send of the same call had no answer) a refusal that says the job is no longer running
 * under this fence (not_running / lease_lost: the first send may be what stopped it) are all settled from a fenced
 * readback. Whatever the readback cannot establish stays unknown.
 */
export async function settleFinish(supabase: Supa, sent: FinishSent, answer: FinishAnswer, earlierAmbiguous = false): Promise<FinishSettled> {
  if (answer.kind === "recorded") {
    const outcome = reconcileFinishStatus(sent.outcome, answer.status);
    if (outcome) return { state: "recorded", outcome };
  } else if (answer.kind === "refused" && !(earlierAmbiguous && (answer.code === "not_running" || answer.code === "lease_lost"))) {
    return { state: "not_recorded", code: answer.code };
  }
  const rb = await readbackFinish(supabase, sent);
  if (rb.state === "recorded") return { state: "recorded", outcome: rb.outcome };
  // An `ok` answer whose status cannot be read, next to a row that shows the job still running: contradictory, so unknown.
  if (rb.state === "not_recorded" && answer.kind !== "recorded") return { state: "not_recorded", code: answer.kind === "refused" ? answer.code : "finish_unrecorded" };
  return { state: "unknown" };
}
