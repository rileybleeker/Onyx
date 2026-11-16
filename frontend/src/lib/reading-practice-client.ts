/**
 * Reading practice, browser side (READ-QUIZ-01 S4; docs/reading-question-bank.md "Practice").
 *
 * Helpers shared by the /reading Practice part (app/reading/PracticePart.tsx), the approval card (BankApproval.tsx)
 * and the runner (PracticeRunner.tsx, PracticeCards.tsx), so the tests run the same code. Everything is pure apart
 * from getJson / postJson (one fetch each, never throwing) and the flag queue's timers (injectable):
 *
 * - URLs and the parsers of the two GETs the idle part reads (the round, the bank's approval state);
 * - what each POST answer means for the screen (classifyAttemptAnswer and friends): saved, not sure it saved
 *   (Retry sends the SAME request, so a lost answer is answered from its receipt), refused (nothing was stored), or
 *   a question that cannot be answered now;
 * - the flag queue: a flag is held FLAG_HOLD_MS with Undo before it is sent, and flushed with keepalive when the page
 *   hides;
 * - the round summary ("7 of 8 · +6 XP", ideas moved up, still grading, next due).
 *
 * Nothing here reads or writes storage: typed answers live in the runner's memory only. No value import from
 * lib/reading-recall.ts, so the idle part stays light (the runner, a separate chunk, grades with it).
 */
import type { CoveredIdea, PracticeCard, PracticeQuestion, PracticeSource, VerdictPreview } from "./reading-recall-server";
import type { CardFormat, ModelVerdict, Verdict } from "./reading-recall";

/* ------------------------------------------------------------------ */
/* URLs                                                                 */
/* ------------------------------------------------------------------ */

export { BANK_URL, bankUrl, PRACTICE_TODAY_URL, practiceUrl, readingSlugOf } from "./reading-practice-urls";
export const ATTEMPT_URL = "/api/reading/practice/attempt";
export const FLAG_URL = "/api/reading/practice/flag";
export const APPROVAL_URL = "/api/reading/bank/approval";
export const REVIEW_URL = "/api/reading/review";
export const READING_URL = "/api/reading";
/**
 * The longest answer the attempt route takes (400 bad_answer above it): ANSWER_MAX in lib/reading-recall-server.ts,
 * copied here because that file is server code (tests/reading-practice-ui.test.cjs checks the two stay equal).
 */
export const ANSWER_MAX_CHARS = 4000;

export const roundAttemptsUrl = (roundKey: string) => `/api/reading/practice/round/${encodeURIComponent(roundKey)}`;
export const overrideUrl = (attemptKey: string) => `/api/reading/practice/attempt/${encodeURIComponent(attemptKey)}/override`;

/* ------------------------------------------------------------------ */
/* The round GET                                                        */
/* ------------------------------------------------------------------ */

export type { PracticeCard, PracticeQuestion, PracticeSource, CoveredIdea, VerdictPreview };

export interface PracticeRound {
  today: string;
  quiz_through: number;
  enabled: boolean;
  round_key: string;
  kind: "daily" | "extra" | "chapter";
  n: number;
  cards: PracticeCard[];
  done: number;
  minutes: number;
  extra_available: number;
  chapter_recall: { chapter: number; done_n: number; done: boolean } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : d);
const FORMATS: ReadonlySet<string> = new Set(["cued", "explain", "order", "chapter_recall", "highlight"]);

function cardOk(c: unknown): c is PracticeCard {
  if (!isObj(c) || typeof c.key !== "string" || !FORMATS.has(String(c.format))) return false;
  if (c.kind === "highlight") return isObj(c.highlight) && typeof c.highlight.highlight_id === "number";
  if (c.kind !== "idea" && c.kind !== "chapter_recall") return false;
  const q = c.question;
  return isObj(q) && typeof q.question_id === "number" && typeof q.version === "number" && typeof q.prompt === "string";
}

