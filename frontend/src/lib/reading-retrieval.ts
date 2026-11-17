/**
 * Sourced retrieval session on /reading (PROD-T08). Pure and import-free (the component and the tests use it).
 *
 * A session is voluntary, bounded and resumable. A card asks one question drawn from one permitted source (a
 * highlight, a session's recall note, a chapter: lib/reading-questions.ts). Riley answers from memory first; the
 * source and the rubric stay hidden until he answers or skips, then he judges his own answer against them
 * (self-grade: meaning counts, not wording). Storage is the PROD-T07 question / attempt tables through
 * /api/reading/questions; nothing here adds a table, XP or a notification.
 *
 * Delayed recall is measured from the first graded attempt of a question: a graded attempt 7 to 20 days after it is
 * a "7-day" recall, 21 days or more a "21-day" recall. It is reported on its own and never mixed with minutes, XP
 * or the same-day attempts. Attempts the server marked invalidated (a corrected question) and attempts still
 * waiting for a grade are never counted.
 */

export const SESSION_CARD_CAPS = [3, 5, 10] as const;
export const SESSION_MINUTE_CAPS = [5, 10, 15] as const;
/** A pause longer than this between two actions does not count as time spent (resume without penalty). */
export const ACTIVE_GAP_MS = 5 * 60 * 1000;
export const DELAY_DAYS = { seven: 7, twentyOne: 21 } as const;
export const PENDING_KEY = "onyx.reading.retrieval.pending";
export const SESSION_KEY = "onyx.reading.retrieval.session";

export type Bucket = "7" | "21";
export type SourceKind = "highlight" | "session" | "chapter";

export interface QuestionRow {
  question_id: number;
  question_key: string;
  version: number;
  prompt: string;
  rubric: string | null;
  source_kind: SourceKind;
  source_ref: number;
  source_status: "same" | "changed" | "removed";
  superseded_at: string | null;
}

export interface AttemptRow {
  attempt_key: string;
  question_id: number;
  attempt_date: string;
  answer: string | null;
  answered_at: string;
  grading_status: "pending" | "graded" | "invalidated";
  correct: boolean | null;
}

export interface HighlightLite {
  highlight_id: number;
  chapter: number | null;
  concept: string | null;
  passage: string;
  comment: string | null;
  archived?: boolean;
}

export interface SessionLite {
  session_id: number;
  recall: string | null;
}

export type Card =
  | { id: string; kind: "finish"; question: QuestionRow; attempt: AttemptRow }
  | { id: string; kind: "recall"; question: QuestionRow; bucket: Bucket }
  | { id: string; kind: "new"; highlight: HighlightLite; prompt: string };

/** Whole days from a to b (YYYY-MM-DD strings, UTC arithmetic so a DST change never moves a day). */
export function daysBetween(a: string, b: string): number {
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return Math.round((t(b) - t(a)) / 86400000);
}

/** The cue a new card starts with: it names where the idea came from but never quotes it. Riley can edit it. */
export function defaultPrompt(h: Pick<HighlightLite, "chapter" | "concept">): string {
  const where = h.chapter != null ? `chapter ${h.chapter}` : "this book";
  const topic = h.concept ? ` about ${h.concept}` : "";
  return `In ${where}, what was the point you highlighted${topic}? Say it in your own words.`;
}

function currentByKey(questions: QuestionRow[]): Map<string, QuestionRow> {
  const out = new Map<string, QuestionRow>();
  for (const q of questions) {
    if (q.superseded_at) continue;
    const prev = out.get(q.question_key);
    if (!prev || q.version > prev.version) out.set(q.question_key, q);
  }
  return out;
}

function keyOfQuestionId(questions: QuestionRow[]): Map<number, string> {
  return new Map(questions.map((q) => [q.question_id, q.question_key]));
}

/** Graded attempts per question key, oldest first. Invalidated and pending attempts are not in it. */
export function gradedByQuestion(questions: QuestionRow[], attempts: AttemptRow[]): Map<string, AttemptRow[]> {
  const keyOf = keyOfQuestionId(questions);
  const out = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    if (a.grading_status !== "graded" || a.correct == null) continue;
    const k = keyOf.get(a.question_id);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(a);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((x, y) => (x.attempt_date + x.answered_at).localeCompare(y.attempt_date + y.answered_at));
  return out;
}

/** Which delayed check a question is due for today (null = none): measured from its first graded attempt. */
export function dueBucket(graded: AttemptRow[], today: string): Bucket | null {
  if (!graded.length) return null;
  const first = graded[0].attempt_date;
  const gap = daysBetween(first, today);
  const gaps = graded.map((a) => daysBetween(first, a.attempt_date));
  if (gap >= DELAY_DAYS.twentyOne) return gaps.some((g) => g >= DELAY_DAYS.twentyOne) ? null : "21";
  if (gap >= DELAY_DAYS.seven) return gaps.some((g) => g >= DELAY_DAYS.seven && g < DELAY_DAYS.twentyOne) ? null : "7";
  return null;
}

