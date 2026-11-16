/**
 * Reading learning questions (PROD-T07): question versions with their permitted source, and attempt receipts.
 *
 * Import-free (the route, lib/reading.ts and the tests use it). Storage and every rule that needs the database live
 * in sql/reading_learning_questions.sql (pds.reading_question_apply / pds.reading_questions_export):
 *
 * - A question has a stable `question_key` and numbered versions. Each version records its prompt, an optional
 *   rubric, its source (a highlight, a session's recall note, or a chapter of the same book; nothing else is
 *   permitted) and a sha-256 of that source's text, computed by the database when the version is written.
 * - An answer is an attempt keyed by the client's UUID: the same key and answer replays, another answer under that
 *   key is 409 key_reused. Grading is a separate step (pending -> graded), so a stored answer whose grading never
 *   finished stays visible as pending.
 * - A correction makes a new version, supersedes the old one and, when the prompt, rubric or source reference
 *   changed (or `invalidate: true` says so), invalidates the answers given to older versions (kept, with the reason);
 *   a quiz result that counted one of them is shown as corrected and not counted. An edit of the source's TEXT alone
 *   (a highlight comment, a recall note) makes the next version when the question is next answered and invalidates
 *   nothing: those answers were graded against their own version, whose source hash is kept.
 * - A quiz result recorded under op_key K is checked against the answers given with quiz_key K; results without
 *   such answers (all results stored before 2026-11-16) are unverifiable.
 *
 * Raw answers are private: the only reader is GET /api/reading/questions (owner session, no-store), whose key the
 * client cache keeps in memory only (lib/client-cache.ts isSensitiveKey).
 */

/**
 * Fits every valid request whatever the text: each text field is limited in characters BEFORE trimming, and JSON
 * takes at most 6 bytes per character (a six-character \uXXXX escape), so the largest operation, an answer (prompt +
 * rubric + answer = 7000 characters, 42000 bytes, plus keys and ids), stays under 48 KB.
 */
export const QUESTIONS_MAX_BODY_BYTES = 48 * 1024;
export const PROMPT_MAX = 1000;
export const RUBRIC_MAX = 2000;
export const ANSWER_MAX = 4000;
export const FEEDBACK_MAX = 2000;
export const REASON_MAX = 500;

export type SourceKind = "highlight" | "session" | "chapter";
export const SOURCE_KINDS: readonly SourceKind[] = ["highlight", "session", "chapter"];
export type Grader = "model" | "self";