/** The round GET's answer, or null when it is not one (an error body, another shape). Malformed cards are left out. */
export function parseRound(raw: unknown): PracticeRound | null {
  if (!isObj(raw) || !isYmd(raw.today) || typeof raw.round_key !== "string" || !UUID_RE.test(raw.round_key)) return null;
  const kind = raw.kind === "extra" || raw.kind === "chapter" ? raw.kind : "daily";
  const cards = (Array.isArray(raw.cards) ? raw.cards : []).filter(cardOk).map((c) => ({
    ...c,
    sources: Array.isArray(c.sources) ? c.sources : [],
    source_count: int(c.source_count),
    again_question: c.again_question ?? null,
  }));
  const cr = isObj(raw.chapter_recall) ? raw.chapter_recall : null;
  return {
    today: raw.today,
    quiz_through: int(raw.quiz_through),
    enabled: raw.enabled === true,
    round_key: raw.round_key.toLowerCase(),
    kind,
    n: int(raw.n),
    cards,
    done: cards.filter((c) => c.done).length,
    minutes: Math.max(0, int(raw.minutes)),
    extra_available: Math.max(0, int(raw.extra_available)),
    chapter_recall: cr && typeof cr.chapter === "number" ? { chapter: cr.chapter, done_n: int(cr.done_n), done: cr.done === true } : null,
  };
}

/** The idle part's numbers: today's round progress, the ready count and the minutes. */
export interface RoundProgress {
  total: number;
  done: number;
  ready: number;
  minutes: number;
  /** A chapter recall still to answer today (the "Ch 14 recall · say what you remember" line). */
  recallChapter: number | null;
}
export function roundProgress(r: PracticeRound | null): RoundProgress {
  if (!r) return { total: 0, done: 0, ready: 0, minutes: 0, recallChapter: null };
  const open = r.cards.filter((c) => !c.done);
  const recall = open.find((c) => c.kind === "chapter_recall");
  return {
    total: r.cards.length,
    done: r.cards.length - open.length,
    ready: open.length,
    minutes: open.length ? Math.max(1, r.minutes) : 0,
    recallChapter: recall?.chapter ?? null,
  };
}

/** A cached round is shown only for the day it was built for (the overview's behavioral today). */
export const roundForToday = (r: PracticeRound | null, today: string): PracticeRound | null => (r && r.today === today ? r : null);

/* ------------------------------------------------------------------ */
/* The bank GET (approval state + chapter statuses)                     */
/* ------------------------------------------------------------------ */

export interface BankChapter {
  chapter: number;
  title: string | null;
  locked: boolean;
  status: string;
}
export interface BankState {
  book_id: number;
  enabled: boolean;
  paused_reason: "owner" | "budget" | null;
  approved_cents: number | null;
  spent_cents: number;
  quiz_through: number;
  chapters: BankChapter[];
  /**
   * The server's estimate for what is left to build (`estimate.remaining_cents`) and the cap a Turn on / Allow more
   * tap must send (`estimate.cap_cents`: what is spent + that estimate x 1.25, rounded up, at most $25), from S2's
   * getBankOverview. The route recomputes the cap and answers 409 estimate_changed when it moved.
   */
  estimate_cents: number | null;
  cap_cents: number | null;
  /**
   * The next day an idea is due ("Nothing due · next on Thu"), once a read reports it. Neither the bank GET nor the
   * round GET sends one yet (pds.reading_bank_overview has no next_due), so the idle part shows "Nothing due" alone.
   */
  next_due: string | null;
}

const cents = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * GET /api/reading/bank: pds.reading_bank_overview's row (book_id, enabled, paused_reason, approved_cents,
 * spent_cents, quiz_through, chapters[]) plus `estimate: {book_cents, remaining_cents, cap_cents, per_chapter_cents}`
 * and `monthly_cap_cents` (lib/reading-bank-server.ts getBankOverview). null = not one (an error body).
 */