export interface DeckInput {
  questions: QuestionRow[];
  attempts: AttemptRow[];
  highlights: HighlightLite[];
  today: string;
  /** Card ids skipped or finished in this session: never offered again in it. */
  taken?: ReadonlySet<string>;
}

/**
 * The cards on offer, in this order: answers stored but not graded yet, delayed checks that are due (21-day first,
 * oldest first), then new cards from highlights no question uses yet (oldest first). Questions whose source is gone
 * are left out.
 */
export function buildDeck(input: DeckInput): Card[] {
  const { questions, attempts, highlights, today } = input;
  const taken = input.taken ?? new Set<string>();
  const current = currentByKey(questions);
  const graded = gradedByQuestion(questions, attempts);
  const keyOf = keyOfQuestionId(questions);
  const finish: Card[] = [];
  const recall: Array<Card & { kind: "recall" }> = [];
  const nowAsked = new Set<string>();

  for (const a of attempts) {
    if (a.grading_status !== "pending") continue;
    const k = keyOf.get(a.question_id);
    const q = k ? current.get(k) : undefined;
    // Only an answer to the CURRENT version is finished; one to an older version was invalidated by the correction.
    const answered = questions.find((x) => x.question_id === a.question_id);
    if (!q || !answered || answered.question_id !== q.question_id || q.source_status === "removed") continue;
    nowAsked.add(q.question_key);
    finish.push({ id: `finish:${a.attempt_key}`, kind: "finish", question: q, attempt: a });
  }

  for (const q of current.values()) {
    if (q.source_status === "removed" || nowAsked.has(q.question_key)) continue;
    const bucket = dueBucket(graded.get(q.question_key) ?? [], today);
    if (bucket) recall.push({ id: `recall:${q.question_key}:${bucket}`, kind: "recall", question: q, bucket });
  }
  recall.sort((x, y) => {
    if (x.bucket !== y.bucket) return x.bucket === "21" ? -1 : 1;
    const fx = graded.get(x.question.question_key)?.[0]?.attempt_date ?? "";
    const fy = graded.get(y.question.question_key)?.[0]?.attempt_date ?? "";
    return fx.localeCompare(fy) || x.question.question_key.localeCompare(y.question.question_key);
  });

  const usedHighlights = new Set(questions.filter((q) => q.source_kind === "highlight").map((q) => q.source_ref));
  const fresh: Card[] = highlights
    .filter((h) => !h.archived && !usedHighlights.has(h.highlight_id) && (h.passage.trim() || (h.comment ?? "").trim()))
    .sort((x, y) => x.highlight_id - y.highlight_id)
    .map((h) => ({ id: `new:${h.highlight_id}`, kind: "new" as const, highlight: h, prompt: defaultPrompt(h) }));

  return [...finish, ...recall, ...fresh].filter((c) => !taken.has(c.id));
}

/** What the card's source says, shown only after an answer or a skip. */
export function sourceText(
  kind: SourceKind,
  ref: number,
  highlights: HighlightLite[],
  sessions: SessionLite[],
): string | null {
  if (kind === "highlight") {
    const h = highlights.find((x) => x.highlight_id === ref);
    if (!h) return null;
    return [h.passage.trim(), (h.comment ?? "").trim()].filter(Boolean).join("\n\nYour note: ");
  }
  if (kind === "session") return sessions.find((s) => s.session_id === ref)?.recall?.trim() || null;
  return `Chapter ${ref}`;
}

export interface Rate {
  n: number;
  correct: number;
}
export interface RecallReport {
  /** The first graded attempt of each question: how it went when it was new. */
  first: Rate;
  delayed7: Rate;
  delayed21: Rate;
  /** Answers saved but not graded yet. */
  pending: number;
  /** Answers that no longer count because their question was corrected. */
  invalidated: number;
}

const rate = (): Rate => ({ n: 0, correct: 0 });

/** Delayed recall, reported on its own. Minutes, XP and sessions are not inputs. */
export function recallReport(questions: QuestionRow[], attempts: AttemptRow[]): RecallReport {
  const graded = gradedByQuestion(questions, attempts);
  const out: RecallReport = { first: rate(), delayed7: rate(), delayed21: rate(), pending: 0, invalidated: 0 };
  for (const list of graded.values()) {
    const first = list[0].attempt_date;
    list.forEach((a, i) => {
      const bucket = i === 0 ? out.first : (() => {
        const gap = daysBetween(first, a.attempt_date);
        if (gap >= DELAY_DAYS.twentyOne) return out.delayed21;
        if (gap >= DELAY_DAYS.seven) return out.delayed7;
        return null; // a repeat inside the first week is practice, not a delayed check
      })();
      if (!bucket) return;
      bucket.n += 1;
      if (a.correct) bucket.correct += 1;
    });
  }
  for (const a of attempts) {
    if (a.grading_status === "pending") out.pending += 1;
    else if (a.grading_status === "invalidated") out.invalidated += 1;
  }
  return out;
}

