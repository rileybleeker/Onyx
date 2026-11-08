import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reading module — shared server logic for /api/reading/* and the chat tools.
 *
 * Tables (sql/reading_schema.sql): pds.books, pds.reading_sessions,
 * pds.book_highlights, pds.reading_reviews, pds.reading_quizzes.
 *
 * Everything gamified (XP, level, streak, pace, badges, checkpoints) is DERIVED
 * here from the raw rows — nothing is stored, so the rules can change freely.
 * The Supabase client passed in MUST be scoped to schema "pds" (service role).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export type Medium = "audio" | "kindle" | "paper" | "other";
export type HighlightSource = "manual" | "kindle" | "audible" | "paper" | "photo";
export type Grade = "again" | "good" | "easy";

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

export interface Quiz {
  quiz_id: number;
  book_id: number;
  checkpoint: string;
  score: number;
  total: number;
  notes: string | null;
  quiz_date: string;
}

export interface Checkpoint {
  key: string; // 'ch12'
  chapter: number;
  due: string; // YYYY-MM-DD
  reached: boolean; // chapter reached by any date
  onTime: boolean | null; // null until due or reached
  quiz: Quiz | null;
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
  quizzes: number;
  checkpoints: number;
  total: number;
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
  checkpoints: Checkpoint[];
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
  perReviewDay: 15, // a day on which at least one review was graded
  perQuizPoint: 10, // per correct answer
  perCheckpointOnTime: 50,
  perLevel: 100,
} as const;

const LEVEL_TITLES = [
  "Plant Visitor",
  "Expediter",
  "Shift Supervisor",
  "Line Manager",
  "Bottleneck Hunter",
  "Flow Engineer",
  "Plant Manager",
  "Division Lead",
  "Jonah",
];

/** Default concept tags for the TOC -> BC mapping. The UI offers these plus free text. */
export const CONCEPTS = [
  "The goal of a plant",
  "Throughput / Inventory / Operating Expense",
  "Dependent events + statistical fluctuations",
  "Bottleneck / capacity-constrained resource",
  "Balanced-plant fallacy",
  "Utilizing vs activating",
  "Process batch vs transfer batch",
  "Drum, buffer, rope",
  "Cost accounting vs throughput accounting",
  "Five focusing steps",
];

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
  let q = supabase.from("books").select("*");
  if (slug) q = q.eq("slug", slug);
  else q = q.eq("status", "reading");
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as Book) ?? null;
}

export async function listBooks(supabase: Supa): Promise<Book[]> {
  const { data, error } = await supabase.from("books").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Book[];
}

export async function getOverview(supabase: Supa, slug?: string | null): Promise<ReadingOverview | null> {
  const book = await getBook(supabase, slug);
  if (!book) return null;
  const today = await behavioralToday(supabase);

  const [sessionsRes, highlightsRes, quizzesRes, chaptersRes] = await Promise.all([
    supabase
      .from("reading_sessions")
      .select("*")
      .eq("book_id", book.book_id)
      .order("session_date", { ascending: false })
      .order("session_id", { ascending: false }),
    supabase
      .from("book_highlights")
      .select("*")
      .eq("book_id", book.book_id)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .order("highlight_id", { ascending: false }),
    supabase.from("reading_quizzes").select("*").eq("book_id", book.book_id).order("taken_at", { ascending: false }),
    supabase.from("book_chapters").select("chapter,start_position,end_position,start_page,end_page").eq("book_id", book.book_id).order("start_position"),
  ]);
  for (const r of [sessionsRes, highlightsRes, quizzesRes, chaptersRes]) {
    if (r.error) throw new Error(r.error.message);
  }
  const sessions = (sessionsRes.data ?? []) as ReadingSession[];
  const highlights = ((highlightsRes.data ?? []) as Highlight[]).map((h) => ({ ...h, ease: Number(h.ease) }));
  const quizzes = (quizzesRes.data ?? []) as Quiz[];
  const chapters = (chaptersRes.data ?? []) as ChapterSpan[];

  const highlightIds = highlights.map((h) => h.highlight_id);
  let reviews: Review[] = [];
  if (highlightIds.length) {
    const { data, error } = await supabase
      .from("reading_reviews")
      .select("review_id,highlight_id,review_date,grade")
      .in("highlight_id", highlightIds);
    if (error) throw new Error(error.message);
    reviews = (data ?? []) as Review[];
  }

  return computeOverview({ book, today, sessions, highlights, reviews, quizzes, chapters });
}

