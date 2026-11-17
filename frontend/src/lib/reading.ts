import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isMissingSchema,
  isOpKey,
  newOpKey,
  PRACTICE_GRADES,
  QUIZ_CHECKPOINT_MAX,
  rpcFailure,
  scheduleAfterGrade,
  type PracticeFailure,
  type PracticeGrade,
  type RpcAnswer,
} from "@/lib/reading-practice";
import { quizVerification, type QuizVerification } from "@/lib/reading-questions";

/**
 * Reading module — shared server logic for /api/reading/* and the chat tools.
 *
 * Tables (sql/reading_schema.sql): pds.books, pds.reading_sessions,
 * pds.book_highlights, pds.reading_reviews, pds.reading_quizzes.
 *
 * Everything gamified (XP, level, streak, pace, badges, checkpoints) is DERIVED
 * here from the raw rows — nothing is stored, so the rules can change freely.
 * A book's own flavour (level titles, concept tags, badge labels) is data on its
 * row (pds.books.theme, sql/reading_book_theme.sql), never code: this repo is public.
 * The Supabase client passed in MUST be scoped to schema "pds" (service role).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export type Medium = "audio" | "kindle" | "paper" | "other";
export type HighlightSource = "manual" | "kindle" | "audible" | "paper" | "photo";
export type Grade = PracticeGrade;

export interface Book {
  book_id: number;
  slug: string;
  title: string;
  author: string | null;
  total_chapters: number | null;
  start_date: string | null;
  target_date: string | null;
  status: "queued" | "reading" | "finished" | "abandoned";
  finished_on: string | null;
  notion_page_id: string | null;
  habit_name: string | null;
  /** Kindle identity + Whispersync position (filled by the harvester; see lib/reading-kindle.ts). */
  asin: string | null;
  last_position: number | null;
  last_position_at: string | null;
  total_positions: number | null;
}

/** Chapter → Kindle position span (pds.book_chapters). */
export interface ChapterSpan {
  chapter: number;
  start_position: number;
  end_position: number | null;
  start_page: number | null;
  end_page: number | null;
}

export type SessionSource = "manual" | "chat" | "kindle";

export interface ReadingSession {
  session_id: number;
  book_id: number;
  session_date: string;
  chapter_from: number | null;
  chapter_through: number | null;
  minutes: number | null;
  medium: Medium | null;
  recall: string | null;
  question: string | null;
  notion_block_id: string | null;
  created_at: string;
  source: SessionSource;
  /** Kindle-derived sessions: the chapter being read when no chapter was completed that day. */
  in_chapter: number | null;
  highlight_count: number | null;
}

export interface Highlight {
  highlight_id: number;
  book_id: number;
  chapter: number | null;
  location: string | null;
  passage: string;
  comment: string | null;
  concept: string | null;
  source: HighlightSource;
  review_count: number;
  ease: number;
  interval_days: number;
  next_review: string | null;
  last_reviewed: string | null;
  archived: boolean;
  notion_block_id: string | null;
  created_at: string;
  /** Kindle position span + print page + timestamps (harvester-filled; null for manual rows). */
  position: number | null;
  position_end: number | null;
  page: number | null;
  highlighted_at: string | null;
  note_at: string | null;
  behavioral_date: string | null;
}

export interface Review {
  review_id: number;
  highlight_id: number;
  review_date: string;
  grade: Grade;
}

/** The one review field the overview reads: which day a review happened (streaks, XP, badges, today's count). */
export type ReviewDate = Pick<Review, "review_date">;

export interface Quiz {
  quiz_id: number;
  book_id: number;
  checkpoint: string;
  score: number;
  total: number;
  notes: string | null;
  quiz_date: string;
  /** Graded answers this result was checked against (sql/reading_learning_questions.sql); null/absent = unverifiable. */
  question_count?: number | null;
  /** Answers in it whose question was corrected later: > 0 = invalidated (shown, not counted). */
  invalidated_count?: number | null;
  /** Set by computeOverview (lib/reading-questions.ts quizVerification). */
  verification?: QuizVerification;
}

// Explicit column lists instead of select("*") (re-audit 2026-06-07,
// units/gpt-5/F-004: a new, similarly named column should not flow into
// consumers unnoticed). Every column of each table, checked against
// information_schema on 2026-11-14: these rows go out whole in /api/reading
// responses and chat tool results, so nothing is dropped. If the schema adds a
// column a consumer needs, append it here (and to the interface above). `books.theme` (sql/reading_book_theme.sql) is
// deliberately NOT listed: it is read through OVERVIEW_SELECT's `*` and parsed into overview.theme, so a book read
// never fails while that column is not applied yet.
export const BOOK_COLS =
  "book_id, slug, title, author, total_chapters, start_date, target_date, status, finished_on, notion_page_id, habit_name, created_at, updated_at, asin, last_position, last_position_at, total_positions";
export const SESSION_COLS =
  "session_id, book_id, session_date, chapter_from, chapter_through, minutes, medium, recall, question, notion_block_id, created_at, source, in_chapter, highlight_count, updated_at";
export const HIGHLIGHT_COLS =
  "highlight_id, book_id, chapter, location, passage, comment, concept, source, review_count, ease, interval_days, next_review, last_reviewed, archived, notion_block_id, created_at, updated_at, position, position_end, page, highlighted_at, note_at, behavioral_date";

export interface Checkpoint {
  key: string; // 'ch12'
  chapter: number;
  due: string; // YYYY-MM-DD
  reached: boolean; // chapter reached by any date
  onTime: boolean | null; // null until due or reached
  quiz: Quiz | null;
  /**
   * True when a NEWER quiz result exists for this checkpoint but was invalidated (one of its questions was corrected
   * later), so the older counted result is shown instead. The UI says so next to the score; XP rules are unchanged
   * (the invalidated result never earned XP). PR 362 follow-up.
   */
  correctedNewer: boolean;
  /** The invalidated newer result that replaced the counted one, when correctedNewer (its score and date, for the notice). */
  correctedNewerQuiz: { date: string; score: number; total: number } | null;
}

export interface Badge {
  key: string;
  label: string;
  description: string;
  earned: boolean;
  earnedOn: string | null;
}

export interface XpBreakdown {
  chapters: number;
  recalls: number;
  highlights: number;
  reviews: number;
  /** Chapter question practice (READ-QUIZ-01): the day's first counted answers, checkpoint answers excluded. */
  practice: number;
  quizzes: number;
  checkpoints: number;
  total: number;
}

/**
 * The question bank's summary for the overview (pds.reading_bank_summary, READ-QUIZ-01): counts and schedules only,
 * never a question, an idea or an answer. null in the overview when the bank's SQL is not applied (the page then shows
 * the Review card as before).
 */
export interface PracticeSummary {
  /** The book the summary is about (the overview ignores one that is not its own book). */
  bookId: number;
  enabled: boolean;
  /** "owner" = turned off by Riley, "budget" = paused at the spending cap. */
  pausedReason: "owner" | "budget" | null;
  mapping: "unknown" | "ok" | "uncertain";
  approvedCents: number | null;
  spentCents: number;
  /** The highest chapter that may be quizzed (the spoiler gate). */
  quizThrough: number;
  /** Ideas due today, and ideas never asked yet, among the unlocked ones. */
  due: number;
  newReady: number;
  /** Ideas by stage (detail ideas left out): New, Seen, Recalled, Explained, Kept. */
  stages: { new: number; seen: number; recalled: number; explained: number; kept: number };
  /** Answers right when the idea was last answered right 7 to 20 days earlier / 21 days or more earlier. */
  recall7d: { n: number; right: number };
  recall21d: { n: number; right: number };
  chapters: { chapter: number; status: string; ideas: number | null; questions: number | null; sources: number | null }[];
  /** Answers voided by a correction, and answers still waiting for a model grade. */
  voided: number;
  pending: number;
  /** The first counted answer of each idea and day, by verdict (checkpoint answers excluded): practice XP. */
  counted: { correct: number; partial: number };
  /** Behavioral days with such an answer: a practice day counts as a review day. */
  days: string[];
}

export interface ReadingOverview {
  book: Book;
  today: string; // behavioral today
  chaptersDone: number;
  totalChapters: number;
  percent: number;
  pace: {
    expectedToday: number; // chapters that should be done by today
    aheadBy: number; // positive = ahead
    perDayNeeded: number; // chapters/day to still finish on time
    daysLeft: number;
    daysElapsed: number;
    totalDays: number;
    onTrack: boolean;
  };
  streak: { current: number; best: number; loggedToday: boolean; atRisk: boolean };
  xp: XpBreakdown;
  level: { n: number; title: string; intoLevel: number; perLevel: number };
  badges: Badge[];
  /**
   * The book's own flavour (pds.books.theme, generic defaults when none): level and badge labels are already applied
   * above; the concept tags are what the highlight form offers. An overview cached before the theme existed has no
   * `theme`; readers use `conceptOptions`, which tolerates that.
   */
  theme: BookTheme;
  checkpoints: Checkpoint[];
  /** The chapter question bank's numbers; null while it is not set up (READ-QUIZ-01). */
  practice: PracticeSummary | null;
  sessions: ReadingSession[]; // newest first
  highlights: Highlight[]; // newest first
  dueReviews: Highlight[]; // due today, oldest due first (max 5)
  reviewsToday: number;
  quizzes: Quiz[];
  burnup: Array<{ date: string; actual: number | null; target: number }>;
  minutesTotal: number;
  /** Where the Kindle says Riley is (Whispersync position mapped through the chapter table), null until harvested. */
  position: { chapter: number | null; page: number | null; percent: number | null; at: string | null } | null;
  chapters: ChapterSpan[];
}

/* ------------------------------------------------------------------ */
/* XP rules                                                             */
/* ------------------------------------------------------------------ */

export const XP = {
  perChapter: 10,
  perRecall: 20, // a session with a from-memory recall note (>= 40 chars)
  perHighlightWithComment: 5,
  perHighlightBare: 2,
  perReviewDay: 15, // a day on which at least one review was graded, or one chapter question was answered
  perPracticeCorrect: 2, // chapter questions: the day's first counted answer of an idea
  perPracticePartial: 1,
  perQuizPoint: 10, // per correct answer
  perCheckpointOnTime: 50,
  perLevel: 100,
} as const;

/* ------------------------------------------------------------------ */
/* Book theme (pds.books.theme)                                         */
/* ------------------------------------------------------------------ */

/**
 * The flavour of one book, kept as data on its row instead of in code (READ-QUIZ-01 D24: this repo is public and
 * names no book). Three things can be themed: the level ladder, the concept tags offered on a highlight, and the
 * labels of the badges. A book with no theme (or an unreadable one) gets the generic defaults below, so the quest
 * works for any book. The column is written by hand (sql/reading_book_theme.sql explains the shape); nothing in the
 * app writes it.
 */
export interface BookTheme {
  /** Level 1 first; the last title serves every level beyond the list. */
  levelTitles: string[];
  /** Concept tags offered on the highlight form (the titles of linked question-bank ideas are added to them). */
  concepts: string[];
  /** Badge labels by badge key (BADGE_KEYS); a badge with no entry keeps its generic label. */
  badgeLabels: Record<string, string>;
}

export const DEFAULT_LEVEL_TITLES: readonly string[] = ["Newcomer", "Reader", "Regular", "Student", "Analyst", "Scholar", "Specialist", "Expert", "Master"];

/** Badge keys in display order, with their generic labels. A theme may rename any of them, never add one. */
export const DEFAULT_BADGE_LABELS: Readonly<Record<string, string>> = {
  "first-session": "First Session",
  "checkpoint-1": "First Checkpoint",
  "checkpoint-2": "Second Checkpoint",
  finisher: "Finisher",
  "streak-7": "Seven Straight",
  scribe: "Scribe",
  reviewer: "Reviewer",
  "quiz-master": "Quiz Master",
  "on-pace": "On Pace",
  runner: "Runner's Ear",
};
export const BADGE_KEYS: readonly string[] = Object.keys(DEFAULT_BADGE_LABELS);

/** Limits applied when a theme is read (the database allows 6,000 characters of JSON in all). */
export const THEME_LIMITS = { levelTitles: 12, levelTitleChars: 40, concepts: 40, conceptChars: 80, badgeChars: 40 } as const;
/** The concept picker never lists more than this (theme concepts first, then linked idea titles). */
export const CONCEPT_OPTIONS_MAX = 80;

/** A fresh generic theme (what a book with no theme gets). */
export const defaultBookTheme = (): BookTheme => ({ levelTitles: [...DEFAULT_LEVEL_TITLES], concepts: [], badgeLabels: {} });

/**
 * One short line of plain text: control characters out, whitespace collapsed, cut to `max` characters (counted as code
 * points, so a surrogate pair is never split); null when nothing is left.
 */