export type QuestionOp =
  | {
      op: "answer";
      /** The attempt's key (one per answer, kept by the client until a definite answer). */
      op_key: string;
      book: string | null;
      question_key: string;
      prompt: string;
      rubric: string | null;
      source_kind: SourceKind;
      source_ref: number;
      answer: string;
      /** The op_key the quiz result will be recorded under, when this answer is part of a checkpoint quiz. */
      quiz_key: string | null;
    }
  | { op: "grade"; attempt_key: string; correct: boolean; grader: Grader; feedback: string | null }
  | {
      op: "correct";
      op_key: string;
      question_key: string;
      expected_version: number;
      prompt: string;
      rubric: string | null;
      source_kind: SourceKind;
      source_ref: number;
      reason: string;
      /**
       * Whether the answers to older versions stop counting. null = the default: yes when the prompt, rubric or
       * source reference changes, no when only the source's text moved.
       */
      invalidate: boolean | null;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null | undefined => {
  if (v == null) return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  return v.trim() || null;
};

const KEYS: Record<QuestionOp["op"], Set<string>> = {
  answer: new Set(["op", "op_key", "book", "question_key", "prompt", "rubric", "source_kind", "source_ref", "answer", "quiz_key"]),
  grade: new Set(["op", "attempt_key", "correct", "grader", "feedback"]),
  correct: new Set(["op", "op_key", "question_key", "expected_version", "prompt", "rubric", "source_kind", "source_ref", "reason", "invalidate"]),
};

function questionFields(raw: Record<string, unknown>) {
  const question_key = uuid(raw.question_key);
  const prompt = text(raw.prompt, PROMPT_MAX);
  const rubric = text(raw.rubric, RUBRIC_MAX);
  const source_kind = SOURCE_KINDS.includes(raw.source_kind as SourceKind) ? (raw.source_kind as SourceKind) : null;
  const ref = raw.source_ref;
  const source_ref = typeof ref === "number" && Number.isInteger(ref) && ref >= 0 && ref <= Number.MAX_SAFE_INTEGER ? ref : null;
  if (!question_key || !prompt || rubric === undefined || !source_kind || source_ref === null) return null;
  return { question_key, prompt, rubric, source_kind, source_ref };
}

/** POST /api/reading/questions body: one operation. Unknown fields are refused. */
export function parseQuestionOp(raw: unknown): { ok: true; op: QuestionOp } | { ok: false; error: string } {
  if (!plainObject(raw) || typeof raw.op !== "string" || !(raw.op in KEYS)) return { ok: false, error: "bad_request" };
  const kind = raw.op as QuestionOp["op"];
  for (const k of Object.keys(raw)) if (!KEYS[kind].has(k)) return { ok: false, error: "bad_request" };

  if (kind === "grade") {
    const attempt_key = uuid(raw.attempt_key);
    const feedback = text(raw.feedback, FEEDBACK_MAX);
    if (!attempt_key || typeof raw.correct !== "boolean" || (raw.grader !== "model" && raw.grader !== "self") || feedback === undefined) {
      return { ok: false, error: "bad_request" };
    }
    return { ok: true, op: { op: "grade", attempt_key, correct: raw.correct, grader: raw.grader, feedback } };
  }

  const op_key = uuid(raw.op_key);
  const q = questionFields(raw);
  if (!op_key || !q) return { ok: false, error: "bad_request" };

  if (kind === "answer") {
    if (raw.book != null && (typeof raw.book !== "string" || !/^[a-z0-9-]{1,80}$/.test(raw.book))) return { ok: false, error: "bad_book" };
    // The answer is kept as typed (no trim): it is a primary record of what was said.
    if (typeof raw.answer !== "string" || !raw.answer.trim() || raw.answer.length > ANSWER_MAX) return { ok: false, error: "bad_answer" };
    const quiz_key = raw.quiz_key == null ? null : uuid(raw.quiz_key);
    if (raw.quiz_key != null && !quiz_key) return { ok: false, error: "bad_request" };
    return { ok: true, op: { op: "answer", op_key, book: (raw.book as string | undefined) || null, ...q, answer: raw.answer, quiz_key } };
  }

  const reason = text(raw.reason, REASON_MAX);
  const v = raw.expected_version;
  if (!reason || typeof v !== "number" || !Number.isInteger(v) || v < 1) return { ok: false, error: "bad_request" };
  if (raw.invalidate != null && typeof raw.invalidate !== "boolean") return { ok: false, error: "bad_request" };
  const invalidate = typeof raw.invalidate === "boolean" ? raw.invalidate : null;
  return { ok: true, op: { op: "correct", op_key, ...q, expected_version: v, reason, invalidate } };
}

/** The function's argument for one parsed operation (pure). `bookId` is resolved by the server for answers. */
export function questionRpcArgs(op: QuestionOp, bookId: number | null): Record<string, unknown> {
  if (op.op === "grade") {
    return { kind: "grade", op_key: op.attempt_key, correct: op.correct, grader: op.grader, feedback: op.feedback };
  }
  const base = {
    kind: op.op,
    op_key: op.op_key,
    question_key: op.question_key,
    prompt: op.prompt,
    rubric: op.rubric,
    source_kind: op.source_kind,
    source_ref: op.source_ref,
  };
  if (op.op === "answer") return { ...base, book_id: bookId, answer: op.answer, quiz_key: op.quiz_key };
  return { ...base, expected_version: op.expected_version, reason: op.reason, invalidate: op.invalidate };
}

/* ------------------------------------------------------------------ */
/* Quiz results                                                         */
/* ------------------------------------------------------------------ */

export type QuizVerification = "unverified" | "verified" | "invalidated";

/**
 * unverified: recorded without per-question answers (every result stored before 2026-11-16, and any result the chat
 * records without them); verified: checked against graded answers when recorded; invalidated: one of its questions
 * was corrected later. Invalidated results stay listed (shown as corrected) and earn no XP.
 */
export function quizVerification(q: { question_count?: number | null; invalidated_count?: number | null }): QuizVerification {
  if (q.question_count == null) return "unverified";
  return (q.invalidated_count ?? 0) > 0 ? "invalidated" : "verified";
}
