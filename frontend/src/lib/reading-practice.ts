/**
 * Reading practice: review grades and checkpoint quiz results (PROD-T02 / PROD-T03).
 *
 * Import-free on purpose (no node or browser APIs): the routes, lib/reading.ts and the /reading review card all use
 * it, and the tests run it in plain node.
 *
 * Every grade and every quiz result is ONE operation with a UUID `op_key`. The server applies it in one database
 * call (pds.reading_grade_review / pds.reading_record_quiz, sql/reading_practice_receipts.sql) that writes the row,
 * the schedule and an operation receipt together; the same key with the same request answers that receipt again
 * (`replayed`), the same key with another request is refused (`key_reused`). The review card keeps one key per card
 * until it hears a definite answer, so a retry after a lost answer never grades twice.
 */

export type PracticeGrade = "again" | "good" | "easy";
export const PRACTICE_GRADES: readonly PracticeGrade[] = ["again", "good", "easy"];

/** Request caps (the routes also refuse a larger body before reading it). */
export const PRACTICE_MAX_BODY_BYTES = 8 * 1024;
export const QUIZ_CHECKPOINT_MAX = 40;
/**
 * Fits inside PRACTICE_MAX_BODY_BYTES whatever the text: JSON takes at most 6 bytes per character (a six-character
 * escape), so a valid note is answered bad_notes or stored, never 413.
 */