function themeText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  const cut = s.length > max ? Array.from(s).slice(0, max).join("").trim() : s;
  return cut ? cut : null;
}

/**
 * A list of short strings: not-text entries dropped, cut to `max` characters, at most `count`. With `distinct` (the
 * default) repeats ignoring case are dropped too. A ladder passes false: its entries are positional (level n gets
 * title n), so dropping a repeat would move every later level up by one.
 */
function themeList(v: unknown, count: number, max: number, distinct = true): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const t = themeText(item, max);
    const k = t?.toLowerCase();
    if (!t || !k) continue;
    if (distinct) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(t);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * pds.books.theme as the app uses it. `{ v?: 1, level_titles?: string[], concepts?: string[], badges?: { [badge key]: label } }`.
 * Never throws and never returns a partial surprise: a field that is missing, of another type or empty falls back to
 * the generic default on its own (a bad badge label keeps that badge's default; a theme of another version, or a value
 * that is not an object, is no theme). Everything is plain text; the screens render it as text, never as markup.
 * Level titles keep their order and their repeats (a ladder is positional); concepts drop repeats ignoring case.
 */
export function parseBookTheme(raw: unknown): BookTheme {
  if (!isObject(raw) || (raw.v !== undefined && raw.v !== 1)) return defaultBookTheme();
  const levelTitles = themeList(raw.level_titles, THEME_LIMITS.levelTitles, THEME_LIMITS.levelTitleChars, false);
  const badgeLabels: Record<string, string> = {};
  if (isObject(raw.badges)) {
    for (const key of BADGE_KEYS) {
      const label = themeText(raw.badges[key], THEME_LIMITS.badgeChars);
      if (label) badgeLabels[key] = label;
    }
  }
  return {
    levelTitles: levelTitles.length ? levelTitles : [...DEFAULT_LEVEL_TITLES],
    concepts: themeList(raw.concepts, THEME_LIMITS.concepts, THEME_LIMITS.conceptChars),
    badgeLabels,
  };
}

/**
 * The concept tags the highlight form offers: the theme's own, then the titles of the question-bank ideas Riley's
 * highlights are linked to (lib/reading.ts getLinkedIdeaTitles), repeats ignoring case dropped, at most
 * CONCEPT_OPTIONS_MAX. Tolerates an overview cached before the theme existed (no theme: no theme concepts).
 */
export function conceptOptions(themeConcepts: readonly string[] | null | undefined, ideaTitles: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [themeConcepts, ideaTitles]) {
    for (const item of Array.isArray(list) ? list : []) {
      const t = themeText(item, THEME_LIMITS.conceptChars);
      const k = t?.toLowerCase();
      if (!t || !k || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= CONCEPT_OPTIONS_MAX) return out;
    }
  }
  return out;
}

/** The linked-idea titles the SQL function answers (a JSON array of strings): cleaned like theme concepts, at most 40. */
export function parseIdeaTitles(raw: unknown): string[] {
  return themeList(raw, 40, 90);
}

/* ------------------------------------------------------------------ */
/* Date helpers (all YYYY-MM-DD strings, UTC-anchored arithmetic)       */
/* ------------------------------------------------------------------ */

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400_000);
}

export async function behavioralToday(supabase: Supa): Promise<string> {
  try {
    const { data } = await supabase.rpc("behavioral_today_now");
    if (typeof data === "string" && data) return data;
  } catch {
    /* fall through */
  }
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

export async function getBook(supabase: Supa, slug?: string | null): Promise<Book | null> {
  let q = supabase.from("books").select(BOOK_COLS);
  if (slug) q = q.eq("slug", slug);
  else q = q.eq("status", "reading");
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as Book) ?? null;
}

export async function listBooks(supabase: Supa): Promise<Book[]> {
  const { data, error } = await supabase.from("books").select(BOOK_COLS).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Book[];
}

/**
 * One book with every row the overview needs, in ONE PostgREST request (embedded resources over the foreign keys
 * book_id and highlight_id), sent in parallel with behavioral today. Same rows and order as separate queries:
 * sessions newest first, unarchived highlights newest first with their review dates, quizzes newest first, chapters by
 * position. (2026-11-14: was four round trips in a row.)
 *
 * The embedded reviews carry only review_date: the overview never shows a review itself, it counts the days and the
 * day's reviews (grade, id and highlight id were shipped and then dropped). Sessions, highlights and quizzes stay whole
 * because the UI lists them and their counts, XP, streak and badges are computed over the full history. A bounded
 * embed would change those displayed values, so the history is not truncated here.
 */
const OVERVIEW_SELECT =
  "*, reading_sessions(*), book_highlights(*, reading_reviews(review_date)), reading_quizzes(*), book_chapters(chapter,start_position,end_position,start_page,end_page)";

type OverviewRow = Book & {
  /** pds.books.theme: only there once sql/reading_book_theme.sql is applied (the `*` select carries it then). */
  theme?: unknown;
  reading_sessions?: ReadingSession[] | null;
  book_highlights?: (Highlight & { reading_reviews?: ReviewDate[] | null })[] | null;
  reading_quizzes?: Quiz[] | null;
  book_chapters?: ChapterSpan[] | null;
};

export async function getOverview(supabase: Supa, slug?: string | null): Promise<ReadingOverview | null> {
  let q = supabase.from("books").select(OVERVIEW_SELECT);
  if (slug) q = q.eq("slug", slug);
  else q = q.eq("status", "reading");
  const bookQuery = q
    .eq("book_highlights.archived", false)
    .order("session_date", { referencedTable: "reading_sessions", ascending: false })
    .order("session_id", { referencedTable: "reading_sessions", ascending: false })
    .order("created_at", { referencedTable: "book_highlights", ascending: false })
    .order("highlight_id", { referencedTable: "book_highlights", ascending: false })
    .order("taken_at", { referencedTable: "reading_quizzes", ascending: false })
    .order("start_position", { referencedTable: "book_chapters" })
    .order("created_at", { ascending: false })
    .limit(1);
  // The question bank's summary rides in the same round trip (one RPC, resolved server side by the same slug rule);
  // it fails open to null, so a missing function or a failed read never costs the overview (READ-QUIZ-01).
  const [{ data, error }, today, practice] = await Promise.all([bookQuery, behavioralToday(supabase), readPracticeSummary(supabase, slug ?? null)]);
  if (error) throw new Error(error.message);
  const row = (data?.[0] as OverviewRow | undefined) ?? null;
  if (!row) return null;

  // The raw theme column is read into the overview's own `theme` (validated, with defaults) and kept off the book.
  const { reading_sessions, book_highlights, reading_quizzes, book_chapters, theme: rawTheme, ...book } = row;
  const sessions = reading_sessions ?? [];
  const reviews: ReviewDate[] = [];
  const highlights = (book_highlights ?? []).map(({ reading_reviews, ...h }) => {
    for (const r of reading_reviews ?? []) reviews.push(r);
    return { ...h, ease: Number(h.ease) } as Highlight;
  });
  const quizzes = reading_quizzes ?? [];
  const chapters = book_chapters ?? [];

  return computeOverview({ book: book as Book, today, sessions, highlights, reviews, quizzes, chapters, practice, theme: parseBookTheme(rawTheme) });
}

/* ------------------------------------------------------------------ */
/* The question bank's summary (pds.reading_bank_summary)               */
/* ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};
const countOrNull = (v: unknown): number | null => (v == null ? null : count(v));
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The summary function's answer as the overview carries it, or null when it is not one (a missing book, another
 * shape, an error body). Counts are clamped to whole numbers >= 0 and the dates must be days, so a malformed answer
 * can never turn into a wrong XP figure.
 */
export function parsePracticeSummary(raw: unknown): PracticeSummary | null {
  if (!isObject(raw) || typeof raw.book_id !== "number") return null;
  const stages = isObject(raw.stages) ? raw.stages : {};
  const ratio = (v: unknown) => {
    const o = isObject(v) ? v : {};
    const n = count(o.n);
    return { n, right: Math.min(n, count(o.right)) };
  };
  const xp = isObject(raw.xp) ? raw.xp : {};
  return {
    bookId: raw.book_id,
    enabled: raw.enabled === true,
    pausedReason: raw.paused_reason === "owner" || raw.paused_reason === "budget" ? raw.paused_reason : null,
    mapping: raw.mapping === "ok" || raw.mapping === "uncertain" ? raw.mapping : "unknown",
    approvedCents: countOrNull(raw.approved_cents),
    spentCents: Math.max(0, Math.round(Number(raw.spent_cents) || 0)),
    quizThrough: count(raw.quiz_through),
    due: count(raw.due),
    newReady: count(raw.new_ready),
    stages: { new: count(stages.new), seen: count(stages.seen), recalled: count(stages.recalled), explained: count(stages.explained), kept: count(stages.kept) },
    recall7d: ratio(raw.recall_7d),
    recall21d: ratio(raw.recall_21d),
    chapters: (Array.isArray(raw.chapters) ? raw.chapters : [])
      .filter((c): c is Record<string, unknown> => isObject(c) && typeof c.chapter === "number")
      .map((c) => ({
        chapter: c.chapter as number,
        status: typeof c.status === "string" ? c.status : "pending",
        ideas: countOrNull(c.ideas),
        questions: countOrNull(c.questions),
        sources: countOrNull(c.sources),
      })),
    voided: count(raw.voided),
    pending: count(raw.pending),
    counted: { correct: count(xp.correct), partial: count(xp.partial) },
    days: [...new Set((Array.isArray(raw.practice_days) ? raw.practice_days : []).filter((d): d is string => typeof d === "string" && YMD_RE.test(d)))],
  };
}

/** One RPC; any failure (function not applied yet, network, malformed answer) is "no summary", never an error. */
async function readPracticeSummary(supabase: Supa, slug: string | null): Promise<PracticeSummary | null> {
  try {
    const { data, error } = await supabase.rpc("reading_bank_summary", { p_slug: slug });
    if (error) return null;
    return parsePracticeSummary(data);
  } catch {
    return null;
  }
}

/**
 * The titles of the question-bank ideas Riley's highlights are linked to, for the highlight form's concept picker
 * (GET /api/reading/idea-titles; sql/reading_book_theme.sql pds.reading_bank_linked_idea_titles). The database applies
 * the spoiler gate, the edition check and the valid-evidence rule, and answers [] while the book's bank is off, so
 * nothing locked leaves it. Read on demand, never inside the overview (which stays at the book, today and the
 * summary). Any failure (the function not applied yet, an error, another shape) is no titles, never an error.
 */
export async function getLinkedIdeaTitles(supabase: Supa, slug: string | null): Promise<string[]> {
  try {
    const { data, error } = await supabase.rpc("reading_bank_linked_idea_titles", { p_slug: slug });
    if (error) return [];
    return parseIdeaTitles(data);
  } catch {
    return [];
  }
}

/**
 * Chapter questions ready for today's round, for Today's one-line "Practice · 6 ready": ideas due plus ideas never
 * asked yet, at most a round (8). 0 while the bank is off, so Today shows nothing then. Defined in an import-free file
 * that Today imports too (lib/reading-practice-ready.ts), so the two cannot drift.
 */
export { practiceReady, PRACTICE_ROUND_SIZE } from "@/lib/reading-practice-ready";

/* ------------------------------------------------------------------ */
/* Derivations                                                          */
/* ------------------------------------------------------------------ */