/* ------------------------------------------------------------------ */
/* Derivations                                                          */
/* ------------------------------------------------------------------ */

export function computeOverview(input: {
  book: Book;
  today: string;
  sessions: ReadingSession[];
  highlights: Highlight[];
  reviews: Review[];
  quizzes: Quiz[];
  chapters?: ChapterSpan[];
}): ReadingOverview {
  const { book, today, sessions, highlights, reviews, quizzes } = input;
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
  const reviewsToday = reviews.filter((r) => r.review_date === today).length;
  const quizPoints = quizzes.reduce((a, q) => a + q.score, 0);
  const checkpoints = computeCheckpoints(book, sessions, quizzes, today, start, target);
  const onTimeCheckpoints = checkpoints.filter((c) => c.reached && c.onTime === true).length;
  const xp: XpBreakdown = {
    chapters: chaptersDone * XP.perChapter,
    recalls: recallSessions * XP.perRecall,
    highlights: highlights.reduce((a, h) => a + ((h.comment ?? "").trim() ? XP.perHighlightWithComment : XP.perHighlightBare), 0),
    reviews: reviewDays.size * XP.perReviewDay,
    quizzes: quizPoints * XP.perQuizPoint,
    checkpoints: onTimeCheckpoints * XP.perCheckpointOnTime,
    total: 0,
  };
  xp.total = xp.chapters + xp.recalls + xp.highlights + xp.reviews + xp.quizzes + xp.checkpoints;
  const levelN = Math.floor(xp.total / XP.perLevel) + 1;
  const level = {
    n: levelN,
    title: LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, levelN - 1)],
    intoLevel: xp.total % XP.perLevel,
    perLevel: XP.perLevel,
  };

  const badges = computeBadges({ book, sessions, highlights, reviews, quizzes, checkpoints, chaptersDone, totalChapters, best });

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
    checkpoints,
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
  const fractions = [0.3, 0.65, 1];
  return fractions.map((f) => {
    const chapter = Math.round(total * f);
    const due = f === 1 ? target : addDays(start, Math.round(totalDays * f) - 1);
    // First date the chapter was reached.
    const reachedOn = [...sessions]
      .filter((s) => (s.chapter_through ?? 0) >= chapter)
      .map((s) => s.session_date)
      .sort()[0];
    const reached = !!reachedOn;
    const onTime = reached ? reachedOn! <= due : today > due ? false : null;
    const key = `ch${chapter}`;
    const quiz = quizzes.find((q) => q.checkpoint === key) ?? null;
    return { key, chapter, due, reached, onTime, quiz };
  });
}