export const QUIZ_NOTES_MAX = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOpKey = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** A random operation key (browser and Node 19+ both have crypto.randomUUID). */
export function newOpKey(): string {
  return globalThis.crypto.randomUUID();
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* Scheduling (shared by the commit and the on-screen previews)         */
/* ------------------------------------------------------------------ */

export function addDaysYmd(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleState {
  ease: number | string;
  interval_days: number;
  review_count: number;
}

export interface Schedule {
  ease: number;
  interval_days: number;
  next_review: string;
  last_reviewed: string;
  review_count: number;
}

/**
 * SM-2 lite. again: interval 1 day, ease -0.2 (floor 1.3). good: first review 1 day, then 3 days, then
 * interval x ease. easy: first review 3 days, then interval x ease x 1.3, ease +0.15 (cap 3.0). Interval 1..365.
 * The ONE scheduler: the server commits exactly this, and the review card's previews are computed with it.
 */
export function scheduleAfterGrade(h: ScheduleState, grade: PracticeGrade, today: string): Schedule {
  let ease = Number(h.ease) || 2.5;
  let interval = h.interval_days || 0;
  if (grade === "again") {
    ease = Math.max(1.3, ease - 0.2);
    interval = 1;
  } else if (grade === "good") {
    interval = interval === 0 ? 1 : interval === 1 ? 3 : Math.round(interval * ease);
  } else {
    ease = Math.min(3.0, ease + 0.15);
    interval = interval === 0 ? 3 : Math.round(interval * ease * 1.3);
  }
  interval = Math.max(1, Math.min(interval, 365));
  return {
    ease: Math.round(ease * 100) / 100,
    interval_days: interval,
    next_review: addDaysYmd(today, interval),
    last_reviewed: today,
    review_count: (h.review_count ?? 0) + 1,
  };
}

/** What each grade would schedule for this card today (the labels under the grade buttons). */
export function reviewPreview(h: ScheduleState, today: string): Record<PracticeGrade, Schedule> {
  return {
    again: scheduleAfterGrade(h, "again", today),
    good: scheduleAfterGrade(h, "good", today),
    easy: scheduleAfterGrade(h, "easy", today),
  };
}

/** "1 day", "3 days", "in 2 months" style text for an interval. */
export function intervalLabel(days: number): string {
  if (days === 1) return "1 day";
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30);
  return `${months} months`;
}

export const GRADE_LABEL: Record<PracticeGrade, string> = { again: "Again", good: "Good", easy: "Easy" };

/* ------------------------------------------------------------------ */
/* Request parsing                                                      */
/* ------------------------------------------------------------------ */

export interface ReviewRequest {
  highlight_id: number;
  grade: PracticeGrade;
  /** Absent from an older page: the server makes one (atomic, but a retry of that page is not recognised). */
  op_key: string | null;
  /** The review count of the card on screen: another grade in between answers 409 changed instead of stacking. */
  expected_review_count: number | null;
}

const REVIEW_KEYS = new Set(["highlight_id", "grade", "op_key", "expected_review_count"]);

export function parseReviewBody(raw: unknown): { ok: true; input: ReviewRequest } | { ok: false; error: string } {
  if (!plainObject(raw)) return { ok: false, error: "bad_request" };
  for (const k of Object.keys(raw)) if (!REVIEW_KEYS.has(k)) return { ok: false, error: "bad_request" };
  if (!isInt(raw.highlight_id, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, error: "bad_highlight" };
  if (!PRACTICE_GRADES.includes(raw.grade as PracticeGrade)) return { ok: false, error: "bad_grade" };
  if (raw.op_key != null && !isOpKey(raw.op_key)) return { ok: false, error: "bad_op_key" };
  if (raw.expected_review_count != null && !isInt(raw.expected_review_count, 0, 1_000_000)) return { ok: false, error: "bad_request" };
  return {
    ok: true,
    input: {
      highlight_id: raw.highlight_id,
      grade: raw.grade as PracticeGrade,
      op_key: (raw.op_key as string | undefined)?.toLowerCase() ?? null,
      expected_review_count: (raw.expected_review_count as number | undefined) ?? null,
    },
  };
}

export interface QuizRequest {
  slug: string | null;
  checkpoint: string;
  score: number;
  total: number;
  notes: string | null;
  op_key: string | null;
}

const QUIZ_KEYS = new Set(["book", "checkpoint", "score", "total", "notes", "op_key"]);

/** POST /api/reading/quiz body. Numbers must be whole; the quiz key is optional (chat, older pages). */
export function parseQuizBody(raw: unknown): { ok: true; input: QuizRequest } | { ok: false; error: string } {
  if (!plainObject(raw)) return { ok: false, error: "bad_request" };
  for (const k of Object.keys(raw)) if (!QUIZ_KEYS.has(k)) return { ok: false, error: "bad_request" };
  if (raw.book != null && (typeof raw.book !== "string" || !/^[a-z0-9-]{1,80}$/.test(raw.book))) return { ok: false, error: "bad_book" };
  const checkpoint = typeof raw.checkpoint === "string" ? raw.checkpoint.trim() : "";
  if (!checkpoint || checkpoint.length > QUIZ_CHECKPOINT_MAX) return { ok: false, error: "bad_checkpoint" };
  if (!isInt(raw.total, 1, 1000) || !isInt(raw.score, 0, 1000) || raw.score > raw.total) return { ok: false, error: "bad_score" };
  if (raw.notes != null && (typeof raw.notes !== "string" || raw.notes.length > QUIZ_NOTES_MAX)) return { ok: false, error: "bad_notes" };
  if (raw.op_key != null && !isOpKey(raw.op_key)) return { ok: false, error: "bad_op_key" };
  return {
    ok: true,
    input: {
      slug: (raw.book as string | undefined) || null,
      checkpoint,
      score: raw.score,
      total: raw.total,
      notes: (raw.notes as string | undefined)?.trim() || null,
      op_key: (raw.op_key as string | undefined)?.toLowerCase() ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Database answers                                                     */
/* ------------------------------------------------------------------ */

/** A missing table / column / function (the migration is not applied): codes only, never message text. */
export function isMissingSchema(error: { code?: string } | null | undefined): boolean {
  return !!error && ["42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(String(error.code));
}

/** The JSON the two functions answer: {ok: true, ...receipt, replayed} or {ok: false, http, code}. */
export interface RpcAnswer {
  ok?: boolean;
  http?: number;
  code?: string;
  replayed?: boolean;
  [k: string]: unknown;
}

export type PracticeFailure = { ok: false; status: number; error: string };

/** Map an RPC call's result to a failure, or null when it applied (or replayed). No fallback write exists. */
export function rpcFailure(data: RpcAnswer | null | undefined, error: { code?: string } | null | undefined): PracticeFailure | null {
  if (error) {
    // A quiz result checked against its per-question answers (sql/reading_learning_questions.sql trigger).
    if (error.code === "OXQ01") return { ok: false, status: 409, error: "attempts_pending" };
    if (error.code === "OXQ02") return { ok: false, status: 409, error: "score_mismatch" };
    if (error.code === "OXQ03") return { ok: false, status: 409, error: "quiz_other_book" };
    return isMissingSchema(error) ? { ok: false, status: 503, error: "practice_unavailable" } : { ok: false, status: 500, error: "failed" };
  }
  if (!data || typeof data !== "object") return { ok: false, status: 500, error: "failed" };
  if (data.ok === true) return null;
  const status = Number.isInteger(data.http) && (data.http as number) >= 400 && (data.http as number) < 600 ? (data.http as number) : 500;
  return { ok: false, status, error: typeof data.code === "string" ? data.code : "failed" };
}

/**
 * Whether a failed grade / quiz call may still have been stored. Every 4xx and the 503 (functions not applied) wrote
 * nothing: the functions refuse before writing, and a trigger refusal rolls the whole call back. A 500 is a database
 * error or an answer that never arrived (supabase-js reports a lost response as an error), so the write may have
 * committed: a caller must not report it as "not recorded" and must retry only with the same op_key.
 */
export function failureMayHaveWritten(f: { status: number }): boolean {
  return f.status >= 500 && f.status !== 503;
}

/* ------------------------------------------------------------------ */
/* Review card state (client)                                           */
/* ------------------------------------------------------------------ */

/** One grade request the card sent or will send. The key stays with the card until a definite answer. */
export interface ReviewAttempt {
  op_key: string;
  highlight_id: number;
  grade: PracticeGrade;
  expected_review_count: number;
}

export type ReviewOutcome =
  /** Stored (or stored earlier under this key): advance once. */
  | { kind: "saved"; xp: number; replayed: boolean; earlier: boolean }
  /**
   * No answer, or the server failed: the grade may or may not be stored (a grade that committed and lost its answer
   * lands here too), so the card says "Save not confirmed", never "Not saved". Retry sends the same key.
   */
  | { kind: "unknown"; message: string }
  /** The server refused it: nothing was written ("Not saved"); any grade can be picked again (a new key). */
  | { kind: "refused"; message: string }
  /** The card changed elsewhere (graded on another screen, archived, gone): "Card out of date", refresh first. */
  | { kind: "stale"; message: string };

/** The alert heading for each failed outcome: only a proven refusal says "Not saved". */
export const REVIEW_ALERT_HEADING: Record<"unknown" | "refused" | "stale", string> = {
  unknown: "Save not confirmed",
  refused: "Not saved",
  stale: "Card out of date",
};

/**
 * Classify the review route's answer. `status` null = no answer at all (offline, timeout, reload). 409 key_reused
 * means this card's key already stored a grade (an earlier try whose answer was lost, then a different grade):
 * the card is graded, so it advances, and the overview reload shows which grade it was.
 *
 * `retryOfUnconfirmed`: this request reused the key of an earlier try whose answer never came. A refusal of it
 * (session, origin, size, rate limit: all answered before the receipt is looked up) proves nothing about that
 * earlier try, which may have been stored, so the card stays "Save not confirmed" and keeps the key; only the
 * receipt (a later Retry) settles it. A 409 / 404 stays definitive: the function looks the receipt up first, so it
 * means no grade is stored under this key.
 */
export function classifyReviewAnswer(status: number | null, body: unknown, retryOfUnconfirmed = false): ReviewOutcome {
  const b = (plainObject(body) ? body : {}) as Record<string, unknown>;
  if (status === null) return { kind: "unknown", message: "No answer from Onyx, so this grade may or may not be stored." };
  if (status >= 200 && status < 300 && b.success === true) {
    return { kind: "saved", xp: Number(b.xp_gained) || 0, replayed: b.replayed === true, earlier: false };
  }
  const code = typeof b.error === "string" ? b.error : "";
  if (status === 409 && code === "key_reused") return { kind: "saved", xp: 0, replayed: true, earlier: true };
  if (status === 409 || status === 404) {
    return { kind: "stale", message: code === "archived" ? "This highlight was removed." : status === 404 ? "This highlight no longer exists." : "This highlight was graded on another screen." };
  }
  if (status === 503) return { kind: "unknown", message: "Reviews are unavailable right now." };
  if (status >= 400 && status < 500) {
    if (retryOfUnconfirmed) return { kind: "unknown", message: "Onyx refused this retry, so the earlier try is still unconfirmed." };
    return { kind: "refused", message: "Onyx refused this grade." };
  }
  return { kind: "unknown", message: "Onyx answered with an error before confirming the grade." };
}

/**
 * The request for a tap on `grade`: the same key as the last unconfirmed try of this card (whatever grade it had),
 * or a new key. Reusing the key is what makes a retry after a lost answer safe: the server answers the stored
 * receipt (same grade) or key_reused (another grade was stored first).
 */
export function attemptFor(
  pending: ReviewAttempt | null,
  card: { highlight_id: number; review_count: number },
  grade: PracticeGrade,
  makeKey: () => string = newOpKey,
): ReviewAttempt {
  const reuse = pending && pending.highlight_id === card.highlight_id && pending.expected_review_count === card.review_count;
  return {
    op_key: reuse ? pending!.op_key : makeKey(),
    highlight_id: card.highlight_id,
    grade,
    expected_review_count: card.review_count,
  };
}

/** The cards still to grade: the overview's due list minus the cards this screen already graded. */
export function remainingQueue<T extends { highlight_id: number }>(due: T[], graded: ReadonlySet<number>): T[] {
  return due.filter((h) => !graded.has(h.highlight_id));
}