export function computeOverview(input: {
  book: Book;
  today: string;
  sessions: ReadingSession[];
  highlights: Highlight[];
  reviews: ReviewDate[];
  quizzes: Quiz[];
  chapters?: ChapterSpan[];
  /** pds.reading_bank_summary parsed (getOverview); absent or null = the question bank is not set up. */
  practice?: PracticeSummary | null;
  /** pds.books.theme parsed (parseBookTheme); absent = the generic defaults. */
  theme?: BookTheme | null;
}): ReadingOverview {
  const { book, today, sessions, highlights, reviews } = input;
  const theme = input.theme ?? defaultBookTheme();
  // The summary is resolved by slug in the database, the book by its own query: one about another book is not used.
  const practice = input.practice && input.practice.bookId === book.book_id ? input.practice : null;
  // Every result stays listed with its verification; one whose question was corrected later earns nothing.
  const quizzes = input.quizzes.map((q) => ({ ...q, verification: quizVerification(q) }));
  const countedQuizzes = quizzes.filter((q) => q.verification !== "invalidated");
  const chapters = input.chapters ?? [];
  const totalChapters = book.total_chapters ?? 0;
  const chaptersDone = Math.min(
    totalChapters || Infinity,
    sessions.reduce((m, s) => Math.max(m, s.chapter_through ?? 0), 0),
  );
  const percent = totalChapters ? Math.round((chaptersDone / totalChapters) * 100) : 0;

  // Pace: linear target from start_date to target_date.
  const start = book.start_date ?? today;
  const target = book.target_date ?? addDays(start, 30);
  const totalDays = Math.max(1, daysBetween(start, target));
  const daysElapsed = Math.min(totalDays, Math.max(0, daysBetween(start, today) + 1)); // day 1 = start_date
  const daysLeft = Math.max(0, daysBetween(today, target));
  const expectedToday = totalChapters ? Math.min(totalChapters, Math.ceil((totalChapters * daysElapsed) / totalDays)) : 0;
  const aheadBy = chaptersDone - expectedToday;
  const remaining = Math.max(0, totalChapters - chaptersDone);
  const perDayNeeded = daysLeft > 0 ? Math.round((remaining / daysLeft) * 10) / 10 : remaining;

  // Streak: consecutive behavioral days with a session, ending today or yesterday.
  const days = new Set(sessions.map((s) => s.session_date));
  const loggedToday = days.has(today);
  let current = 0;
  let cursor = loggedToday ? today : addDays(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let best = 0;
  const sortedDays = [...days].sort();
  let run = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    run = i > 0 && daysBetween(sortedDays[i - 1], sortedDays[i]) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  best = Math.max(best, current);

  // XP
  const recallSessions = sessions.filter((s) => (s.recall ?? "").trim().length >= 40).length;
  const reviewDays = new Set(reviews.map((r) => r.review_date));
  // A day with a chapter question answered is a review day too: one day, never two (READ-QUIZ-01).
  const practiceDays = new Set(practice?.days ?? []);
  const activeReviewDays = new Set([...reviewDays, ...practiceDays]);
  const reviewsToday = reviews.filter((r) => r.review_date === today).length;
  const quizPoints = countedQuizzes.reduce((a, q) => a + q.score, 0);
  const checkpoints = computeCheckpoints(book, sessions, quizzes, today, start, target);
  const onTimeCheckpoints = checkpoints.filter((c) => c.reached && c.onTime === true).length;
  const xp: XpBreakdown = {
    chapters: chaptersDone * XP.perChapter,
    recalls: recallSessions * XP.perRecall,
    highlights: highlights.reduce((a, h) => a + ((h.comment ?? "").trim() ? XP.perHighlightWithComment : XP.perHighlightBare), 0),
    reviews: activeReviewDays.size * XP.perReviewDay,
    practice: (practice?.counted.correct ?? 0) * XP.perPracticeCorrect + (practice?.counted.partial ?? 0) * XP.perPracticePartial,
    quizzes: quizPoints * XP.perQuizPoint,
    checkpoints: onTimeCheckpoints * XP.perCheckpointOnTime,
    total: 0,
  };
  xp.total = xp.chapters + xp.recalls + xp.highlights + xp.reviews + xp.practice + xp.quizzes + xp.checkpoints;
  const levelN = Math.floor(xp.total / XP.perLevel) + 1;
  const level = {
    n: levelN,
    title: theme.levelTitles[Math.min(theme.levelTitles.length - 1, levelN - 1)] ?? DEFAULT_LEVEL_TITLES[0],
    intoLevel: xp.total % XP.perLevel,
    perLevel: XP.perLevel,
  };

  const badges = computeBadges({ book, sessions, highlights, reviews, practiceDays: [...practiceDays], quizzes: countedQuizzes, checkpoints, chaptersDone, totalChapters, best, theme });

  // Burn-up series: one point per day from start to target.
  const burnup: ReadingOverview["burnup"] = [];
  const byDay = new Map<string, number>();
  for (const s of [...sessions].sort((a, b) => (a.session_date < b.session_date ? -1 : 1))) {
    const prev = byDay.get(s.session_date) ?? 0;
    byDay.set(s.session_date, Math.max(prev, s.chapter_through ?? 0));
  }
  let running = 0;
  for (let d = start, i = 1; d <= target && i <= totalDays + 1; d = addDays(d, 1), i++) {
    running = Math.max(running, byDay.get(d) ?? 0);
    burnup.push({
      date: d,
      actual: d <= today ? running : null,
      target: totalChapters ? Math.min(totalChapters, Math.ceil((totalChapters * i) / totalDays)) : 0,
    });
  }

  // Due reviews: next_review <= today (or never scheduled), oldest due first.
  const dueReviews = highlights
    .filter((h) => !h.archived && (h.next_review === null || h.next_review <= today))
    .sort((a, b) => (a.next_review ?? "0000") < (b.next_review ?? "0000") ? -1 : 1)
    .slice(0, 5);

  const atRisk = !loggedToday && current > 0;
  const minutesTotal = sessions.reduce((a, s) => a + (s.minutes ?? 0), 0);

  // Whispersync position → chapter / page / percent.
  let position: ReadingOverview["position"] = null;
  if (book.last_position != null) {
    let ch: ChapterSpan | null = null;
    for (const c of chapters) {
      if (c.start_position <= book.last_position) ch = c;
      else break;
    }
    let page: number | null = null;
    if (ch && ch.start_page != null && ch.end_page != null && ch.end_position != null && ch.end_position > ch.start_position) {
      const frac = (book.last_position - ch.start_position) / (ch.end_position - ch.start_position);
      page = Math.min(ch.end_page, ch.start_page + Math.floor(frac * (ch.end_page - ch.start_page + 1)));
    }
    position = {
      chapter: ch?.chapter ?? null,
      page,
      percent: book.total_positions ? Math.round((book.last_position / book.total_positions) * 100) : null,
      at: book.last_position_at,
    };
  }

  return {
    book,
    today,
    chaptersDone: totalChapters ? chaptersDone : sessions.reduce((m, s) => Math.max(m, s.chapter_through ?? 0), 0),
    totalChapters,
    percent,
    pace: { expectedToday, aheadBy, perDayNeeded, daysLeft, daysElapsed, totalDays, onTrack: aheadBy >= 0 },
    streak: { current, best, loggedToday, atRisk },
    xp,
    level,
    badges,
    theme,
    checkpoints,
    practice,
    sessions,
    highlights,
    dueReviews,
    reviewsToday,
    quizzes,
    burnup,
    minutesTotal,
    position,
    chapters,
  };
}

/**
 * The three checkpoints sit at 30% / 65% / 100% of the book (for 40 chapters: 12, 26, 40). One list for the overview,
 * the in-app checkpoint quiz and its server (lib/reading-checkpoint.ts), so they can never disagree.
 */
export const CHECKPOINT_FRACTIONS = [0.3, 0.65, 1] as const;
/** A checkpoint quiz asks this many questions, one per idea, and passes at CHECKPOINT_PASS. */
export const CHECKPOINT_SIZE = 10;
export const CHECKPOINT_PASS = 0.8;
export const checkpointChapters = (total: number): number[] => (total > 0 ? CHECKPOINT_FRACTIONS.map((f) => Math.round(total * f)) : []);
export const checkpointKey = (chapter: number) => `ch${chapter}`;
/** First chapter of the act a checkpoint closes: the chapter after the previous checkpoint (1 for the first). */
export function checkpointActStart(total: number, chapter: number): number {
  const earlier = checkpointChapters(total).filter((c) => c < chapter);
  return earlier.length ? Math.max(...earlier) + 1 : 1;
}

/**
 * Whether the checkpoint tile offers "Start checkpoint": the bank is on, the checkpoint chapter is quizzable (the
 * spoiler gate), the chapters up to it hold enough ideas for a quiz of CHECKPOINT_SIZE questions, and the checkpoint
 * has no passed quiz and none recorded today (a quiz key is one per day). The idea count is the summary's, an
 * estimate: the server counts the ideas not asked in the last 7 days and says so when too few are left.
 */
export function checkpointOffer(o: Pick<ReadingOverview, "practice" | "today">, c: Checkpoint): boolean {
  const p = o.practice;
  if (!p?.enabled || p.quizThrough < c.chapter) return false;
  const q = c.quiz;
  if (q && q.verification !== "invalidated") {
    if (q.total > 0 && q.score / q.total >= CHECKPOINT_PASS) return false;
    if (q.quiz_date === o.today) return false;
  }
  const ideas = p.chapters.filter((x) => x.chapter >= 1 && x.chapter <= c.chapter).reduce((n, x) => n + (x.ideas ?? 0), 0);
  return ideas >= CHECKPOINT_SIZE;
}

function computeCheckpoints(
  book: Book,
  sessions: ReadingSession[],
  quizzes: Quiz[],
  today: string,
  start: string,
  target: string,
): Checkpoint[] {
  const total = book.total_chapters ?? 0;
  if (!total) return [];
  const totalDays = Math.max(1, daysBetween(start, target));
  // 30% / 65% / 100% of the book. For 40 chapters: 12, 26, 40.
  return CHECKPOINT_FRACTIONS.map((f) => {
    const chapter = Math.round(total * f);
    const due = f === 1 ? target : addDays(start, Math.round(totalDays * f) - 1);
    // First date the chapter was reached.
    const reachedOn = [...sessions]
      .filter((s) => (s.chapter_through ?? 0) >= chapter)
      .map((s) => s.session_date)
      .sort()[0];
    const reached = !!reachedOn;
    const onTime = reached ? reachedOn! <= due : today > due ? false : null;
    const key = checkpointKey(chapter);
    // Newest first (the read orders by taken_at desc): the newest result still counted, else the newest corrected one.
    // When a newer result for the key was invalidated (a question in it was corrected later) and an older counted result
    // is shown instead, the checkpoint says so (correctedNewer) so the score change is not unexplained (PR 362 follow-up).
    const keyQuizzes = quizzes.filter((q) => q.checkpoint === key);
    let shown: Quiz | null = null;
    let invalidatedNewer: Quiz | null = null;
    for (const q of keyQuizzes) {
      if (q.verification === "invalidated") {
        // Only the newest invalidated result that sits BEFORE the counted one is the one being corrected away.
        if (shown === null && invalidatedNewer === null) invalidatedNewer = q;
        continue;
      }
      if (shown === null) shown = q;
      else break;
    }
    const quiz = shown ?? keyQuizzes[0] ?? null;
    const correctedNewer = !!(shown && invalidatedNewer);
    return {
      key,
      chapter,
      due,
      reached,
      onTime,
      quiz,
      correctedNewer,
      correctedNewerQuiz: correctedNewer && invalidatedNewer ? { date: invalidatedNewer.quiz_date, score: invalidatedNewer.score, total: invalidatedNewer.total } : null,
    };
  });
}

function computeBadges(ctx: {
  book: Book;
  sessions: ReadingSession[];
  highlights: Highlight[];
  reviews: ReviewDate[];
  /** Days a chapter question was answered: they join the review days for the Reviewer badge. */
  practiceDays?: string[];
  quizzes: Quiz[];
  checkpoints: Checkpoint[];
  chaptersDone: number;
  totalChapters: number;
  best: number;
  /** The book's theme: it may rename a badge (DEFAULT_BADGE_LABELS holds the generic labels). */
  theme?: BookTheme;
}): Badge[] {
  const { sessions, highlights, reviews, quizzes, checkpoints, chaptersDone, totalChapters, best } = ctx;
  const labels = ctx.theme?.badgeLabels ?? {};
  const firstSession = [...sessions].sort((a, b) => (a.session_date < b.session_date ? -1 : 1))[0];
  const earliest = (pred: (s: ReadingSession) => boolean) =>
    [...sessions].filter(pred).map((s) => s.session_date).sort()[0] ?? null;
  const cps = checkpoints;
  // A book with no chapter count has no checkpoints: those two badges stay unearned (never a made-up chapter number).
  const cp1 = cps[0]?.chapter ?? null;
  const cp2 = cps[1]?.chapter ?? null;
  const commented = highlights.filter((h) => (h.comment ?? "").trim());
  const reviewDays = [...new Set([...reviews.map((r) => r.review_date), ...(ctx.practiceDays ?? [])])].sort();
  const passedQuizzes = quizzes.filter((q) => q.total > 0 && q.score / q.total >= 0.8);
  const audioSessions = sessions.filter((s) => s.medium === "audio");

  // The label is the theme's when it names one, else the generic default (the keys name no book).
  const badge = (key: string, description: string, earnedOn: string | null): Badge => ({
    key,
    label: labels[key] ?? DEFAULT_BADGE_LABELS[key] ?? key,
    description,
    earned: !!earnedOn,
    earnedOn,
  });

  return [
    badge("first-session", "Log your first session", firstSession?.session_date ?? null),
    badge("checkpoint-1", cp1 === null ? "Reach the first checkpoint" : `Reach chapter ${cp1}`, cp1 === null ? null : earliest((s) => (s.chapter_through ?? 0) >= cp1)),
    badge("checkpoint-2", cp2 === null ? "Reach the second checkpoint" : `Reach chapter ${cp2}`, cp2 === null ? null : earliest((s) => (s.chapter_through ?? 0) >= cp2)),
    badge("finisher", "Reach the last chapter", totalChapters && chaptersDone >= totalChapters ? earliest((s) => (s.chapter_through ?? 0) >= totalChapters) : null),
    badge("streak-7", "A 7-day session streak", best >= 7 ? "✓" : null),
    badge("scribe", "10 highlights with a comment", commented.length >= 10 ? commented.map((h) => h.created_at.slice(0, 10)).sort()[9] : null),
    badge("reviewer", "Practice on 5 different days", reviewDays.length >= 5 ? reviewDays[4] : null),
    badge("quiz-master", "Score 80%+ on a checkpoint quiz", passedQuizzes.length ? passedQuizzes.map((q) => q.quiz_date).sort()[0] : null),
    badge("on-pace", "Hit every checkpoint on time", cps.length && cps.every((c) => c.reached && c.onTime) ? cps[cps.length - 1].due : null),
    badge("runner", "5 audio sessions", audioSessions.length >= 5 ? audioSessions.map((s) => s.session_date).sort()[4] : null),
  ];
}

/* ------------------------------------------------------------------ */
/* Writes                                                               */
/* ------------------------------------------------------------------ */

export interface LogSessionInput {
  slug?: string | null;
  book_id?: number | null;
  date?: string | null;
  chapter_through: number;
  chapter_from?: number | null;
  minutes?: number | null;
  medium?: Medium | null;
  recall?: string | null;
  question?: string | null;
  /** 'manual' (the /reading form) or 'chat' (the Claude tool). Kindle-derived sessions are written by lib/reading-kindle.ts only. */
  source?: "manual" | "chat" | null;
  /**
   * Idempotency key (a UUID) from the autosaving /log form: a POST retried after a lost answer returns the session
   * the first one made, with no second XP, habit stamp or Notion entry (sql/reading_sessions_client_key.sql).
   */
  client_key?: string | null;
  /**
   * Onyx Chat (SEC-04): the session must be stored WITH its key, because a retried chat message can only find it by
   * that key. A key that is not a UUID, or a key column that is missing, is then refused (SESSION_KEY_REQUIRED) and
   * nothing is written, never a session without its key. A keyed create is never stored without its key for any
   * caller (PR 376); without this flag a missing column is refused with the /log form's own text.
   */
  require_client_key?: boolean;
}
/** logSession refused a session that had to carry its client_key (require_client_key): nothing was written. */
export const SESSION_KEY_REQUIRED = "client_key could not be stored with this session, so nothing was written";
export interface LogSessionResult {
  ok: true;
  book: Book;
  session: ReadingSession;
  xpGained: number;
  finished: boolean;
  habitMarked: boolean;
  /** True when this call made the day's habit row (none existed); null when unknown (a replay). */
  habitCreated: boolean | null;
  /** A retry of an earlier create (same client_key): the stored session, nothing written. */
  replayed: boolean;
  /**
   * The Notion work a keyed create stored in its own transaction (pds.create_reading_session; Codex review of PR 376,
   * round 2 of T01-R14): the claim that owes the session's entry and the progress obligation of its book (null = none
   * stored: no Notion page, a keyless create, or a replay, whose first create stored them and the sweep finishes).
   */
  mirrorClaimId: string | null;
  progressOwedId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client_key column (sql/reading_sessions_client_key.sql, applied 2026-11-15). Without it a keyed create is
 * refused (logSession) rather than stored without its key. Codes only: a unique violation (23505) also names the
 * client_key index and must never read as "no column".
 */
function missingColumn(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204");
}

/**
 * Discarded entries (sql/reading_session_discards.sql, PROD-T01): a client_key whose entry was discarded can never
 * create a session again. The insert trigger refuses one with this SQLSTATE; the POST route answers 409 with
 * DISCARDED_ENTRY_ERROR, and the /log form then continues the entry under a new key.
 */
const DISCARDED_KEY_CODE = "OXR01";
export const DISCARDED_ENTRY_ERROR = "This reading entry was discarded.";
const DISCARD_UNAVAILABLE = "Removing a session isn't available until sql/reading_session_discards.sql is applied.";
/** A keyed create needs pds.create_reading_session; without it the create is refused (503), never done in steps. */
const KEYED_CREATE_UNAVAILABLE = "Reading sessions can't be saved here until sql/reading_session_discards.sql is applied.";

/** sql/reading_session_discards.sql (or the client_key column it reads) is not applied yet. */
function discardsMissing(error: { code?: string } | null | undefined): boolean {
  return !!error && (["PGRST202", "42883", "42P01"].includes(String(error.code)) || missingColumn(error));
}

/**
 * What a removal still owes outside the database (pds.reading_session_removals): the session's Notion entry to trash
 * and the book page's progress line. `done` = the entry was trashed (mirror_done_at set); a removal whose answer was
 * lost is found here by its retry and the route replays the cleanup (Codex review of PR 376).
 */
export interface RemovalCleanup {
  sessionId: number;
  bookId: number;
  sessionDate: string | null;
  notionBlockId: string | null;
  unfinished: boolean;
  done: boolean;
}

function cleanupOf(raw: unknown): RemovalCleanup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sessionId = Number(r.session_id);
  const bookId = Number(r.book_id);
  if (!Number.isFinite(sessionId) || !Number.isFinite(bookId)) return null;
  return {
    sessionId,
    bookId,
    sessionDate: typeof r.session_date === "string" ? r.session_date : null,
    notionBlockId: typeof r.notion_block_id === "string" && r.notion_block_id ? r.notion_block_id : null,
    unfinished: r.unfinished === true,
    done: r.mirror_done_at !== null && r.mirror_done_at !== undefined,
  };
}

const KINDLE_SESSION_CODE = "OXR02";
const BOOK_MISSING_CODE = "OXR03";
const BOOK_KEYS = BOOK_COLS.split(",").map((c) => c.trim());

type RemovalOutcome =
  | { kind: "removed"; session: ReadingSession; book: Book; unfinished: boolean; habitRemoved: boolean; cleanup: RemovalCleanup | null }
  | { kind: "absent"; cleanup: RemovalCleanup | null }
  | { kind: "failed"; status: number; error: string };

/**
 * One removal in ONE database call (pds.remove_reading_session, sql/reading_session_discards.sql): the key is recorded
 * as discarded under its lock, then the session is deleted, the finish it caused and the habit Yes it made are taken
 * back, and the Notion cleanup still owed is written down, all in one transaction. A removal whose answer is lost
 * leaves nothing half done in the database, and its retry gets that cleanup row (`absent`). A missing function (the
 * file not applied, or not yet in PostgREST's schema cache) is 503 and nothing is removed: there is no fallback to
 * separate requests (Codex review of PR 376).
 */
async function removeSessionTx(
  supabase: Supa,
  by: { sessionId: number } | { clientKey: string },
  habitCreatedOn: string | null,
): Promise<RemovalOutcome> {
  const { data, error } = await supabase.rpc("remove_reading_session", {
    p_session_id: "sessionId" in by ? by.sessionId : null,
    p_client_key: "clientKey" in by ? by.clientKey : null,
    p_habit_created_on: habitCreatedOn,
  });
  if (error) {
    if (error.code === KINDLE_SESSION_CODE) return { kind: "failed", status: 409, error: "Kindle sessions are written by the harvester and can't be edited here." };
    if (error.code === BOOK_MISSING_CODE) return { kind: "failed", status: 404, error: "The session's book no longer exists." };
    if (discardsMissing(error)) return { kind: "failed", status: 503, error: DISCARD_UNAVAILABLE };
    return { kind: "failed", status: 500, error: error.message };
  }
  return removalOutcomeOf(data);
}

const REMOVAL_UNCONFIRMED = "The removal was not confirmed. Try again.";

/**
 * Reads pds.remove_reading_session's answer (Codex T01-R8). Only an explicit outcome counts: `removed` must be a
 * boolean; `removed: false` must carry its `removal` (null = nothing on record, else a well-formed cleanup row);
 * `removed: true` must carry the session and its book with their ids. Anything else (null, {}, a missing or
 * non-boolean `removed`, a malformed row) is "not confirmed" (500, retried): it is never read as "nothing stored",
 * so a Discard never clears an entry whose removal was not confirmed. Exported for the tests.
 */
export function removalOutcomeOf(data: unknown): RemovalOutcome {
  const unconfirmed: RemovalOutcome = { kind: "failed", status: 500, error: REMOVAL_UNCONFIRMED };
  if (!data || typeof data !== "object" || Array.isArray(data)) return unconfirmed;
  const out = data as { removed?: unknown; session?: unknown; book?: unknown; unfinished?: unknown; habit_removed?: unknown; removal?: unknown };
  if (typeof out.removed !== "boolean" || !("removal" in out)) return unconfirmed;
  if (out.removed === false) {
    if (out.removal === null) return { kind: "absent", cleanup: null };
    const cleanup = cleanupOf(out.removal);
    return cleanup ? { kind: "absent", cleanup } : unconfirmed;
  }
  const isRow = (v: unknown, idKey: string): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Number.isFinite(Number((v as Record<string, unknown>)[idKey])) && (v as Record<string, unknown>)[idKey] !== null;
  const rawSession = out.session;
  const rawBook = out.book;
  if (!isRow(rawSession, "session_id") || !isRow(rawBook, "book_id")) return unconfirmed;
  const session = Object.fromEntries(SESSION_KEYS.map((k) => [k, rawSession[k] ?? null])) as unknown as ReadingSession;
  const book = Object.fromEntries(BOOK_KEYS.map((k) => [k, rawBook[k] ?? null])) as unknown as Book;
  return { kind: "removed", session, book, unfinished: out.unfinished === true, habitRemoved: out.habit_removed === true, cleanup: cleanupOf(out.removal) };
}

/**
 * The removal's Notion cleanup is done (its entry trashed, or it had none): a later retry replays nothing. Closed
 * only for the work the caller actually did (Codex T01-R9): `blockId` is the Notion entry it trashed (null = it saw
 * none), and the row is closed only while it still records that same entry. A create callback that recorded a late
 * entry meanwhile (lib/reading-removal.ts trashLateBlock) changed the row's block id and reopened it, so a cleanup
 * that started before that, with no entry or another one, leaves the new work open for its owner or the sweep.
 */
export async function markRemovalMirrored(supabase: Supa, sessionId: number, blockId: string | null): Promise<void> {
  const base = supabase.from("reading_session_removals").update({ mirror_done_at: new Date().toISOString() }).eq("session_id", sessionId);
  const { error } = await (blockId === null ? base.is("notion_block_id", null) : base.eq("notion_block_id", blockId));
  if (error) console.error("reading: removal cleanup mark failed:", error.code ?? "unknown");
}

/**
 * Reopens a removal's cleanup row (mirror_done_at back to NULL) so the sweep runs it again. Used by a worker whose
 * progress write may have landed after another worker closed the row with a newer line (Codex review of PR 376,
 * round 5): the stale line must not stay in Notion with the row closed. Replaying a cleanup is idempotent.
 */
export async function reopenRemovalCleanup(supabase: Supa, sessionId: number): Promise<boolean> {
  const { error } = await supabase.from("reading_session_removals").update({ mirror_done_at: null }).eq("session_id", sessionId);
  if (error) console.error("reading: removal cleanup reopen failed:", error.code ?? "unknown");
  return !error;
}

const KEYED_CREATE_NEEDS_COLUMN = "Reading sessions can't be saved here until sql/reading_sessions_client_key.sql is applied.";
const SESSION_KEYS = SESSION_COLS.split(",").map((c) => c.trim());

/**
 * The keyed create in one transaction (pds.create_reading_session, sql/reading_session_discards.sql): the session, the
 * book's finish and the day's habit Yes. `unavailable` = that file is not applied (the caller then creates as before).
 */
async function createKeyedSession(
  supabase: Supa,
  key: string,
  row: {
    book_id: number;
    session_date: string;
    chapter_from: number | null;
    chapter_through: number;
    minutes: number | null;
    medium: string | null;
    recall: string | null;
    question: string | null;
    source: string;
  },
): Promise<
  | {
      kind: "created";
      session: ReadingSession;
      finished: boolean;
      habit: { marked: boolean; created: boolean };
      mirrorClaimId: string | null;
      progressOwedId: string | null;
    }
  | { kind: "error"; error: { code?: string; message?: string } }
  | { kind: "unavailable" }
> {
  const { data, error } = await supabase.rpc("create_reading_session", {
    p_client_key: key,
    p_book_id: row.book_id,
    p_session_date: row.session_date,
    p_chapter_from: row.chapter_from,
    p_chapter_through: row.chapter_through,
    p_minutes: row.minutes,
    p_medium: row.medium,
    p_recall: row.recall,
    p_question: row.question,
    p_source: row.source,
  });
  if (error) return ["PGRST202", "42883"].includes(String(error.code)) ? { kind: "unavailable" } : { kind: "error", error };
  const out = (data ?? {}) as {
    session?: Record<string, unknown>;
    finished?: boolean;
    habit_marked?: boolean;
    habit_created?: boolean;
    mirror_claim_id?: unknown;
    progress_owed_id?: unknown;
  };
  if (!out.session || typeof out.session !== "object") return { kind: "error", error: { message: "The session was not returned." } };
  const session = Object.fromEntries(SESSION_KEYS.map((k) => [k, out.session?.[k] ?? null])) as unknown as ReadingSession;
  const uuidOrNull = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
  return {
    kind: "created",
    session,
    finished: out.finished === true,
    habit: { marked: out.habit_marked === true, created: out.habit_created === true },
    mirrorClaimId: uuidOrNull(out.mirror_claim_id),
    progressOwedId: uuidOrNull(out.progress_owed_id),
  };
}

const MOVE_UNAVAILABLE = "Moving a session to another day or book isn't available until sql/reading_session_discards.sql is applied.";

/**
 * An edit of a session (pds.move_reading_session, sql/reading_session_discards.sql): its new values, the habit part
 * of a move and the books' finish state in ONE transaction (Codex review of PR 376, rounds 2 and 4). The new day's
 * habit is stamped and the old day's is settled from the habit row's own record, so the old day's Yes goes back also
 * when the browser knows no habit day (a create whose answer was lost and replayed). The finish is decided from the
 * row as it was under its lock, so an edit whose answer was lost leaves nothing for its retry to miss (the old book's
 * finish used to be taken back in a later request, from values the retry no longer saw). A failed habit part rolls
 * the edit back (500, the form retries). Without the function: 503 and nothing changed, never a move in separate
 * requests (updateSession falls back for an edit that keeps the day and the book only).
 */
async function moveSessionTx(
  supabase: Supa,
  sessionId: number,
  patch: {
    book_id: number;
    session_date: string;
    chapter_from: number;
    chapter_through: number;
    minutes: number | null;
    medium: string | null;
    recall: string | null;
    question: string | null;
  },
  habitCreatedOn: string | null,
  editSeq: number | null,
): Promise<
  | ({ ok: true; session: ReadingSession; book: Book | null; finished: boolean; unfinished: boolean; marked: boolean; created: boolean } & EditMirrorWork)
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase.rpc("move_reading_session", {
    p_session_id: sessionId,
    p_book_id: patch.book_id,
    p_session_date: patch.session_date,
    p_chapter_from: patch.chapter_from,
    p_chapter_through: patch.chapter_through,
    p_minutes: patch.minutes,
    p_medium: patch.medium,
    p_recall: patch.recall,
    p_question: patch.question,
    p_habit_created_on: habitCreatedOn,
    p_edit_seq: editSeq,
  });
  if (error) {
    if (error.code === KINDLE_SESSION_CODE) return { ok: false, status: 409, error: "Kindle sessions are written by the harvester and can't be edited here." };
    if (error.code === BOOK_MISSING_CODE) return { ok: false, status: 400, error: "No such book" };
    if (discardsMissing(error)) return { ok: false, status: 503, error: MOVE_UNAVAILABLE };
    return { ok: false, status: 500, error: error.message ?? "Couldn't move the session." };
  }
  const out = (data ?? null) as {
    moved?: unknown;
    stale?: unknown;
    session?: unknown;
    book?: unknown;
    finished?: unknown;
    unfinished?: unknown;
    habit_marked?: unknown;
    habit_created?: unknown;
    mirror_claim_id?: unknown;
    replaces_block_id?: unknown;
    moved_book?: unknown;
    entry_pending?: unknown;
    progress_owed?: unknown;
  } | null;
  if (!out || typeof out !== "object" || typeof out.moved !== "boolean") return { ok: false, status: 500, error: "The move was not confirmed. Try again." };
  if (!out.moved) return { ok: false, status: 404, error: "That session no longer exists." };
  if (out.stale === true) return { ok: false, status: 409, error: "A newer edit of this session was already saved." };
  const raw = out.session;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 500, error: "The move was not confirmed. Try again." };
  const session = Object.fromEntries(SESSION_KEYS.map((k) => [k, (raw as Record<string, unknown>)[k] ?? null])) as unknown as ReadingSession;
  const rawBook = out.book;
  const book =
    rawBook && typeof rawBook === "object" && !Array.isArray(rawBook) && Number.isFinite(Number((rawBook as Record<string, unknown>).book_id))
      ? (Object.fromEntries(BOOK_KEYS.map((k) => [k, (rawBook as Record<string, unknown>)[k] ?? null])) as unknown as Book)
      : null;
  return {
    ok: true,
    session,
    book,
    finished: out.finished === true,
    unfinished: out.unfinished === true,
    marked: out.habit_marked === true,
    created: out.habit_created === true,
    ...editMirrorWork(out),
  };
}

