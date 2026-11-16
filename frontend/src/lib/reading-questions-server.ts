import type { SupabaseClient } from "@supabase/supabase-js";
import { getBook } from "@/lib/reading";
import { rpcFailure, type RpcAnswer } from "@/lib/reading-practice";
import { questionRpcArgs, type QuestionOp } from "@/lib/reading-questions";

/**
 * Reading learning questions, server side (GET / POST /api/reading/questions). The client MUST be the
 * service-role client scoped to schema "pds".
 *
 * Every write is ONE call of pds.reading_question_apply (sql/reading_learning_questions.sql): one transaction under
 * the practice lock, replay safe, no fallback (a missing function is 503 practice_unavailable). Reads are ONE call of
 * pds.reading_questions_export. Errors are codes only; no prompt, answer or feedback text is ever logged.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export type QuestionsAnswer = { status: number; body: Record<string, unknown> };

/**
 * The book an answer key's stored attempt was given for (null = nothing is stored under this key). The attempt names
 * the exact question version it answered, and a question keeps its book across versions. A failed read is a failure,
 * never "no attempt": guessing the active book instead could turn the retry of a stored answer into 409 key_reused.
 */
async function answerReceiptBook(supabase: Supa, attemptKey: string): Promise<{ book_id: number | null } | QuestionsAnswer> {
  const failure = (error: { code?: string }): QuestionsAnswer => {
    const f = rpcFailure(null, error)!;
    return { status: f.status, body: { error: f.error } };
  };
  const a = await supabase.from("reading_question_attempts").select("question_id").eq("attempt_key", attemptKey).maybeSingle();
  if (a.error) return failure(a.error);
  const questionId = Number((a.data as { question_id?: unknown } | null)?.question_id);
  if (!Number.isInteger(questionId) || questionId <= 0) return { book_id: null };
  const q = await supabase.from("reading_questions").select("book_id").eq("question_id", questionId).maybeSingle();
  if (q.error) return failure(q.error);
  const id = Number((q.data as { book_id?: unknown } | null)?.book_id);
  // The foreign key makes a missing question impossible; if the read still finds none, fail (retry with the same key)
  // rather than guess a book.
  return Number.isInteger(id) && id > 0 ? { book_id: id } : { status: 500, body: { error: "failed" } };
}

export async function applyQuestionOp(supabase: Supa, op: QuestionOp): Promise<QuestionsAnswer> {
  try {
    let bookId: number | null = null;
    if (op.op === "answer") {
      // An answer key that already stored an attempt is bound to that attempt's book. With no book named, its retry
      // (the answer was lost, then the active book changed) uses THAT book, so it answers the stored attempt instead
      // of 409 key_reused or 404. A named book is part of the request and is resolved as given.
      if (op.book == null) {
        const bound = await answerReceiptBook(supabase, op.op_key);
        if ("status" in bound) return bound;
        bookId = bound.book_id;
      }
      if (bookId == null) {
        const book = await getBook(supabase, op.book);
        if (!book) return { status: 404, body: { error: "book_not_found" } };
        bookId = book.book_id;
      }
    }
    const { data, error } = await supabase.rpc("reading_question_apply", { p: questionRpcArgs(op, bookId) });
    const failed = rpcFailure(data as RpcAnswer | null, error);
    if (failed) {
      const extra = (data as RpcAnswer | null)?.version;
      return { status: failed.status, body: { error: failed.error, ...(typeof extra === "number" ? { version: extra } : {}) } };
    }
    const rest: Record<string, unknown> = { ...(data as RpcAnswer) };
    delete rest.ok;
    delete rest.http;
    delete rest.code;
    return { status: 200, body: { success: true, ...rest } };
  } catch {
    return { status: 500, body: { error: "failed" } };
  }
}

/** GET: every question version (with its source status now) and every attempt of one book. Read only. */
export async function exportQuestions(supabase: Supa, slug: string | null): Promise<QuestionsAnswer> {
  try {
    const book = await getBook(supabase, slug);
    if (!book) return { status: 404, body: { error: "book_not_found" } };
    const { data, error } = await supabase.rpc("reading_questions_export", { p_book: book.book_id });
    if (error) {
      const failed = rpcFailure(null, error)!;
      return { status: failed.status, body: { error: failed.error } };
    }
    const d = (data ?? {}) as { questions?: unknown[]; attempts?: unknown[] };
    return {
      status: 200,
      body: { book: { slug: book.slug, title: book.title }, questions: d.questions ?? [], attempts: d.attempts ?? [] },
    };
  } catch {
    return { status: 500, body: { error: "failed" } };
  }
}