function computeBadges(ctx: {
  book: Book;
  sessions: ReadingSession[];
  highlights: Highlight[];
  reviews: Review[];
  quizzes: Quiz[];
  checkpoints: Checkpoint[];
  chaptersDone: number;
  totalChapters: number;
  best: number;
}): Badge[] {
  const { sessions, highlights, reviews, quizzes, checkpoints, chaptersDone, totalChapters, best } = ctx;
  const firstSession = [...sessions].sort((a, b) => (a.session_date < b.session_date ? -1 : 1))[0];
  const earliest = (pred: (s: ReadingSession) => boolean) =>
    [...sessions].filter(pred).map((s) => s.session_date).sort()[0] ?? null;
  const cps = checkpoints;
  const commented = highlights.filter((h) => (h.comment ?? "").trim());
  const reviewDays = [...new Set(reviews.map((r) => r.review_date))].sort();
  const passedQuizzes = quizzes.filter((q) => q.total > 0 && q.score / q.total >= 0.8);
  const audioSessions = sessions.filter((s) => s.medium === "audio");

  const badge = (key: string, label: string, description: string, earnedOn: string | null): Badge => ({
    key,
    label,
    description,
    earned: !!earnedOn,
    earnedOn,
  });

  return [
    badge("first-session", "First Shift", "Log your first session", firstSession?.session_date ?? null),
    badge("herbie", "Found Herbie", `Reach chapter ${cps[0]?.chapter ?? 12}`, earliest((s) => (s.chapter_through ?? 0) >= (cps[0]?.chapter ?? 12))),
    badge("bottleneck", "Bottleneck Hunter", `Reach chapter ${cps[1]?.chapter ?? 26}`, earliest((s) => (s.chapter_through ?? 0) >= (cps[1]?.chapter ?? 26))),
    badge("finisher", "Finisher", "Reach the last chapter", totalChapters && chaptersDone >= totalChapters ? earliest((s) => (s.chapter_through ?? 0) >= totalChapters) : null),
    badge("streak-7", "Seven Straight", "A 7-day session streak", best >= 7 ? "✓" : null),
    badge("scribe", "Scribe", "10 highlights with a comment", commented.length >= 10 ? commented.map((h) => h.created_at.slice(0, 10)).sort()[9] : null),
    badge("reviewer", "Reviewer", "Grade highlights on 5 different days", reviewDays.length >= 5 ? reviewDays[4] : null),
    badge("quiz-master", "Quiz Master", "Score 80%+ on a checkpoint quiz", passedQuizzes.length ? passedQuizzes.map((q) => q.quiz_date).sort()[0] : null),
    badge("on-pace", "On Pace", "Hit every checkpoint on time", cps.length && cps.every((c) => c.reached && c.onTime) ? cps[cps.length - 1].due : null),
    badge("runner", "Runner's Ear", "5 audio sessions", audioSessions.length >= 5 ? audioSessions.map((s) => s.session_date).sort()[4] : null),
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
}

export interface LogSessionResult {
  ok: true;
  book: Book;
  session: ReadingSession;
  xpGained: number;
  finished: boolean;
  habitMarked: boolean;
}

export async function logSession(supabase: Supa, input: LogSessionInput): Promise<LogSessionResult | { ok: false; error: string }> {
  const book = input.book_id
    ? ((await supabase.from("books").select("*").eq("book_id", input.book_id).maybeSingle()).data as Book | null)
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
  const { data: prevRows } = await supabase
    .from("reading_sessions")
    .select("chapter_through")
    .eq("book_id", book.book_id)
    .order("chapter_through", { ascending: false })
    .limit(1);
  const prevMax = (prevRows?.[0]?.chapter_through as number | undefined) ?? 0;
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
  const { data, error } = await supabase.from("reading_sessions").insert(row).select("*").single();
  if (error) return { ok: false, error: error.message };
  const session = data as ReadingSession;

  // XP gained by this session (chapters newly advanced + recall).
  const newChapters = Math.max(0, through - prevMax);
  const xpGained = newChapters * XP.perChapter + ((row.recall ?? "").length >= 40 ? XP.perRecall : 0);

  // Finished?
  let finished = false;
  if (book.total_chapters && through >= book.total_chapters && book.status !== "finished") {
    await supabase.from("books").update({ status: "finished", finished_on: date }).eq("book_id", book.book_id);
    finished = true;
  }

  // Stamp the habit (Yes) for the session day so /habits + the HRV pipeline see it.
  let habitMarked = false;
  if (book.habit_name) {
    const { error: hErr } = await supabase
      .from("habit_journal")
      .upsert({ cycle_date: date, question: book.habit_name, category: "learning", answer: "Yes" }, { onConflict: "cycle_date,question" });
    habitMarked = !hErr;
    if (hErr) console.error("reading: habit stamp failed:", hErr.message);
  }

  return { ok: true, book: { ...book, status: finished ? "finished" : book.status }, session, xpGained, finished, habitMarked };
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
}

export async function addHighlight(
  supabase: Supa,
  input: AddHighlightInput,
): Promise<{ ok: true; book: Book; highlight: Highlight; created: boolean } | { ok: false; error: string }> {
  const book = input.book_id
    ? ((await supabase.from("books").select("*").eq("book_id", input.book_id).maybeSingle()).data as Book | null)
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

  // Idempotent on (book_id, passage): a re-import updates comment/chapter/concept/position only when provided.
  const { data: existing } = await supabase
    .from("book_highlights")
    .select("*")
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
      const { data, error } = await supabase.from("book_highlights").update(patch).eq("highlight_id", existing.highlight_id).select("*").single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, book, highlight: data as Highlight, created: false };
    }
    return { ok: true, book, highlight: existing as Highlight, created: false };
  }

  const { data, error } = await supabase.from("book_highlights").insert(row).select("*").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, book, highlight: data as Highlight, created: true };
}