/**
 * The Notion work an edit owes, stored by pds.move_reading_session in the edit's own transaction (Codex T01-R12,
 * T01-R14): the route does it under these rows, and the sweep (lib/reading-removal.ts) finishes whatever the route
 * could not, also when the route never ran its Notion step because the RPC's answer was lost.
 */
export interface EditMirrorWork {
  /** The edit ran in pds.move_reading_session, so the fields below are what it stored (false: the plain-update fallback). */
  mirrorStored: boolean;
  /** The claim the route's entry work runs under: a move's new entry (owes it), or the rewrite of the session's entry. */
  mirrorClaimId: string | null;
  /**
   * A move to another book: the entry its claim replaces, as the edit's transaction read it under the session's lock.
   * The route uses this, never its own earlier read (Codex review of PR 376, round 2 of T01-R14): a create's callback
   * can attach the entry between that read and the move, and a stale "no entry" made the new entry's conditional attach
   * fail and dropped the move's claim, leaving the old entry on the old page and none on the new one.
   */
  mirrorReplaces: string | null;
  /**
   * Whether the edit's own transaction moved the session to another book, read under the session's lock. The route
   * dispatches on this, never on the book it read before the edit: a concurrent edit can have changed the session's
   * book in between, and a move treated as a plain refresh rewrote the old book's entry and dropped the move's claim.
   * null = not stored by the RPC (the plain-update fallback).
   */
  movedBook: boolean | null;
  /** A move's claim still owes the session's entry: nothing is rewritten now, that claim writes it from the session. */
  entryPending: boolean;
  /** One stored progress obligation per book whose page line this edit changed. */
  progressOwed: { bookId: number; owedId: string }[];
}