export function parseBank(raw: unknown): BankState | null {
  if (!isObj(raw) || typeof raw.book_id !== "number") return null;
  const chapters = (Array.isArray(raw.chapters) ? raw.chapters : [])
    .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.chapter === "number")
    .map((c) => ({
      chapter: c.chapter as number,
      title: typeof c.title === "string" ? c.title : null,
      locked: c.locked === true,
      status: typeof c.status === "string" ? c.status : "pending",
    }));
  const est = isObj(raw.estimate) ? raw.estimate : null;
  return {
    book_id: raw.book_id,
    enabled: raw.enabled === true,
    paused_reason: raw.paused_reason === "budget" || raw.paused_reason === "owner" ? raw.paused_reason : null,
    approved_cents: cents(raw.approved_cents),
    spent_cents: cents(raw.spent_cents) ?? 0,
    quiz_through: int(raw.quiz_through),
    chapters,
    estimate_cents: est ? cents(est.remaining_cents) : null,
    cap_cents: est ? cents(est.cap_cents) : null,
    next_due: isYmd(raw.next_due) ? raw.next_due : null,
  };
}

/** One line on the idle part about the bank itself, most urgent first. */
export type BankNotice =
  | { kind: "paused"; moreCents: number | null }
  | { kind: "failed"; chapter: number }
  | { kind: "building"; chapter: number }
  | { kind: "thin"; chapter: number };

export function bankNotice(b: BankState | null): BankNotice | null {
  if (!b || !b.enabled) return null;
  if (b.paused_reason === "budget") {
    const more = b.cap_cents !== null ? b.cap_cents - b.spent_cents : null;
    return { kind: "paused", moreCents: more !== null && more > 0 ? more : null };
  }
  const open = b.chapters.filter((c) => !c.locked && c.chapter >= 1).sort((x, y) => y.chapter - x.chapter);
  const failed = open.find((c) => c.status === "failed");
  if (failed) return { kind: "failed", chapter: failed.chapter };
  const building = open.find((c) => c.status === "pending");
  if (building) return { kind: "building", chapter: building.chapter };
  const thin = open.find((c) => c.status === "thin" || c.status === "no_sources");
  if (thin) return { kind: "thin", chapter: thin.chapter };
  return null;
}

/** "$15": an estimate rounded to whole dollars (at least $1); a cap rounded up. */
export const estimateDollars = (c: number) => `$${Math.max(1, Math.round(c / 100))}`;
export const capDollars = (c: number) => `$${Math.max(1, Math.ceil(c / 100))}`;

/* ------------------------------------------------------------------ */
/* Words, tones and dates on a card                                     */
/* ------------------------------------------------------------------ */

export type Tone = "up" | "mid" | "down";
export const VERDICT_VIEW: Record<Verdict, { word: string; tone: Tone }> = {
  correct: { word: "Right", tone: "up" },
  partial: { word: "Partly", tone: "mid" },
  incorrect: { word: "Not quite", tone: "down" },
  dont_know: { word: "Not quite", tone: "down" },
};
export const TONE_CLASS: Record<Tone, string> = { up: "text-up", mid: "text-mid", down: "text-down" };
export const FORMAT_WORD: Record<CardFormat, string> = {
  cued: "Recall",
  explain: "Explain",
  order: "Order",
  chapter_recall: "Chapter recall",
  highlight: "Your highlight",
};
/** The three grades Riley can give (Disagree and "Grade it yourself"), with their on-screen words. */
export const SELF_VERDICTS: { verdict: ModelVerdict; label: string }[] = [
  { verdict: "correct", label: "Correct" },
  { verdict: "partial", label: "Partly" },
  { verdict: "incorrect", label: "Missed" },
];

const ymdMs = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const daysBetween = (from: string, to: string) => Math.round((ymdMs(to) - ymdMs(from)) / 86_400_000);
export const weekday = (d: string) => new Date(ymdMs(d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });

/** "in 3 days", "tomorrow", "today" for a date after `today`. */
export function inDays(today: string, date: string): string {
  const n = daysBetween(today, date);
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

/**
 * The "Next: in 3 days" line under an answered card: the server's stored next review when the receipt carries one
 * (the commit), else the preview of that verdict (the same replay). An idea already answered today changes nothing.
 */
export function nextLine(args: {
  today: string;
  verdict: Verdict | null;
  preview: PracticeCard["preview"];
  receiptNext: string | null;
  again?: boolean;
}): string | null {
  if (args.again || (args.preview && !args.preview.counts)) return "Schedule unchanged today";
  if (args.receiptNext && isYmd(args.receiptNext)) return `Next: ${inDays(args.today, args.receiptNext)}`;
  if (!args.verdict || !args.preview) return null;
  const next = args.preview.next[args.verdict]?.next_review;
  return next ? `Next: ${inDays(args.today, next)}` : null;
}

/* ------------------------------------------------------------------ */
/* Answers                                                              */
/* ------------------------------------------------------------------ */

export interface AttemptRequest {
  attempt_key: string;
  question_id: number;
  version: number;
  round_key: string;
  round_date: string;
  round_kind: "daily" | "extra" | "chapter" | "checkpoint";
  answer: string;
  hinted: boolean;
  response_ms: number | null;
  quiz_key?: string | null;
}

export interface AttemptReceipt {
  attempt_key: string;
  grading_status: "pending" | "graded" | "invalidated";
  verdict: Verdict | null;
  score: number | null;
  attempt_date: string | null;
  next_review: string | null;
  replayed: boolean;
}

export type AttemptOutcome =
  /** Stored: the receipt (the first one again when this request was stored by an earlier try whose answer was lost). */
  | { kind: "saved"; receipt: AttemptReceipt | null }
  /** No answer or a server failure: it may or may not be stored. Retry sends the same request. */
  | { kind: "unknown"; message: string }
  /** Refused: nothing was stored. The answer can be changed and checked again (a new key). */
  | { kind: "refused"; message: string }
  /** The question cannot be answered now (changed, retired, locked, gone): the card leaves today's round. */
  | { kind: "stale"; message: string };

const VERDICTS: ReadonlySet<string> = new Set(["correct", "partial", "incorrect", "dont_know"]);
const GRADING: ReadonlySet<string> = new Set(["pending", "graded", "invalidated"]);

export function parseReceipt(body: unknown): AttemptReceipt | null {
  if (!isObj(body) || body.success !== true || typeof body.attempt_key !== "string") return null;
  return {
    attempt_key: body.attempt_key.toLowerCase(),
    grading_status: GRADING.has(String(body.grading_status)) ? (body.grading_status as AttemptReceipt["grading_status"]) : "pending",
    verdict: VERDICTS.has(String(body.verdict)) ? (body.verdict as Verdict) : null,
    score: typeof body.score === "number" ? body.score : null,
    attempt_date: isYmd(body.attempt_date) ? body.attempt_date : null,
    next_review: isYmd(body.next_review) ? body.next_review : null,
    replayed: body.replayed === true,
  };
}

const STALE_CODES = new Set(["question_changed", "retired", "superseded", "chapter_changed", "source_not_permitted"]);

/** What the attempt route's answer means. `status` null = no answer at all (offline, timeout, the page went away). */
export function classifyAttemptAnswer(status: number | null, body: unknown): AttemptOutcome {
  if (status === null) return { kind: "unknown", message: "No answer from Onyx, so this answer may not be saved." };
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (status >= 200 && status < 300) {
    const receipt = parseReceipt(body);
    return receipt ? { kind: "saved", receipt } : { kind: "unknown", message: "Onyx couldn't confirm the save." };
  }
  // The same request under its key answers the first receipt (a 2xx above), so key_reused means ANOTHER request holds
  // this key: what is stored is not what is on screen. Nothing new was stored; checking again takes a new key.
  if (status === 409 && code === "key_reused") return { kind: "refused", message: "Onyx already holds a different answer under this save. Nothing new was saved. Check it again." };
  if (status === 400 && code === "bad_answer") {
    return { kind: "refused", message: `Onyx takes answers of up to ${ANSWER_MAX_CHARS.toLocaleString("en-US")} characters. Shorten it and check again. Nothing was saved.` };
  }
  if (status === 400 && code === "states_missing") return { kind: "refused", message: "A flagged idea of this chapter changed while you answered. Nothing was saved. Check it again." };
  if (status === 409 && code === "raced") return { kind: "unknown", message: "Onyx was busy saving another answer." };
  if (status === 409 && code === "locked") return { kind: "stale", message: "This chapter is locked now, so the question is left out." };
  if ((status === 409 || status === 400) && STALE_CODES.has(code)) return { kind: "stale", message: "This question changed, so it is left out of today's round." };
  if (status === 404) return { kind: "stale", message: "This question no longer exists." };
  if (status === 409 && code === "bank_off") return { kind: "refused", message: "Questions are off for this book. Nothing was saved." };
  if (status === 409 && (code === "quiz_closed" || code === "already_answered" || code === "quiz_other_book")) {
    return { kind: "refused", message: "This quiz takes no more answers. Nothing was saved." };
  }
  if (status === 503) return { kind: "unknown", message: "Answers can't be saved right now." };
  if (status >= 400 && status < 500) return { kind: "refused", message: "Onyx refused this answer. Nothing was saved." };
  return { kind: "unknown", message: "Onyx couldn't confirm the save." };
}

export type SmallOutcome<T> = { kind: "saved"; value: T } | { kind: "unknown"; message: string } | { kind: "refused"; message: string };

/** Disagree (Correct / Partly / Missed, once) and "Grade it yourself". The same request replays its receipt. */
export function classifyOverrideAnswer(status: number | null, body: unknown): SmallOutcome<AttemptReceipt> {
  if (status === null) return { kind: "unknown", message: "No answer from Onyx, so this may not be saved." };
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (status >= 200 && status < 300) {
    const r = parseReceipt(body);
    return r ? { kind: "saved", value: r } : { kind: "unknown", message: "Onyx couldn't confirm the save." };
  }
  if (status === 409 && code === "raced") return { kind: "unknown", message: "Onyx was busy saving another answer." };
  if (status === 409 && code === "already_overridden") return { kind: "refused", message: "Already changed once." };
  if (status === 409 && code === "still_grading") return { kind: "refused", message: "Still grading. Try again in a moment." };
  if (status === 409 && code === "already_graded") return { kind: "refused", message: "Onyx graded it meanwhile." };
  if (status === 409 && code === "quiz_closed") return { kind: "refused", message: "The quiz result is recorded, so this grade stays." };
  if (status === 503 || status >= 500) return { kind: "unknown", message: "Onyx couldn't confirm the save." };
  return { kind: "refused", message: "Onyx refused this change. Nothing was saved." };
}

export interface FlagResult {
  invalidated: number;
  kind: string | null;
}
export function classifyFlagAnswer(status: number | null, body: unknown): SmallOutcome<FlagResult> {
  if (status === null) return { kind: "unknown", message: "No answer from Onyx, so the flag may not be saved." };
  if (status >= 200 && status < 300 && isObj(body) && body.success === true) {
    return { kind: "saved", value: { invalidated: Math.max(0, int(body.invalidated)), kind: typeof body.kind === "string" ? body.kind : null } };
  }
  if (status === 409 && isObj(body) && body.error === "raced") return { kind: "unknown", message: "Onyx was busy. The flag is not saved yet." };
  if (status >= 500 || status === 503 || status < 400) return { kind: "unknown", message: "Onyx couldn't confirm the flag." };
  return { kind: "refused", message: "Onyx refused the flag. Nothing changed." };
}

export type ApprovalOutcome =
  | { kind: "saved"; on: boolean }
  /** The estimate moved since it was shown (409 estimate_changed): show the new one before asking again. */
  | { kind: "changed"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "refused"; message: string };
export function classifyApprovalAnswer(status: number | null, body: unknown): ApprovalOutcome {
  if (status === null) return { kind: "unknown", message: "No answer from Onyx. Check the connection, then try again." };
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (status >= 200 && status < 300 && isObj(body) && typeof body.on === "boolean") return { kind: "saved", on: body.on };
  if (status === 409 && code === "estimate_changed") return { kind: "changed", message: "The estimate changed. Check the new amount." };
  if (status >= 400 && status < 500) return { kind: "refused", message: "Onyx refused this. Nothing changed." };
  return { kind: "unknown", message: "Onyx couldn't confirm the change." };
}

/** One GET (no-store); `status` null when no answer came back. Never throws. */
export async function getJson(url: string): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

/** One POST with JSON; `status` null when no answer came back. Never throws. */
export async function postJson(url: string, body: unknown, opts: { method?: string; keepalive?: boolean } = {}): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(url, {
      method: opts.method ?? "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: opts.keepalive || undefined,
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

/* ------------------------------------------------------------------ */
/* The round's attempts (the runner's poll)                             */
/* ------------------------------------------------------------------ */

export interface AttemptResult {
  attempt_key: string;
  question_id: number;
  grading_status: string;
  verdict: Verdict | null;
  score: number | null;
  hinted: boolean;
  feedback: string | null;
  rubric_hits: { id: string; hit: "yes" | "partial" | "no" }[] | null;
  grader: string | null;
  overridden: boolean;
  grade_error: string | null;
  overridable: boolean;
  self_gradable: boolean;
  covered_ideas: CoveredIdea[] | null;
}

/** GET /api/reading/practice/round/:key, by attempt key. Never the answer text (the route sends none). */
export function parseRoundAttempts(raw: unknown): Map<string, AttemptResult> {
  const out = new Map<string, AttemptResult>();
  if (!isObj(raw) || !Array.isArray(raw.attempts)) return out;
  for (const a of raw.attempts) {
    if (!isObj(a) || typeof a.attempt_key !== "string") continue;
    const key = a.attempt_key.toLowerCase();
    out.set(key, {
      attempt_key: key,
      question_id: int(a.question_id),
      grading_status: typeof a.grading_status === "string" ? a.grading_status : "pending",
      verdict: VERDICTS.has(String(a.verdict)) ? (a.verdict as Verdict) : null,
      score: typeof a.score === "number" ? a.score : null,
      hinted: a.hinted === true,
      feedback: typeof a.feedback === "string" ? a.feedback : null,
      rubric_hits: Array.isArray(a.rubric_hits)
        ? (a.rubric_hits as unknown[])
            .filter((h): h is { id: string; hit: "yes" | "partial" | "no" } => isObj(h) && typeof h.id === "string" && (h.hit === "yes" || h.hit === "partial" || h.hit === "no"))
            .map((h) => ({ id: h.id, hit: h.hit }))
        : null,
      grader: typeof a.grader === "string" ? a.grader : null,
      overridden: a.overridden === true,
      grade_error: typeof a.grade_error === "string" ? a.grade_error : null,
      overridable: a.overridable === true,
      self_gradable: a.self_gradable === true,
      covered_ideas: Array.isArray(a.covered_ideas) ? (a.covered_ideas as CoveredIdea[]) : null,
    });
  }
  return out;
}

/** The poll interval while a model grade is pending, and how long the runner keeps polling one answer. */
export const POLL_EVERY_MS = 2_000;
export const POLL_FOR_MS = 60_000;

/** Covered / Missed of a chapter recall answer (a covered idea marked yes or partial; missed = no). */
export function coveredSplit(ideas: CoveredIdea[] | null | undefined): { covered: CoveredIdea[]; missed: CoveredIdea[] } {
  const list = (ideas ?? []).filter((i) => i.verdict !== null);
  return {
    covered: list.filter((i) => i.verdict === "correct" || i.verdict === "partial"),
    missed: list.filter((i) => i.verdict === "incorrect" || i.verdict === "dont_know"),
  };
}

/* ------------------------------------------------------------------ */
/* Order cards                                                          */
/* ------------------------------------------------------------------ */

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The steps of an order card in the order they are offered: a shuffle fixed by the question and the day (so a
 * reopened card looks the same), never the answer itself. Returns indexes into `steps`.
 */
export function offeredOrder(steps: string[], seed: string): number[] {
  const idx = shuffled(steps.length, seed);
  if (idx.length > 1 && idx.every((v, i) => v === i)) idx.push(idx.shift() as number);
  return idx;
}

/** A Fisher-Yates permutation of 0..n-1 fixed by `seed`. */
function shuffled(n: number, seed: string): number[] {
  const idx = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  let h = hash32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    const j = h % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/**
 * The options of "Show choices" in the order they are offered (indexes into the stored options): shuffled by the
 * question and the day, so where the generator put the right option is no hint, and a reopened card looks the same.
 * Unlike offeredOrder the stored order may come out (forcing a change would itself say where the answer is not).
 */
export const choiceOrder = (count: number, seed: string): number[] => shuffled(count, `choices|${seed}`);

/* ------------------------------------------------------------------ */
/* Flags: held 8 s with Undo, flushed with keepalive when the page hides */
/* ------------------------------------------------------------------ */

export type FlagKind = "wrong" | "unclear" | "not_in_chapter" | "not_read_yet";
export const FLAG_LABEL: Record<FlagKind, string> = {
  wrong: "Wrong",
  unclear: "Unclear",
  not_in_chapter: "Not in this chapter",
  not_read_yet: "Not read yet",
};
export const FLAG_HOLD_MS = 8_000;

export interface HeldFlag {
  flag_key: string;
  question_id: number;
  kind: FlagKind;
  /** The cards the flag took off the screen (Undo puts them back). */
  cardKeys: string[];
  status: "held" | "sending" | "unknown" | "sent" | "refused";
  message?: string;
}

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
export const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface FlagQueue {
  /** Hold a flag; it is sent after FLAG_HOLD_MS unless undone first. */
  add(f: Omit<HeldFlag, "status">): void;
  /** Take back a flag that is still held (nothing is sent). False once it went out. */
  undo(flagKey: string): boolean;
  /** Send every held flag now (and retry the unconfirmed ones), with keepalive when the page is going away. */
  flush(keepalive: boolean): Promise<void>;
  /** Retry one flag whose save was not confirmed (same key: replay safe). */
  retry(flagKey: string): Promise<void>;
  list(): HeldFlag[];
  /** Stop the timers (unmount); held flags are flushed first by the caller. */
  dispose(): void;
}

/**
 * The flag queue. `send` posts {flag_key, question_id, kind} (replay safe by flag_key). `onChange` runs after
 * every state change, `onSent` once per flag the server confirmed.
 */
export function createFlagQueue(opts: {
  send: (f: HeldFlag, keepalive: boolean) => Promise<SmallOutcome<FlagResult>>;
  onChange?: (flags: HeldFlag[]) => void;
  onSent?: (f: HeldFlag, r: FlagResult) => void;
  timers?: Timers;
  holdMs?: number;
}): FlagQueue {
  const timers = opts.timers ?? realTimers;
  const hold = opts.holdMs ?? FLAG_HOLD_MS;
  const flags = new Map<string, HeldFlag>();
  const handles = new Map<string, unknown>();
  const changed = () => opts.onChange?.([...flags.values()]);
  const patch = (key: string, p: Partial<HeldFlag>) => {
    const f = flags.get(key);
    if (f) flags.set(key, { ...f, ...p });
  };
  /**
   * `again`: send a flag whose first request is still on its way once more (the page is going away, so that fetch may
   * die with it; this one carries keepalive). The same flag_key makes both replay-safe, and whichever answer arrives
   * first settles the flag: a later one never reports it twice (onSent runs once) or turns a sent flag back.
   */
  async function sendOne(key: string, keepalive: boolean, again = false) {
    const f = flags.get(key);
    if (!f || f.status === "sent" || f.status === "refused" || (f.status === "sending" && !again)) return;
    const h = handles.get(key);
    if (h !== undefined) {
      timers.clear(h);
      handles.delete(key);
    }
    patch(key, { status: "sending", message: undefined });
    changed();
    const out = await opts.send(flags.get(key)!, keepalive);
    if (flags.get(key)?.status === "sent") return;
    if (out.kind === "saved") {
      patch(key, { status: "sent" });
      opts.onSent?.(flags.get(key)!, out.value);
    } else if (flags.get(key)?.status !== "sending" || !again) patch(key, { status: out.kind, message: out.message });
    changed();
  }
  return {
    add(f) {
      flags.set(f.flag_key, { ...f, status: "held" });
      handles.set(f.flag_key, timers.set(() => void sendOne(f.flag_key, false), hold));
      changed();
    },
    undo(key) {
      const f = flags.get(key);
      if (!f || f.status !== "held") return false;
      const h = handles.get(key);
      if (h !== undefined) timers.clear(h);
      handles.delete(key);
      flags.delete(key);
      changed();
      return true;
    },
    async flush(keepalive) {
      // With keepalive (the page is hiding) a flag already on its way is sent again too: its fetch may die with the page.
      await Promise.all(
        [...flags.values()]
          .filter((f) => f.status === "held" || f.status === "unknown" || (keepalive && f.status === "sending"))
          .map((f) => sendOne(f.flag_key, keepalive, f.status === "sending")),
      );
    },
    retry: (key) => sendOne(key, false),
    list: () => [...flags.values()],
    dispose() {
      for (const h of handles.values()) timers.clear(h);
      handles.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* The summary                                                          */
/* ------------------------------------------------------------------ */

/** Practice XP per counted answer (the first of the day per idea): the same numbers as lib/reading.ts XP (S5). */
export const PRACTICE_XP = { correct: 2, partial: 1 } as const;

export interface SummaryItem {
  /** A round card (an "Again" repeat is not one). */
  roundCard: boolean;
  /** Answered: stored in this sitting, or before it (a resumed round). */
  answered: boolean;
  /** The first answer of the day for its idea (it moves the schedule and earns practice XP). */
  counts: boolean;
  verdict: Verdict | null;
  /** Stored and still waiting for its model grade. */
  grading: boolean;
  stageBefore: number | null;
  stageAfter: number | null;
  nextReview: string | null;
  /** XP the server reported for a highlight review. */
  reviewXp: number;
}

export interface RoundSummary {
  answered: number;
  total: number;
  xp: number;
  movedUp: number;
  stillGrading: number;
  nextDue: string | null;
}

export function summarize(items: SummaryItem[], today: string): RoundSummary {
  const round = items.filter((i) => i.roundCard);
  let xp = 0;
  let movedUp = 0;
  for (const i of items) {
    xp += i.reviewXp;
    if (!i.counts || i.grading) continue;
    if (i.verdict === "correct") xp += PRACTICE_XP.correct;
    else if (i.verdict === "partial") xp += PRACTICE_XP.partial;
    if (i.stageBefore !== null && i.stageAfter !== null && i.stageAfter > i.stageBefore) movedUp += 1;
  }
  const next = items.map((i) => i.nextReview).filter((d): d is string => !!d && isYmd(d) && d > today).sort();
  return {
    answered: round.filter((i) => i.answered).length,
    total: round.length,
    xp,
    movedUp,
    stillGrading: items.filter((i) => i.grading).length,
    nextDue: next[0] ?? null,
  };
}

/** Only http(s) links leave the page (the server already drops the rest; this is the second check). */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A highlight source's label: "Your highlight · p. 52" (or the Kindle location). */
export function highlightLabel(s: Pick<PracticeSource, "page" | "location">): string {
  if (s.page != null) return `Your highlight · p. ${s.page}`;
  if (s.location) return `Your highlight · loc. ${s.location}`;
  return "Your highlight";
}

/** Whether a stored grade is the model's (Disagree applies) once the poll says so. */
export const isModelFormat = (f: CardFormat) => f === "explain" || f === "chapter_recall";