/**
 * SM-2 lite. again → interval 1 day, ease −0.2 (floor 1.3). good → first review 3 days,
 * then interval × ease. easy → interval × ease × 1.3, ease +0.15. Returns the updated row.
 */
export function scheduleAfterGrade(h: Pick<Highlight, "ease" | "interval_days" | "review_count">, grade: Grade, today: string) {
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
    next_review: addDays(today, interval),
    last_reviewed: today,
    review_count: (h.review_count ?? 0) + 1,
  };
}

export async function gradeHighlight(
  supabase: Supa,
  highlight_id: number,
  grade: Grade,
  date?: string | null,
): Promise<{ ok: true; highlight: Highlight; firstReviewToday: boolean } | { ok: false; error: string }> {
  if (!["again", "good", "easy"].includes(grade)) return { ok: false, error: "grade must be again | good | easy" };
  const { data: h, error } = await supabase.from("book_highlights").select("*").eq("highlight_id", highlight_id).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!h) return { ok: false, error: "highlight not found" };
  const today = date ?? (await behavioralToday(supabase));

  const { count } = await supabase
    .from("reading_reviews")
    .select("review_id", { count: "exact", head: true })
    .eq("review_date", today);
  const firstReviewToday = (count ?? 0) === 0;

  const { error: rErr } = await supabase.from("reading_reviews").insert({ highlight_id, review_date: today, grade });
  if (rErr) return { ok: false, error: rErr.message };
  const patch = scheduleAfterGrade(h as Highlight, grade, today);
  const { data: updated, error: uErr } = await supabase.from("book_highlights").update(patch).eq("highlight_id", highlight_id).select("*").single();
  if (uErr) return { ok: false, error: uErr.message };
  return { ok: true, highlight: updated as Highlight, firstReviewToday };
}

export async function recordQuiz(
  supabase: Supa,
  input: { slug?: string | null; book_id?: number | null; checkpoint: string; score: number; total: number; notes?: string | null; date?: string | null },
): Promise<{ ok: true; quiz: Quiz; passed: boolean } | { ok: false; error: string }> {
  const book = input.book_id
    ? ((await supabase.from("books").select("*").eq("book_id", input.book_id).maybeSingle()).data as Book | null)
    : await getBook(supabase, input.slug ?? null);
  if (!book) return { ok: false, error: "No active book found" };
  const score = Math.round(Number(input.score));
  const total = Math.round(Number(input.total));
  if (!(total > 0) || !(score >= 0) || score > total) return { ok: false, error: "score must be between 0 and total" };
  const checkpoint = input.checkpoint?.trim();
  if (!checkpoint) return { ok: false, error: "checkpoint is required (e.g. ch12)" };
  const quiz_date = input.date ?? (await behavioralToday(supabase));
  const { data, error } = await supabase
    .from("reading_quizzes")
    .insert({ book_id: book.book_id, checkpoint, score, total, notes: input.notes?.trim() || null, quiz_date })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, quiz: data as Quiz, passed: score / total >= 0.8 };
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
    checkpoints: o.checkpoints.map((c) => ({ key: c.key, chapter: c.chapter, due: c.due, reached: c.reached, on_time: c.onTime, quiz: c.quiz ? `${c.quiz.score}/${c.quiz.total}` : null })),
    position: o.position,
    recent_sessions: o.sessions.slice(0, 10).map((s) => ({
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
    quizzes: o.quizzes.map((q) => ({ checkpoint: q.checkpoint, score: `${q.score}/${q.total}`, date: q.quiz_date })),
  };
}