const NO_MIRROR_WORK: EditMirrorWork = { mirrorStored: false, mirrorClaimId: null, mirrorReplaces: null, movedBook: null, entryPending: false, progressOwed: [] };

function editMirrorWork(out: { mirror_claim_id?: unknown; replaces_block_id?: unknown; moved_book?: unknown; entry_pending?: unknown; progress_owed?: unknown }): EditMirrorWork {
  const claim = typeof out.mirror_claim_id === "string" && UUID_RE.test(out.mirror_claim_id) ? out.mirror_claim_id : null;
  const owed: { bookId: number; owedId: string }[] = [];
  if (Array.isArray(out.progress_owed)) {
    for (const o of out.progress_owed) {
      if (!o || typeof o !== "object") continue;
      const bookId = Number((o as Record<string, unknown>).book_id);
      const owedId = (o as Record<string, unknown>).owed_id;
      if (Number.isFinite(bookId) && typeof owedId === "string" && UUID_RE.test(owedId)) owed.push({ bookId, owedId });
    }
  }
  const replaces = typeof out.replaces_block_id === "string" && out.replaces_block_id ? out.replaces_block_id : null;
  return { mirrorStored: true, mirrorClaimId: claim, mirrorReplaces: replaces, movedBook: typeof out.moved_book === "boolean" ? out.moved_book : null, entryPending: out.entry_pending === true, progressOwed: owed };
}

/** A database error that proves nothing was stored: a data / constraint violation or an error the function raised. */
function isConfirmedRefusal(error: { code?: string }): boolean {
  const code = String(error.code ?? "");
  return /^(22|23|P0001)/.test(code) || code === "PGRST202" || code === "PGRST204";
}

async function sessionByClientKey(supabase: Supa, key: string): Promise<ReadingSession | null> {
  const { data, error } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("client_key", key).maybeSingle();
  if (error) return null; // column not there yet, or a read failure: behave as before (plain insert)
  return (data as ReadingSession | null) ?? null;
}

/** The furthest chapter of the book's sessions, leaving one session out (null = none left out). */
async function furthestChapter(supabase: Supa, bookId: number, except: number | null): Promise<number> {
  let q = supabase.from("reading_sessions").select("chapter_through").eq("book_id", bookId);
  if (except !== null) q = q.neq("session_id", except);
  const { data } = await q.order("chapter_through", { ascending: false }).limit(1);
  return (data?.[0]?.chapter_through as number | undefined) ?? 0;
}

const sessionXp = (through: number, prevMax: number, recall: string | null) =>
  Math.max(0, through - prevMax) * XP.perChapter + ((recall ?? "").length >= 40 ? XP.perRecall : 0);

/**
 * Stamp the book's habit Yes on `date`; `created` = no row for that day existed before. Used by keyless creates (chat).
 * Goes through pds.stamp_reading_habit (sql/reading_session_discards.sql), which records what the stamp did to the
 * habit row in the same transaction, so whichever session of that day goes last takes the Yes back (Codex review of
 * PR 376, round 2). Without that function (the file not applied yet) the plain upsert as before: a keyless create
 * never needed the discard fence.
 */
async function stampHabit(supabase: Supa, book: Book, date: string): Promise<{ marked: boolean; created: boolean }> {
  if (!book.habit_name) return { marked: false, created: false };
  const { data: stamped, error: rpcError } = await supabase.rpc("stamp_reading_habit", { p_cycle_date: date, p_question: book.habit_name });
  if (!rpcError) {
    const out = (stamped ?? {}) as { marked?: unknown; created?: unknown };
    return { marked: out.marked === true, created: out.created === true };
  }
  if (!["PGRST202", "42883"].includes(String(rpcError.code))) {
    console.error("reading: habit stamp failed:", rpcError.code ?? "unknown");
    return { marked: false, created: false };
  }
  const { data: had } = await supabase.from("habit_journal").select("answer").eq("cycle_date", date).eq("question", book.habit_name).maybeSingle();
  const { error } = await supabase
    .from("habit_journal")
    .upsert({ cycle_date: date, question: book.habit_name, category: "learning", answer: "Yes" }, { onConflict: "cycle_date,question" });
  if (error) {
    console.error("reading: habit stamp failed:", error.message);
    return { marked: false, created: false };
  }
  return { marked: true, created: !had };
}

/**
 * The book was finished by `previous` (its day is the finish day and it reached the last chapter) and that session
 * no longer does (edited below the end, moved to another book, or removed): back to reading when no other session
 * reaches the last chapter.
 */
async function undoFinishIfOnlyThis(supabase: Supa, book: Book, previous: ReadingSession, exceptSession: number): Promise<boolean> {
  const total = book.total_chapters;
  if (book.status !== "finished" || !total || (previous.chapter_through ?? 0) < total || book.finished_on !== previous.session_date) return false;
  const { data: rest } = await supabase
    .from("reading_sessions")
    .select("session_date")
    .eq("book_id", book.book_id)
    .gte("chapter_through", total)
    .neq("session_id", exceptSession)
    .order("session_date", { ascending: true })
    .limit(1);
  if (rest?.length) {
    // Another session still reaches the last chapter: the finish day moves to the earliest of them, so removing the
    // sessions oldest first cannot leave the book finished with nothing behind it (review of PR 376, round 3).
    const next = (rest[0] as { session_date: string }).session_date;
    if (next && next !== book.finished_on) await supabase.from("books").update({ finished_on: next }).eq("book_id", book.book_id);
    return false;
  }
  const { error } = await supabase.from("books").update({ status: "reading", finished_on: null }).eq("book_id", book.book_id);
  return !error;
}