export const percent = (r: Rate): string => (r.n ? `${Math.round((100 * r.correct) / r.n)}%` : "—");

/* ------------------------------------------------------------------ */
/* Session bounds (chosen cards / minutes), resume without penalty       */
/* ------------------------------------------------------------------ */

export interface SessionState {
  v: 1;
  book: string;
  day: string;
  cards: number;
  minutes: number | null;
  done: number;
  usedMs: number;
  lastAt: number;
  taken: string[];
}

export function startSession(book: string, day: string, cards: number, minutes: number | null, now: number): SessionState {
  return { v: 1, book, day, cards, minutes, done: 0, usedMs: 0, lastAt: now, taken: [] };
}

/** Adds the time since the last action, at most ACTIVE_GAP_MS of it: a long break never uses up the time. */
export function touch(s: SessionState, now: number): SessionState {
  const gap = Math.max(0, Math.min(now - s.lastAt, ACTIVE_GAP_MS));
  return { ...s, usedMs: s.usedMs + gap, lastAt: now };
}

/** A card finished (graded, corrected) or skipped. Skipping takes a card out of the session but does not count it. */
export function takeCard(s: SessionState, id: string, counted: boolean, now: number): SessionState {
  const t = touch(s, now);
  return { ...t, done: t.done + (counted ? 1 : 0), taken: t.taken.includes(id) ? t.taken : [...t.taken, id] };
}

export type SessionEnd = "cards" | "time" | null;
/** Checked between cards only, never in the middle of one. */
export function sessionEnded(s: SessionState): SessionEnd {
  if (s.done >= s.cards) return "cards";
  if (s.minutes != null && s.usedMs >= s.minutes * 60000) return "time";
  return null;
}

export function minutesLeft(s: SessionState): number | null {
  return s.minutes == null ? null : Math.max(0, Math.ceil((s.minutes * 60000 - s.usedMs) / 60000));
}

/** A stored session counts only for the same book and the same behavioral day (a new day starts fresh). */
export function parseSession(raw: string | null, book: string, day: string): SessionState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SessionState> | null;
    if (!s || s.v !== 1 || s.book !== book || s.day !== day) return null;
    const ok =
      Number.isInteger(s.cards) && (s.cards as number) > 0 && (s.minutes == null || Number.isInteger(s.minutes)) &&
      Number.isInteger(s.done) && typeof s.usedMs === "number" && typeof s.lastAt === "number" && Array.isArray(s.taken);
    return ok ? (s as SessionState) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The answer or grade whose outcome is unknown (offline, lost answer)   */
/* ------------------------------------------------------------------ */

export type PendingAnswer = {
  kind: "answer";
  book: string;
  attempt_key: string;
  question_key: string;
  prompt: string;
  rubric: string | null;
  source_kind: SourceKind;
  source_ref: number;
  answer: string;
  cardId: string;
};
export type PendingGrade = { kind: "grade"; book: string; attempt_key: string; correct: boolean; cardId: string; question_key: string; version: number };
export type Pending = PendingAnswer | PendingGrade;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored pending request, or null when it is missing, for another book or not shaped like one we wrote. */
export function parsePending(raw: string | null, book: string): Pending | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown> | null;
    if (!p || p.book !== book || typeof p.attempt_key !== "string" || !UUID.test(p.attempt_key) || typeof p.cardId !== "string") return null;
    if (p.kind === "grade") {
      return typeof p.correct === "boolean" && typeof p.question_key === "string" && Number.isInteger(p.version) ? (p as unknown as PendingGrade) : null;
    }
    if (p.kind === "answer") {
      const kinds = ["highlight", "session", "chapter"];
      const ok =
        typeof p.question_key === "string" && UUID.test(p.question_key) && typeof p.prompt === "string" && typeof p.answer === "string" &&
        kinds.includes(p.source_kind as string) && Number.isInteger(p.source_ref) && (p.rubric == null || typeof p.rubric === "string");
      return ok ? (p as unknown as PendingAnswer) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The POST body for a pending request: the same keys as the first try, so a stored one is answered, never repeated. */
export function pendingBody(p: Pending): Record<string, unknown> {
  if (p.kind === "grade") return { op: "grade", attempt_key: p.attempt_key, correct: p.correct, grader: "self" };
  return {
    op: "answer",
    op_key: p.attempt_key,
    book: p.book,
    question_key: p.question_key,
    prompt: p.prompt,
    ...(p.rubric ? { rubric: p.rubric } : {}),
    source_kind: p.source_kind,
    source_ref: p.source_ref,
    answer: p.answer,
  };
}