export async function logSession(
  supabase: Supa,
  input: LogSessionInput,
): Promise<LogSessionResult | { ok: false; error: string; discarded?: true; unavailable?: true; retryable?: true }> {
  const key = typeof input.client_key === "string" && UUID_RE.test(input.client_key) ? input.client_key.toLowerCase() : null;
  if (input.require_client_key && !key) return { ok: false, error: SESSION_KEY_REQUIRED };
  /** The stored session of an earlier create with this key, with its own book (`fallback` only if that cannot be read). */
  const replay = async (prior: ReadingSession, fallback: Book | null): Promise<LogSessionResult | null> => {
    const { data: b } = await supabase.from("books").select(BOOK_COLS).eq("book_id", prior.book_id).maybeSingle();
    const ofSession = (b as Book | null) ?? fallback;
    if (!ofSession) return null;
    const prevMax = await furthestChapter(supabase, prior.book_id, prior.session_id);
    return {
      ok: true,
      book: ofSession,
      session: prior,
      xpGained: sessionXp(prior.chapter_through ?? 0, prevMax, prior.recall),
      finished: false,
      habitMarked: false,
      habitCreated: null,
      replayed: true,
      mirrorClaimId: null,
      progressOwedId: null,
    };
  };
  // A retried create answers its stored session BEFORE the book is resolved: the session it made may have finished
  // the book (no active book any more) or another book may be active now, and the retry of a create whose answer was
  // lost must still get that session back, not "No active book found".
  if (key) {
    const prior = await sessionByClientKey(supabase, key);
    const replayed = prior ? await replay(prior, null) : null;
    if (replayed) return replayed;
  }

  const book = input.book_id
    ? ((await supabase.from("books").select(BOOK_COLS).eq("book_id", input.book_id).maybeSingle()).data as Book | null)
    : await getBook(supabase, input.slug ?? null);
  if (!book) return { ok: false, error: "No active book found" };

  const through = Math.floor(Number(input.chapter_through));
  if (!Number.isFinite(through) || through < 0) return { ok: false, error: "chapter_through must be a non-negative integer" };
  if (book.total_chapters && through > book.total_chapters) {
    return { ok: false, error: `chapter_through cannot exceed ${book.total_chapters}` };
  }

  const date = input.date ?? (await behavioralToday(supabase));

  // chapter_from defaults to (previous max chapter) + 1.
  let from = input.chapter_from ?? null;
  const prevMax = await furthestChapter(supabase, book.book_id, null);
  if (from === null) from = Math.min(through, prevMax + 1);

  const medium = input.medium && ["audio", "kindle", "paper", "other"].includes(input.medium) ? input.medium : null;
  const row = {
    book_id: book.book_id,
    session_date: date,
    chapter_from: from,
    chapter_through: through,
    minutes: input.minutes != null && Number.isFinite(Number(input.minutes)) ? Math.max(0, Math.round(Number(input.minutes))) : null,
    medium,
    recall: input.recall?.trim() || null,
    question: input.question?.trim() || null,
    source: input.source === "chat" ? "chat" : "manual",
  };
  // A keyed create (the /log form's) runs as ONE database call: the session, the finish and the habit stamp commit
  // together under the key's lock, so a Discard of the key sees all of them or none (Codex review T01-R4 of PR 376:
  // with separate requests a Discard landing between them left a finished book or a habit Yes for a removed session).
  if (key) {
    const atomic = await createKeyedSession(supabase, key, row);
    if (atomic.kind === "created") {
      const { session, finished, habit, mirrorClaimId, progressOwedId } = atomic;
      return {
        ok: true,
        book: { ...book, status: finished ? "finished" : book.status, finished_on: finished ? date : book.finished_on },
        session,
        xpGained: sessionXp(through, prevMax, row.recall),
        finished,
        habitMarked: habit.marked,
        habitCreated: habit.created,
        replayed: false,
        mirrorClaimId,
        progressOwedId,
      };
    }
    if (atomic.kind === "error") {
      const error = atomic.error;
      if (error.code === "23505") {
        // The same create arrived twice at once: the other one made the session.
        const prior = await sessionByClientKey(supabase, key);
        const replayed = prior ? await replay(prior, book) : null;
        if (replayed) return replayed;
      }
      if (error.code === DISCARDED_KEY_CODE) return { ok: false, error: DISCARDED_ENTRY_ERROR, discarded: true };
      // Onyx Chat (require_client_key) gets its own refusal text; nothing is stored either way.
      if (missingColumn(error)) return { ok: false, error: input.require_client_key ? SESSION_KEY_REQUIRED : KEYED_CREATE_NEEDS_COLUMN };
      const message = error.message ?? "Couldn't save the session.";
      // Only a confirmed refusal (a constraint or a raised error) is a 4xx. A transport failure, a missing code, a
      // connection / resource / shutdown / internal class or a lost response may have committed the create: the
      // answer must be retryable (5xx) so the form's unknown-outcome handling replays the same key.
      return isConfirmedRefusal(error) ? { ok: false, error: message } : { ok: false, error: message, retryable: true };
    }
    // atomic.kind === "unavailable": pds.create_reading_session is not there (the file not applied, or not yet in
    // PostgREST's schema cache). The discard fence may be there all the same (a partly applied file, a stale cache),
    // so the create is NOT done in separate requests, which a Discard could land between (Codex review of PR 376):
    // 503, nothing stored, and the form retries.
    return { ok: false, error: KEYED_CREATE_UNAVAILABLE, unavailable: true };
  }
  // Keyless creates only (callers that sent no key): a plain insert, then the finish and the habit stamp.
  const { data, error } = await supabase.from("reading_sessions").insert(row).select(SESSION_COLS).single();
  if (error) return { ok: false, error: error.message };
  const session = data as ReadingSession;

  // XP gained by this session (chapters newly advanced + recall).
  const xpGained = sessionXp(through, prevMax, row.recall);

  // Finished?
  let finished = false;
  if (book.total_chapters && through >= book.total_chapters && book.status !== "finished") {
    await supabase.from("books").update({ status: "finished", finished_on: date }).eq("book_id", book.book_id);
    finished = true;
  }

  // Stamp the habit (Yes) for the session day so /habits + the HRV pipeline see it.
  const habit = await stampHabit(supabase, book, date);

  return {
    ok: true,
    book: { ...book, status: finished ? "finished" : book.status, finished_on: finished ? date : book.finished_on },
    session,
    xpGained,
    finished,
    habitMarked: habit.marked,
    habitCreated: habit.created,
    replayed: false,
    mirrorClaimId: null,
    progressOwedId: null,
  };
}

/* ------------------------------------------------------------------ */
/* Editing a session the form just created (autosave, 2026-11-15)       */
/* ------------------------------------------------------------------ */

/** A PATCH /api/reading/sessions/[id] body. `date` / `book` absent or null = keep the session's own. */
export interface SessionUpdate {
  book: string | null;
  date: string | null;
  chapter_through: number;
  chapter_from: number | null;
  minutes: number | null;
  medium: Medium | null;
  recall: string | null;
  question: string | null;
  /**
   * The day this session's create (or last move) made the book's habit row on, as the server reported it
   * (`habit_created_on`); null = it made none, or unknown. Moving the session off that day takes the row back
   * when no other session is on it.
   */
  habit_created_on: string | null;
  /** The form's own rising edit number: an edit older than the stored one is refused (Codex review of PR 376). */
  edit_seq: number | null;
}

const SESSION_UPDATE_FIELDS = new Set(["book", "date", "chapter_through", "chapter_from", "minutes", "medium", "recall", "question", "habit_created_on", "edit_seq"]);
const SESSION_TEXT_MAX = 20000;

/** A real calendar date as YYYY-MM-DD, or null. */
export function ymdOrNull(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) return undefined;
  return new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v ? v : undefined;
}

/**
 * Parse a session PATCH body (pure). Unknown fields are refused, numbers must be whole and not negative, dates
 * real YYYY-MM-DD; the recall note and question are strings (stored as typed apart from the surrounding whitespace,
 * like logSession). The chapter limit and "not after today" need the book and the day, so updateSession checks them.
 */
export function parseSessionUpdate(raw: unknown): { ok: true; input: SessionUpdate } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!SESSION_UPDATE_FIELDS.has(k)) return { ok: false, error: `unknown field ${k}` };
  const whole = (v: unknown, name: string): number | null | { error: string } => {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0) return { error: `${name} must be a whole number, 0 or more` };
    return n;
  };
  const through = whole(b.chapter_through, "chapter_through");
  if (through !== null && typeof through === "object") return { ok: false, error: through.error };
  if (through === null) return { ok: false, error: "chapter_through is required" };
  const from = whole(b.chapter_from, "chapter_from");
  if (from !== null && typeof from === "object") return { ok: false, error: from.error };
  if (from !== null && from > through) return { ok: false, error: "chapter_from must be at most chapter_through" };
  const minutes = whole(b.minutes, "minutes");
  if (minutes !== null && typeof minutes === "object") return { ok: false, error: minutes.error };
  const date = ymdOrNull(b.date);
  if (date === undefined) return { ok: false, error: "date must be YYYY-MM-DD" };
  const habitCreatedOn = ymdOrNull(b.habit_created_on);
  if (habitCreatedOn === undefined) return { ok: false, error: "habit_created_on must be YYYY-MM-DD" };
  const editSeq = b.edit_seq === undefined || b.edit_seq === null ? null : b.edit_seq;
  if (editSeq !== null && !(typeof editSeq === "number" && Number.isSafeInteger(editSeq) && editSeq > 0)) return { ok: false, error: "edit_seq must be a positive integer" };
  let medium: Medium | null = null;
  if (b.medium !== undefined && b.medium !== null && b.medium !== "") {
    if (typeof b.medium !== "string" || !["audio", "kindle", "paper", "other"].includes(b.medium)) return { ok: false, error: "medium must be audio, kindle, paper or other" };
    medium = b.medium as Medium;
  }
  const text = (v: unknown, name: string): string | null | { error: string } => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return { error: `${name} must be text` };
    if (v.length > SESSION_TEXT_MAX) return { error: `${name} is too long` };
    return v;
  };
  const recall = text(b.recall, "recall");
  if (recall !== null && typeof recall === "object") return { ok: false, error: recall.error };
  const question = text(b.question, "question");
  if (question !== null && typeof question === "object") return { ok: false, error: question.error };
  let book: string | null = null;
  if (b.book !== undefined && b.book !== null && b.book !== "") {
    if (typeof b.book !== "string" || b.book.length > 200) return { ok: false, error: "book must be a slug" };
    book = b.book;
  }
  return { ok: true, input: { book, date, chapter_through: through, chapter_from: from, minutes, medium, recall, question, habit_created_on: habitCreatedOn, edit_seq: editSeq } };
}

export type SessionEditResult =
  | ({
      ok: true;
      book: Book;
      previousBook: Book;
      session: ReadingSession;
      previous: ReadingSession;
      xpGained: number;
      finished: boolean;
      /** The edit took back a finish this session had caused. */
      unfinished: boolean;
      habitMarked: boolean;
      /** The day of the habit row this session made, after the edit (send it back with the next edit); null = none. */
      habitCreatedOn: string | null;
    } & EditMirrorWork)
  | { ok: false; status: number; error: string };

async function editableSession(
  supabase: Supa,
  sessionId: number,
): Promise<{ ok: true; session: ReadingSession; book: Book } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabase.from("reading_sessions").select(SESSION_COLS).eq("session_id", sessionId).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  const session = data as ReadingSession | null;
  if (!session) return { ok: false, status: 404, error: "That session no longer exists." };
  if (session.source !== "manual" && session.source !== "chat") {
    return { ok: false, status: 409, error: "Kindle sessions are written by the harvester and can't be edited here." };
  }
  // A failed read is an error, never "gone": a 404 tells the /log form the session is no longer stored (Codex T01-R5).
  const { data: bookRow, error: bookErr } = await supabase.from("books").select(BOOK_COLS).eq("book_id", session.book_id).maybeSingle();
  if (bookErr) return { ok: false, status: 500, error: bookErr.message };
  if (!bookRow) return { ok: false, status: 404, error: "The session's book no longer exists." };
  return { ok: true, session, book: bookRow as Book };
}

/**
 * Update a manual or chat session in place (the autosaving /log form edits the session it created). Same rules as
 * logSession: chapter_through not past the book's last chapter, chapter_from defaulting to the furthest chapter of
 * the book's OTHER sessions + 1, the day not after behavioral today. Kindle sessions are refused (409).
 * What an earlier saved value did is undone when the edit takes it away:
 *  - reaching the last chapter finishes the book; editing back below it (or moving the session to another book)
 *    sets a finish this session caused back to reading when no other session reaches the last chapter; a moved
 *    finishing session moves the finish day with it;
 *  - a new day (or book) stamps that book's habit Yes there, and the old day's Yes is taken back when no other
 *    session of a book with the same habit is on that day and reading made it (the habit row's own record in the
 *    database, else `habit_created_on` for a session stamped before that record existed), in the same transaction
 *    as the move (pds.move_reading_session). A row reading did not make, or one answered again since (Riley's own
 *    answer), is never touched.
 */
export async function updateSession(supabase: Supa, sessionId: number, input: SessionUpdate): Promise<SessionEditResult> {
  const cur = await editableSession(supabase, sessionId);
  if (!cur.ok) return cur;
  const previous = cur.session;
  const previousBook = cur.book;
  let book = cur.book;
  if (input.book && input.book !== book.slug) {
    const other = await getBook(supabase, input.book);
    if (!other) return { ok: false, status: 400, error: "No such book" };
    book = other;
  }
  const through = input.chapter_through;
  if (book.total_chapters && through > book.total_chapters) {
    return { ok: false, status: 400, error: `chapter_through cannot exceed ${book.total_chapters}` };
  }
  let date = previous.session_date;
  if (input.date && input.date !== previous.session_date) {
    const today = await behavioralToday(supabase);
    if (input.date > today) return { ok: false, status: 400, error: "Pick today or an earlier day." };
    date = input.date;
  }

  const prevMax = await furthestChapter(supabase, book.book_id, sessionId);
  const from = input.chapter_from ?? Math.min(through, prevMax + 1);
  if (from > through) return { ok: false, status: 400, error: "chapter_from must be at most chapter_through" };

  const patch = {
    book_id: book.book_id,
    session_date: date,
    chapter_from: from,
    chapter_through: through,
    minutes: input.minutes,
    medium: input.medium,
    recall: input.recall?.trim() || null,
    question: input.question?.trim() || null,
  };
  const sameBook = book.book_id === previousBook.book_id;
  const moved = date !== previous.session_date || !sameBook;

  // Every edit is one transaction (pds.move_reading_session): the session, the habit part of a move (the new day
  // stamped, the old day's Yes taken back from the habit row's own record when this was the last session there; Codex
  // review of PR 376, round 2) and the finish of both books (round 4: done here in later requests, a move whose answer
  // was lost left the old book finished for good, because its retry read the moved session as the "before").
  const xpGained = sessionXp(through, prevMax, patch.recall);
  let session: ReadingSession;
  let habitMarked = false;
  let habitCreatedOn = input.habit_created_on;
  let finished = false;
  let unfinished = false;
  let finishedOn = book.finished_on;
  let status = book.status;
  let mirrorWork: EditMirrorWork = NO_MIRROR_WORK;
  const tx = await moveSessionTx(supabase, sessionId, patch, input.habit_created_on, input.edit_seq);
  if (tx.ok) {
    session = tx.session;
    mirrorWork = {
      mirrorStored: tx.mirrorStored,
      mirrorClaimId: tx.mirrorClaimId,
      mirrorReplaces: tx.mirrorReplaces,
      movedBook: tx.movedBook,
      entryPending: tx.entryPending,
      progressOwed: tx.progressOwed,
    };
    habitMarked = tx.marked;
    finished = tx.finished;
    unfinished = tx.unfinished;
    if (tx.book) {
      status = tx.book.status;
      finishedOn = tx.book.finished_on;
    }
    if (moved) {
      const sameRow = book.habit_name === previousBook.habit_name && date === previous.session_date;
      habitCreatedOn = sameRow ? input.habit_created_on : tx.created ? date : null;
    }
  } else if (moved || tx.status !== 503) {
    return tx;
  } else {
    // sql/reading_session_discards.sql not applied yet: an edit that keeps the day and the book is the plain update
    // and finish requests from before that file (a move is refused above).
    const { data, error } = await supabase.from("reading_sessions").update(patch).eq("session_id", sessionId).select(SESSION_COLS).single();
    if (error) return { ok: false, status: 500, error: error.message };
    session = data as ReadingSession;
    const total = book.total_chapters;
    const reachesEnd = !!total && through >= total;
    if (reachesEnd && book.status !== "finished") {
      await supabase.from("books").update({ status: "finished", finished_on: date }).eq("book_id", book.book_id);
      finished = true;
      status = "finished";
      finishedOn = date;
    }
    if (!reachesEnd) {
      unfinished = await undoFinishIfOnlyThis(supabase, previousBook, previous, sessionId);
      if (unfinished) {
        status = "reading";
        finishedOn = null;
      }
    }
  }

  return {
    ok: true,
    book: { ...book, status, finished_on: finishedOn },
    previousBook,
    session,
    previous,
    xpGained,
    finished,
    unfinished,
    habitMarked,
    habitCreatedOn,
    ...mirrorWork,
  };
}

/** The answer of a removal: what it removed, or (`removed: null`) that nothing of it is stored any more. */
export type SessionRemoval =
  | { ok: true; removed: ReadingSession; book: Book; unfinished: boolean; habitRemoved: boolean; cleanup: RemovalCleanup | null }
  /**
   * Nothing to remove. `cleanup` = an earlier removal of the same session (or key) whose answer may have been lost:
   * the route replays the Notion cleanup it still owes (`done` false). Its database part already committed with it.
   */
  | { ok: true; removed: null; unfinished: boolean; cleanup: RemovalCleanup | null }
  /**
   * `gone` = the database said, inside the removal's transaction, that no such session exists and none of it is on
   * record: the only failure the form may read as "already removed" (route code session_gone). Every other failure
   * (a 404 for a missing book included, where the session is still stored) leaves the entry on screen.
   */
  | { ok: false; status: number; error: string; gone?: true };

/**
 * Remove a manual or chat session (the autosaving form's "Remove this session"). A book this session finished
 * (finished on its day, and no other session reaches the last chapter) goes back to reading. The day's habit Yes
 * is taken back only when reading made it and no other session with the same habit is on that day: the habit row's
 * own record in the database decides (Codex T01-R7), else `habitCreatedOn`. All of it, and the session's client_key recorded as discarded (a create of that key still under way is
 * then refused instead of bringing the session back, Codex T01-R6), is ONE transaction (pds.remove_reading_session):
 * a removal whose answer is lost has removed everything or nothing, and its retry finds the cleanup row and gets
 * `removed: null` with it, so the route still trashes the Notion entry (Codex review of PR 376).
 * A session that is gone with no removal of it on record answers 404, as before. Without the function
 * (sql/reading_session_discards.sql not applied, or not yet in PostgREST's schema cache): 503 and nothing removed,
 * also for a session with no key; the form keeps it and retries.
 */
export async function deleteSession(supabase: Supa, sessionId: number, habitCreatedOn: string | null = null): Promise<SessionRemoval> {
  const r = await removeSessionTx(supabase, { sessionId }, habitCreatedOn);
  if (r.kind === "failed") return { ok: false, status: r.status, error: r.error };
  if (r.kind === "removed") return { ok: true, removed: r.session, book: r.book, unfinished: r.unfinished, habitRemoved: r.habitRemoved, cleanup: r.cleanup };
  if (!r.cleanup) return { ok: false, status: 404, error: "That session no longer exists.", gone: true };
  return { ok: true, removed: null, unfinished: r.cleanup.unfinished, cleanup: r.cleanup };
}

/**
 * Discard of an autosaving /log entry whose create may have been stored although its answer never arrived (PROD-T01):
 * one transaction (pds.remove_reading_session) records the key as discarded under the key's lock, so a create of it
 * still running on the server either committed before (its session is found and removed here) or is refused after,
 * and removes that session exactly like DELETE /api/reading/sessions/[id] (a finish it caused goes back to reading;
 * the route trashes its Notion entry). Whether that create made the day's habit row is not taken from the browser
 * (its answer was lost): the create wrote it down with the habit row (pds.reading_habit_provenance), and the
 * removal takes back the Yes reading made (or gives back the answer it replaced) when this is the last session of
 * that day, unless the row was answered again since (Codex T01-R7). A failed habit part fails the whole removal.
 * The create side is one transaction too (pds.create_reading_session: session, finish and habit Yes together), so the
 * session found here comes with every effect its create had, and none can follow after its removal (Codex T01-R4).
 * `removed: null` = no session has this key (the database said so inside that transaction, never assumed from a
 * 404) and none can be created with it any more: nothing of the entry is stored. `cleanup` then carries an earlier
 * removal of the key whose Notion cleanup the route replays (a removal whose answer was lost, or one that raced this).
 * When the removal cannot be recorded (sql/reading_session_discards.sql or the client_key column not applied: 503;
 * a database failure: 500) the answer is an error, never "nothing stored": the form keeps the entry and retries.
 */
export async function deleteSessionByClientKey(supabase: Supa, clientKey: string): Promise<SessionRemoval> {
  if (!UUID_RE.test(clientKey)) return { ok: false, status: 400, error: "client_key must be a UUID" };
  const r = await removeSessionTx(supabase, { clientKey: clientKey.toLowerCase() }, null);
  if (r.kind === "failed") return { ok: false, status: r.status, error: r.error };
  if (r.kind === "removed") return { ok: true, removed: r.session, book: r.book, unfinished: r.unfinished, habitRemoved: r.habitRemoved, cleanup: r.cleanup };
  return { ok: true, removed: null, unfinished: r.cleanup?.unfinished ?? false, cleanup: r.cleanup };
}

export interface AddHighlightInput {
  slug?: string | null;
  book_id?: number | null;
  passage: string;
  comment?: string | null;
  chapter?: number | null;
  location?: string | null;
  concept?: string | null;
  source?: HighlightSource | null;
  date?: string | null; // behavioral day used to schedule the first review
  /** Kindle position span / print page / timestamps (harvester only). */
  position?: number | null;
  position_end?: number | null;
  page?: number | null;
  highlighted_at?: string | null;
  note_at?: string | null;
  /**
   * The Onyx Chat operation id (SEC-04, sql/chat_operations.sql): stored on a highlight this call CREATES (never on
   * one it updates), so a retried chat message finds the highlight its earlier try made, even after an edit.
   */
  client_key?: string | null;
  /**
   * Insert only (the chat replay's check-mode recovery, SEC-04): never update a highlight that already has this
   * passage. The row is created by one insert that the (book_id, passage) and client_key unique indexes make atomic;
   * when another write got there first the existing highlight is left exactly as it is and returned as `conflict`
   * (or as this call's own highlight when it carries this client_key). Requires a client_key.
   */
  insert_only?: boolean;
}

/** addHighlight with insert_only met a highlight that has this passage and is not this call's own: nothing changed. */
export const HIGHLIGHT_EXISTS = "a highlight with this passage already exists, so nothing was changed";
/** addHighlight's database failures: the browser gets this copy; the raw database text goes to the server log only. */
const HIGHLIGHT_SAVE_FAILED = "Couldn't save the highlight. Try again.";

export async function addHighlight(
  supabase: Supa,
  input: AddHighlightInput,
): Promise<{ ok: true; book: Book; highlight: Highlight; created: boolean; readBack?: true } | { ok: false; error: string; kind?: "server" }> {
  const book = input.book_id
    ? ((await supabase.from("books").select(BOOK_COLS).eq("book_id", input.book_id).maybeSingle()).data as Book | null)
    : await getBook(supabase, input.slug ?? null);
  if (!book) return { ok: false, error: "No active book found" };
  const passage = input.passage?.trim();
  if (!passage) return { ok: false, error: "passage is required" };
  const today = input.date ?? (await behavioralToday(supabase));
  const source = input.source && ["manual", "kindle", "audible", "paper", "photo"].includes(input.source) ? input.source : "manual";

  const row = {
    book_id: book.book_id,
    passage,
    comment: input.comment?.trim() || null,
    chapter: input.chapter != null && Number.isFinite(Number(input.chapter)) ? Math.round(Number(input.chapter)) : null,
    location: input.location?.trim() || null,
    concept: input.concept?.trim() || null,
    source,
    next_review: addDays(today, 1),
    ...(input.position != null ? { position: Math.round(input.position) } : {}),
    ...(input.position_end != null ? { position_end: Math.round(input.position_end) } : {}),
    ...(input.page != null ? { page: Math.round(input.page) } : {}),
    ...(input.highlighted_at ? { highlighted_at: input.highlighted_at } : {}),
    ...(input.note_at ? { note_at: input.note_at } : {}),
  };

  const key = typeof input.client_key === "string" && UUID_RE.test(input.client_key) ? input.client_key.toLowerCase() : null;
  // A key that was given but is not a UUID is refused, never dropped (the highlight would then be unkeyed).
  if (!key && input.client_key != null && input.client_key !== "") return { ok: false, error: "client_key must be a UUID" };

  if (input.insert_only) {
    // No read first and no update: a highlight written between a read and a write would otherwise be overwritten.
    // A unique violation means another write holds this passage (or this key) now; it is read back, never changed.
    if (!key) return { ok: false, error: "client_key must be a UUID" };
    const { data, error } = await supabase.from("book_highlights").insert({ ...row, client_key: key }).select(HIGHLIGHT_COLS).single();
    if (!error) return { ok: true, book, highlight: data as Highlight, created: true };
    if (error.code !== "23505") {
      console.error("reading/highlights addHighlight", error.message);
      return { ok: false, error: HIGHLIGHT_SAVE_FAILED, kind: "server" };
    }
    const { data: own, error: ownError } = await supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("client_key", key).maybeSingle();
    if (ownError) {
      console.error("reading/highlights addHighlight", ownError.message);
      return { ok: false, error: HIGHLIGHT_SAVE_FAILED, kind: "server" };
    }
    // This call's own key: a copy of this same call wrote it (created by this operation, not by this insert).
    if (own) return { ok: true, book, highlight: own as Highlight, created: true, readBack: true };
    return { ok: false, error: HIGHLIGHT_EXISTS };
  }

  // Idempotent on (book_id, passage): a re-import updates comment/chapter/concept/position only when provided.
  const { data: existing } = await supabase
    .from("book_highlights")
    .select(HIGHLIGHT_COLS)
    .eq("book_id", book.book_id)
    .eq("passage", passage)
    .maybeSingle();
  if (existing) {
    const ex = existing as Highlight;
    const patch: Record<string, unknown> = {};
    if (row.comment && row.comment !== ex.comment) patch.comment = row.comment;
    if (row.chapter != null && row.chapter !== ex.chapter) patch.chapter = row.chapter;
    if (row.location && row.location !== ex.location) patch.location = row.location;
    if (row.concept && row.concept !== ex.concept) patch.concept = row.concept;
    for (const k of ["position", "position_end", "page", "highlighted_at", "note_at"] as const) {
      const v = (row as Record<string, unknown>)[k];
      if (v != null && v !== ex[k]) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      const { data, error } = await supabase.from("book_highlights").update(patch).eq("highlight_id", existing.highlight_id).select(HIGHLIGHT_COLS).single();
      if (error) {
        console.error("reading/highlights addHighlight", error.message);
        return { ok: false, error: HIGHLIGHT_SAVE_FAILED, kind: "server" };
      }
      return { ok: true, book, highlight: data as Highlight, created: false };
    }
    return { ok: true, book, highlight: existing as Highlight, created: false };
  }

  const { data, error } = await supabase.from("book_highlights").insert(key ? { ...row, client_key: key } : row).select(HIGHLIGHT_COLS).single();
  if (error) {
    console.error("reading/highlights addHighlight", error.message);
    return { ok: false, error: HIGHLIGHT_SAVE_FAILED, kind: "server" };
  }
  return { ok: true, book, highlight: data as Highlight, created: true };
}

/**
 * The review scheduler lives in lib/reading-practice.ts (SM-2 lite), shared by the commit below and the review
 * card's previews, so the interval shown under a grade button is the one the server stores.
 */
export { scheduleAfterGrade };

export interface GradeInput {
  highlight_id: number;
  grade: Grade;
  /** Operation key from the review card (one per card until a definite answer); absent = one is made here. */
  op_key?: string | null;
  /** The card's review count on screen: another grade in between answers 409 changed. */
  expected_review_count?: number | null;
  /** Behavioral day override (tests); default pds.behavioral_today_now(). */
  date?: string | null;
}

export interface GradeReceipt {
  op_key: string;
  review_id: number;
  review_date: string;
  grade: Grade;
  interval_days: number;
  next_review: string;
  review_count: number;
}

export type GradeResult =
  | { ok: true; highlight: Highlight | null; firstReviewToday: boolean; replayed: boolean; receipt: GradeReceipt }
  | PracticeFailure;

/**
 * Grade one highlight: ONE call of pds.reading_grade_review (sql/reading_practice_receipts.sql), which locks the
 * highlight, stores the review, writes the schedule computed here and records the receipt in one transaction. The
 * same op_key answers the stored receipt again (a retry after a lost answer); there is no direct-write fallback
 * (a missing function is 503 practice_unavailable). When another write lands between the read and the lock
 * (`raced`), the row is read again and the schedule recomputed, at most three times.
 */
export async function gradeHighlight(supabase: Supa, input: GradeInput): Promise<GradeResult> {
  if (!PRACTICE_GRADES.includes(input.grade)) return { ok: false, status: 400, error: "bad_grade" };
  if (!(Number.isInteger(input.highlight_id) && input.highlight_id > 0)) return { ok: false, status: 400, error: "bad_highlight" };
  if (input.op_key != null && !isOpKey(input.op_key)) return { ok: false, status: 400, error: "bad_op_key" };
  const opKey = input.op_key ?? newOpKey();
  const today = input.date ?? (await behavioralToday(supabase));

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: h, error } = await supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("highlight_id", input.highlight_id).maybeSingle();
    if (error) return { ok: false, status: 500, error: "failed" };
    const row = (h as Highlight | null) ?? null;
    // A missing row still goes to the function: the receipt of an earlier try answers first, else 404.
    const basis = row ? { review_count: row.review_count, interval_days: row.interval_days, ease: Number(row.ease) } : null;
    const schedule = row ? scheduleAfterGrade(row, input.grade, today) : null;
    const { data, error: rpcError } = await supabase.rpc("reading_grade_review", {
      p: {
        op_key: opKey,
        highlight_id: input.highlight_id,
        grade: input.grade,
        review_date: today,
        basis,
        schedule: schedule && { ease: schedule.ease, interval_days: schedule.interval_days, next_review: schedule.next_review },
        client_review_count: input.expected_review_count ?? null,
      },
    });
    const answer = data as RpcAnswer | null;
    const failed = rpcFailure(answer, rpcError);
    if (failed) {
      if (failed.error === "raced" && attempt < 2) continue;
      return failed.error === "raced" ? { ok: false, status: 409, error: "changed" } : failed;
    }
    const a = answer as RpcAnswer;
    let highlight = (a.highlight as Highlight | undefined) ?? null;
    if (a.replayed) {
      // The receipt holds the schedule as committed; the row itself may have moved on since. Best effort.
      const { data: now } = await supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("highlight_id", input.highlight_id).maybeSingle();
      highlight = (now as Highlight | null) ?? null;
    }
    if (highlight) highlight = { ...highlight, ease: Number(highlight.ease) };
    return {
      ok: true,
      highlight,
      firstReviewToday: a.first_review_today === true,
      replayed: a.replayed === true,
      receipt: {
        op_key: opKey,
        review_id: Number(a.review_id),
        review_date: String(a.review_date),
        grade: a.grade as Grade,
        interval_days: Number(a.interval_days),
        next_review: String(a.next_review),
        review_count: Number(a.review_count),
      },
    };
  }
  return { ok: false, status: 409, error: "changed" };
}

export interface QuizInput {
  slug?: string | null;
  book_id?: number | null;
  checkpoint: string;
  score: number;
  total: number;
  notes?: string | null;
  date?: string | null;
  /** Operation key: the same key + result answers the stored receipt (no second row, no second points). */
  op_key?: string | null;
}

export type QuizResult = { ok: true; quiz: Quiz; passed: boolean; replayed: boolean; op_key: string } | PracticeFailure;

/**
 * The book a quiz operation key's stored receipt was recorded for (pds.reading_practice_ops; book_id null = nothing is
 * stored under this key, or a review is). A failed read is a failure, never "no receipt": guessing the active book
 * instead could turn the retry of a stored result into 409 key_reused. Codes only.
 */
async function quizReceiptBook(supabase: Supa, opKey: string): Promise<{ ok: true; book_id: number | null } | PracticeFailure> {
  const { data, error } = await supabase.from("reading_practice_ops").select("kind, result").eq("op_key", opKey.toLowerCase()).maybeSingle();
  if (error) return isMissingSchema(error) ? { ok: false, status: 503, error: "practice_unavailable" } : { ok: false, status: 500, error: "failed" };
  const row = data as { kind?: unknown; result?: { book_id?: unknown } | null } | null;
  const id = row?.kind === "quiz" ? Number(row.result?.book_id) : NaN;
  return { ok: true, book_id: Number.isInteger(id) && id > 0 ? id : null };
}

/**
 * Record a checkpoint quiz result: ONE call of pds.reading_record_quiz (quiz row + receipt, one transaction). Each
 * stored row is one durable attempt and counts toward XP; a retry under the same op_key stores nothing new.
 * Without a key (an older page, and the chat tool until it passes its operation id) one is made here, so that call is
 * atomic but a retry of it is a new attempt. A caller that retries must hold one op_key across its tries, and must
 * classify a failure with failureMayHaveWritten (lib/reading-practice.ts), never by the message text.
 */
export async function recordQuiz(supabase: Supa, input: QuizInput): Promise<QuizResult> {
  if (input.op_key != null && !isOpKey(input.op_key)) return { ok: false, status: 400, error: "bad_op_key" };
  // A key that already stored a result is bound to the book it was stored for. With no book named, the retry of a
  // result whose answer was lost uses THAT book, not the one active now (the active book may have changed in
  // between), so it answers its receipt instead of 409 key_reused or 404. A named book is part of the request.
  let bookId: number | null = null;
  if (!input.book_id && !input.slug && input.op_key != null) {
    const bound = await quizReceiptBook(supabase, input.op_key);
    if (!bound.ok) return bound;
    bookId = bound.book_id;
  }
  if (bookId == null) {
    const book = input.book_id
      ? ((await supabase.from("books").select(BOOK_COLS).eq("book_id", input.book_id).maybeSingle()).data as Book | null)
      : await getBook(supabase, input.slug ?? null);
    if (!book) return { ok: false, status: 404, error: "No active book found" };
    bookId = book.book_id;
  }
  const score = Math.round(Number(input.score));
  const total = Math.round(Number(input.total));
  if (!(total > 0) || !(score >= 0) || score > total) return { ok: false, status: 400, error: "score must be between 0 and total" };
  const checkpoint = input.checkpoint?.trim();
  if (!checkpoint) return { ok: false, status: 400, error: "checkpoint is required (e.g. ch12)" };
  if (checkpoint.length > QUIZ_CHECKPOINT_MAX) return { ok: false, status: 400, error: "checkpoint is too long" };
  const notes = input.notes?.trim() || null;
  const opKey = input.op_key ?? newOpKey();
  const { data, error } = await supabase.rpc("reading_record_quiz", {
    p: { op_key: opKey, book_id: bookId, checkpoint, score, total, notes, quiz_date: input.date ?? null },
  });
  const failed = rpcFailure(data as RpcAnswer | null, error);
  if (failed) return failed;
  const a = data as RpcAnswer;
  const quiz: Quiz = {
    quiz_id: Number(a.quiz_id),
    book_id: Number(a.book_id),
    checkpoint: String(a.checkpoint),
    score: Number(a.score),
    total: Number(a.total),
    notes,
    quiz_date: String(a.quiz_date),
  };
  return { ok: true, quiz, passed: a.passed === true, replayed: a.replayed === true, op_key: opKey };
}

/** Compact text summary for the chat tool (so the model can coach and quiz). */
export function summarizeForChat(o: ReadingOverview) {
  return {
    book: { title: o.book.title, author: o.book.author, status: o.book.status, start: o.book.start_date, target: o.book.target_date },
    today: o.today,
    progress: { chapters_done: o.chaptersDone, total_chapters: o.totalChapters, percent: o.percent },
    pace: o.pace,
    streak: o.streak,
    xp: o.xp,
    level: o.level,
    badges_earned: o.badges.filter((b) => b.earned).map((b) => b.label),
    checkpoints: o.checkpoints.map((c) => ({ key: c.key, chapter: c.chapter, due: c.due, reached: c.reached, on_time: c.onTime, quiz: c.quiz ? `${c.quiz.score}/${c.quiz.total}` : null, corrected_newer: c.correctedNewer, corrected_newer_quiz: c.correctedNewerQuiz })),
    // Chapter question bank, counts only (null while it is off): due / new ideas, the spoiler gate, stages, delayed recall.
    practice: o.practice?.enabled
      ? {
          due: o.practice.due,
          new_ready: o.practice.newReady,
          quiz_through: o.practice.quizThrough,
          stages: o.practice.stages,
          recall_7d: o.practice.recall7d,
          recall_21d: o.practice.recall21d,
        }
      : null,
    position: o.position,
    recent_sessions: o.sessions.slice(0, 10).map((s) => ({
      id: s.session_id,
      date: s.session_date,
      chapters: s.chapter_through != null ? `${s.chapter_from ?? "?"}-${s.chapter_through}` : s.in_chapter != null ? `reading ch ${s.in_chapter} (no chapter completed)` : "?",
      source: s.source,
      minutes: s.minutes,
      medium: s.medium,
      recall: s.recall,
      question: s.question,
    })),
    highlights: o.highlights.slice(0, 40).map((h) => ({ id: h.highlight_id, chapter: h.chapter, concept: h.concept, passage: h.passage, comment: h.comment })),
    due_reviews: o.dueReviews.map((h) => ({ id: h.highlight_id, passage: h.passage, comment: h.comment })),
    quizzes: o.quizzes.map((q) => ({ checkpoint: q.checkpoint, score: `${q.score}/${q.total}`, date: q.quiz_date, verification: q.verification ?? quizVerification(q) })),
  };
}
