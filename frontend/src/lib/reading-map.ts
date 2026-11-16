/**
 * The chapter map, the chapter sheet and the checkpoint quiz, browser side (READ-QUIZ-01 S5; docs/reading-question-bank.md
 * "Chapter map"). Pure apart from the two small fetch helpers re-used from lib/reading-practice-client.ts, so the
 * components (app/reading/ChapterMap.tsx, ChapterSheet.tsx, CheckpointQuiz.tsx, PracticeRunner.tsx) and the tests run
 * the same code:
 *
 * - the parsers of the three GETs (the bank's chapter map, one chapter's sheet, the checkpoint round), each of which
 *   leaves out what it cannot read instead of guessing;
 * - what a tile says (Locked, Building, Failed, Few sources, In progress in four steps, Covered, Needs review) and the
 *   map's header numbers (ideas recalled of all, Kept, the 7- and 21-day recall with their n);
 * - the spoiler rule on screen: a narrative book's locked chapters show no title, and no idea statement shows before
 *   the idea was asked once (the server sends none, this is the second check);
 * - the quiz result's request and what its answer means.
 *
 * Nothing here reads or writes storage.
 */
import { parseRound, PRACTICE_TODAY_URL, type PracticeRound } from "./reading-practice-client";
import { CHECKPOINT_PASS, type PracticeSummary } from "./reading";

/* ------------------------------------------------------------------ */
/* URLs                                                                 */
/* ------------------------------------------------------------------ */

export const CHECKPOINT_URL = "/api/reading/practice/checkpoint";
export const QUIZ_URL = "/api/reading/quiz";
export const BANK_RUN_URL = "/api/reading/bank/run";

const withBook = (url: string, slug: string | null, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  if (slug) p.set("book", slug);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const q = p.toString();
  return q ? `${url}?${q}` : url;
};

/**
 * The checkpoint quiz round of one checkpoint chapter (no cache: it is read when Start is tapped). `brief` leaves the
 * cards out: the tile asks it after a reload to learn whether answers were stored without a recorded result.
 */
export const checkpointUrl = (slug: string | null, chapter: number, brief = false) =>
  withBook(CHECKPOINT_URL, slug, brief ? { chapter: String(chapter), brief: "1" } : { chapter: String(chapter) });
/** "Practice 5" of one chapter: the chapter round of the practice GET. */
export const chapterRoundUrl = (slug: string | null, chapter: number) => withBook(PRACTICE_TODAY_URL, slug, { kind: "chapter", chapter: String(chapter) });
/** One chapter's sheet (the book is named so the sheet can never belong to another). */
export const sheetUrl = (slug: string | null, chapter: number) => withBook(`/api/reading/bank/chapter/${Math.trunc(chapter)}`, slug);

/* ------------------------------------------------------------------ */
/* Small readers                                                        */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : d);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/* ------------------------------------------------------------------ */
/* The chapter map                                                      */
/* ------------------------------------------------------------------ */

export interface MapChapter {
  chapter: number;
  /** null for a locked chapter of a narrative book, and for a chapter without a title. */
  title: string | null;
  locked: boolean;
  /** pending | ready | thin | anchors_only | no_sources | failed (reading_bank_chapters.status). */
  status: string;
  /** Counts only for a chapter at or below the spoiler gate (null while locked). */
  ideas: number | null;
  recalled: number | null;
  covered: boolean | null;
  needsReview: boolean | null;
  sources: number | null;
}

export interface MapState {
  bookId: number;
  enabled: boolean;
  pausedReason: "owner" | "budget" | null;
  quizThrough: number;
  totalChapters: number;
  /** A book the map step marked as narrative: the titles of locked chapters stay hidden. */
  narrative: boolean;
  mapping: "unknown" | "ok" | "uncertain";
  /** A "Not read yet" hold: the chapter, and the flag Restore undoes. */
  holdChapter: number | null;
  holdFlagKey: string | null;
  chapters: MapChapter[];
  /** What rebuilding one chapter is expected to cost, when the route reports it (lib/reading-bank-server.ts). */
  perChapterCents: number | null;
}

/** The bank GET (pds.reading_bank_overview plus the route's estimate), or null when it is not one. */
export function parseMap(raw: unknown): MapState | null {
  if (!isObj(raw) || typeof raw.book_id !== "number") return null;
  const narrative = raw.narrative === true;
  const chapters: MapChapter[] = [];
  for (const c of Array.isArray(raw.chapters) ? raw.chapters : []) {
    if (!isObj(c) || typeof c.chapter !== "number" || c.chapter < 1) continue;
    const locked = c.locked === true;
    chapters.push({
      chapter: c.chapter,
      // The server already leaves the title out of a locked narrative chapter; this is the second check.
      title: typeof c.title === "string" && c.title.trim() && !(narrative && locked) ? c.title.trim() : null,
      locked,
      status: typeof c.status === "string" ? c.status : "pending",
      ideas: locked ? null : intOrNull(c.ideas),
      recalled: locked ? null : intOrNull(c.recalled),
      covered: locked ? null : bool(c.covered),
      needsReview: locked ? null : bool(c.needs_review),
      sources: locked ? null : intOrNull(c.sources),
    });
  }
  chapters.sort((a, b) => a.chapter - b.chapter);
  const est = isObj(raw.estimate) ? raw.estimate : null;
  return {
    bookId: raw.book_id,
    enabled: raw.enabled === true,
    pausedReason: raw.paused_reason === "owner" || raw.paused_reason === "budget" ? raw.paused_reason : null,
    quizThrough: int(raw.quiz_through),
    totalChapters: int(raw.total_chapters),
    narrative,
    mapping: raw.mapping === "ok" || raw.mapping === "uncertain" ? raw.mapping : "unknown",
    holdChapter: intOrNull(raw.hold_chapter),
    holdFlagKey: isUuid(raw.hold_flag_key) ? raw.hold_flag_key.toLowerCase() : null,
    chapters,
    perChapterCents: est && typeof est.per_chapter_cents === "number" && est.per_chapter_cents >= 0 ? Math.round(est.per_chapter_cents) : null,
  };
}

/** What a tile shows. Every state is an icon plus a word; none is color alone. */
export type TileState =
  | { kind: "locked" }
  | { kind: "building"; failed: boolean }
  | { kind: "few" }
  /** `step` 0..4: the recalled share of the ideas in quarters (0 = none yet). */
  | { kind: "progress"; step: 0 | 1 | 2 | 3 | 4; recalled: number; ideas: number }
  | { kind: "covered" }
  | { kind: "review" };

export const TILE_WORD: Record<TileState["kind"], string> = {
  locked: "Locked",
  building: "Building",
  few: "Few sources",
  progress: "In progress",
  covered: "Covered",
  review: "Needs review",
};

/**
 * The tile of a chapter. Locked first. A chapter that is still being built (or failed to build) has nothing to
 * practise yet. Needs review beats Covered (two or more lapses in the last 7 days), Covered is every core idea at
 * Explained or above, "Few sources" is a chapter built from too little to ask more than a handful of ideas (it keeps its
 * progress once something was recalled), and everything else is In progress in four steps by the recalled share.
 */
export function tileState(c: MapChapter): TileState {
  if (c.locked) return { kind: "locked" };
  const ideas = c.ideas ?? 0;
  const recalled = Math.min(ideas, c.recalled ?? 0);
  if (c.status === "pending" || c.status === "failed") return { kind: "building", failed: c.status === "failed" };
  if (c.needsReview === true) return { kind: "review" };
  if (c.covered === true) return { kind: "covered" };
  if ((c.status === "thin" || c.status === "no_sources") && recalled === 0) return { kind: "few" };
  const share = ideas > 0 ? recalled / ideas : 0;
  const step = share <= 0 ? 0 : share <= 0.25 ? 1 : share <= 0.5 ? 2 : share <= 0.75 ? 3 : 4;
  return { kind: "progress", step, recalled, ideas };
}

/** The title to show for a chapter, or null (a narrative book's locked chapters never show one). */
export const tileTitle = (c: MapChapter, narrative: boolean): string | null => (c.locked && narrative ? null : c.title);

/** "Ch 7" or "Ch 7 · Title" for a tile's name and tooltip. */
export const chapterLabel = (c: MapChapter, narrative: boolean): string => {
  const t = tileTitle(c, narrative);
  return t ? `Ch ${c.chapter} · ${t}` : `Ch ${c.chapter}`;
};

export interface MapHeader {
  /** Ideas recalled (Recalled stage or above) of all ideas in the unlocked chapters, detail ideas left out. */
  recalled: number;
  ideas: number;
  kept: number;
  recall7: { n: number; pct: number | null };
  recall21: { n: number; pct: number | null };
}

const pct = (r: { n: number; right: number } | undefined) => ({ n: r?.n ?? 0, pct: r && r.n > 0 ? Math.round((100 * r.right) / r.n) : null });

/** The header lines: "Recalled 46 of 120 ideas · Kept 9" and "7-day recall 78% (n 23)". */
export function mapHeader(map: Pick<MapState, "chapters">, practice: Pick<PracticeSummary, "stages" | "recall7d" | "recall21d"> | null | undefined): MapHeader {
  let recalled = 0;
  let ideas = 0;
  for (const c of map.chapters) {
    if (c.locked) continue;
    ideas += c.ideas ?? 0;
    recalled += Math.min(c.ideas ?? 0, c.recalled ?? 0);
  }
  return { recalled, ideas, kept: practice?.stages.kept ?? 0, recall7: pct(practice?.recall7d), recall21: pct(practice?.recall21d) };
}

/** "7-day recall 78% (n 23)", or "7-day recall · none yet". */
export const recallLine = (days: 7 | 21, r: { n: number; pct: number | null }): string =>
  r.pct === null ? `${days}-day recall · none yet` : `${days}-day recall ${r.pct}% (n ${r.n})`;

/** A change that should make the map read again: a different spoiler gate, stage counts, or approval state. */
export function mapSignature(practice: PracticeSummary | null | undefined): string {
  if (!practice) return "-";
  const s = practice.stages;
  return [practice.enabled ? 1 : 0, practice.pausedReason ?? "-", practice.quizThrough, s.new, s.seen, s.recalled, s.explained, s.kept, practice.voided, practice.chapters.map((c) => `${c.chapter}:${c.status}:${c.ideas ?? "-"}`).join(",")].join("|");
}

/* ------------------------------------------------------------------ */
/* One chapter's sheet                                                  */
/* ------------------------------------------------------------------ */

export interface SheetIdea {
  ideaId: number;
  title: string;
  importance: "core" | "supporting" | "detail";
  /** 0 New, 1 Seen, 2 Recalled, 3 Explained, 4 Kept. */
  stage: number;
  /** null until the idea was asked once: the statement can state the answer. */
  statement: string | null;
  sources: number;
}
export interface SheetFlag {
  flagKey: string;
  kind: "wrong" | "unclear" | "not_in_chapter" | "not_read_yet";
  prompt: string;
  createdAt: string | null;
}
export interface SheetState {
  chapter: number;
  title: string | null;
  status: string;
  builtAt: string | null;
  promptVersion: string | null;
  rebuilds: number;
  ideas: SheetIdea[];
  flags: SheetFlag[];
}

const FLAG_KINDS: ReadonlySet<string> = new Set(["wrong", "unclear", "not_in_chapter", "not_read_yet"]);

/** The chapter GET (pds.reading_bank_chapter), or null when it is not one (a locked chapter answers 404). */
export function parseSheet(raw: unknown): SheetState | null {
  if (!isObj(raw) || typeof raw.chapter !== "number") return null;
  const ideas: SheetIdea[] = [];
  for (const i of Array.isArray(raw.ideas) ? raw.ideas : []) {
    if (!isObj(i) || typeof i.idea_id !== "number" || typeof i.title !== "string") continue;
    const stage = Math.max(0, Math.min(4, int(i.stage)));
    ideas.push({
      ideaId: i.idea_id,
      title: i.title,
      importance: i.importance === "core" || i.importance === "detail" ? i.importance : "supporting",
      stage,
      // An idea never asked shows no statement, whatever the answer carried.
      statement: stage >= 1 && typeof i.statement === "string" && i.statement.trim() ? i.statement : null,
      sources: Math.max(0, int(i.sources)),
    });
  }
  const flags: SheetFlag[] = [];
  for (const f of Array.isArray(raw.flags) ? raw.flags : []) {
    if (!isObj(f) || !isUuid(f.flag_key) || !FLAG_KINDS.has(String(f.kind)) || typeof f.prompt !== "string") continue;
    flags.push({ flagKey: f.flag_key.toLowerCase(), kind: f.kind as SheetFlag["kind"], prompt: f.prompt, createdAt: typeof f.created_at === "string" ? f.created_at : null });
  }
  return {
    chapter: raw.chapter,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null,
    status: typeof raw.status === "string" ? raw.status : "pending",
    builtAt: typeof raw.built_at === "string" ? raw.built_at : null,
    promptVersion: typeof raw.prompt_version === "string" && raw.prompt_version ? raw.prompt_version : null,
    rebuilds: Math.max(0, int(raw.rebuilds)),
    ideas,
    flags,
  };
}

/** The five stages of an idea in words (lib/reading-recall.ts STAGE_LABEL, copied: this file stays import-light). */
export const STAGE_WORDS = ["New", "Seen", "Recalled", "Explained", "Kept"] as const;
export const stageWord = (stage: number): string => STAGE_WORDS[Math.max(0, Math.min(4, Math.trunc(stage) || 0))];

/** Ideas the sheet counts toward "recalled N of M" (detail ideas never count toward chapter percentages). */
export function sheetRecalled(s: Pick<SheetState, "ideas">): { recalled: number; ideas: number } {
  const counted = s.ideas.filter((i) => i.importance !== "detail");
  return { recalled: counted.filter((i) => i.stage >= 2).length, ideas: counted.length };
}

/** "$0.40": an exact amount in dollars for a rebuild's cost line. */
export const dollars = (cents: number): string => `$${(Math.max(0, cents) / 100).toFixed(2)}`;

/** "Nov 12" for the "Built <date>" line, in New York time (the day Riley saw it built). */
export function builtDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;
}

/* ------------------------------------------------------------------ */
/* The checkpoint quiz                                                  */
/* ------------------------------------------------------------------ */

/**
 * The database's own count of the quiz's valid answers (every answer under the quiz key, whether or not its idea is
 * still on screen): the result is recorded from it, because the database checks the result against exactly these.
 */
export interface QuizTally {
  total: number;
  right: number;
  /** Answers not graded yet: the result is refused until there are none. */
  pending: number;
}

export interface CheckpointData {
  /** The quiz as a practice round: the runner reads it like one (its kind stays "daily"; the runner knows the quiz). */
  round: PracticeRound;
  /** "ch12": the key the result is recorded under. */
  checkpoint: string;
  chapter: number;
  quizKey: string;
  /** Today's result, once recorded (a quiz key is one per day): then there are no cards. */
  recorded: { score: number; total: number } | null;
  /** The quiz's valid answers so far (see QuizTally). */
  tally: QuizTally;
  /** Ideas that could be asked (answered ones included), and the size of a quiz. */
  eligible: number;
  size: number;
  /** A quiz can be taken now. */
  ready: boolean;
  /** What is short when it cannot: not enough ideas, from the latest chapters, or with an explain question. */
  shortfall: "ideas" | "latest" | "explain" | null;
}

const SHORTFALLS: ReadonlySet<string> = new Set(["ideas", "latest", "explain"]);

/** The checkpoint GET, or null when it is not one (an error body, another shape). */
export function parseCheckpoint(raw: unknown): CheckpointData | null {
  const round = parseRound(raw);
  if (!round || !isObj(raw) || typeof raw.checkpoint !== "string" || !isUuid(raw.quiz_key)) return null;
  const q = isObj(raw.quiz) ? raw.quiz : null;
  const t = isObj(raw.tally) ? raw.tally : {};
  return {
    round,
    checkpoint: raw.checkpoint,
    chapter: int(raw.chapter),
    quizKey: raw.quiz_key.toLowerCase(),
    recorded: q && typeof q.score === "number" && typeof q.total === "number" ? { score: q.score, total: q.total } : null,
    tally: { total: Math.max(0, int(t.total)), right: Math.max(0, int(t.right)), pending: Math.max(0, int(t.pending)) },
    eligible: Math.max(0, int(raw.eligible)),
    size: Math.max(1, int(raw.size, 10)),
    ready: raw.ready === true,
    shortfall: typeof raw.shortfall === "string" && SHORTFALLS.has(raw.shortfall) ? (raw.shortfall as CheckpointData["shortfall"]) : null,
  };
}

/** Whether answers of this quiz are stored and no result was recorded (the tile then says "Answered · record result"). */
export const hasUnrecordedAnswers = (d: Pick<CheckpointData, "recorded" | "tally">): boolean => !d.recorded && d.tally.total > 0;

/** Whether a result can be recorded now, from the database's own count of the quiz's answers. */
export type RecordDecision =
  | { kind: "record"; score: number; total: number }
  /** Answers are still being graded: wait. */
  | { kind: "grading"; pending: number }
  /** Fewer valid answers than the quiz holds (a flag took a question out): reopen for replacements, record nothing. */
  | { kind: "short"; total: number; size: number }
  /** More valid answers than the quiz holds: it cannot be recorded. */
  | { kind: "over"; total: number; size: number };

/**
 * Only a quiz with exactly `size` valid answers, all graded, is recorded, and from the database's own count: a quiz cut
 * down by flags (one answer and nine removed questions) is a smaller quiz, and a "1 of 1" would otherwise pass.
 */
export function decideRecord(tally: QuizTally, size: number): RecordDecision {
  if (tally.pending > 0) return { kind: "grading", pending: tally.pending };
  if (tally.total < size) return { kind: "short", total: tally.total, size };
  if (tally.total > size) return { kind: "over", total: tally.total, size };
  return { kind: "record", score: Math.min(tally.right, tally.total), total: tally.total };
}

/** Why a quiz cannot be built yet, in words (the "Ideas answered in the last 7 days wait." line stays with it). */
export function shortfallLine(shortfall: CheckpointData["shortfall"], eligible: number, size: number): string {
  if (shortfall === "latest") return "Not enough fresh questions from the latest chapters yet";
  if (shortfall === "explain") return "Not enough fresh explain questions yet";
  return `Not enough fresh questions yet · ${eligible} of ${size}`;
}

/** What the quiz GET's failure says on the screen (a short word the host shows; the refusal stored nothing). */
export function checkpointRefusal(status: number | null, body: unknown): { kind: "off" | "locked" | "failed"; message: string } {
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (status === 503 || status === 404 || code === "bank_off" || code === "bank_unavailable") return { kind: "off", message: "Questions are not available for this book right now." };
  if (status === 409 && code === "locked") return { kind: "locked", message: "This checkpoint is not open yet: keep reading." };
  return { kind: "failed", message: status === null ? "No answer from Onyx. Check the connection, then try again." : "Onyx couldn't build the checkpoint quiz. Try again." };
}

/** The quiz result's request: the score is the answers graded right, the total every answer the quiz holds. */
export function quizRequest(slug: string, checkpoint: string, quizKey: string, score: number, total: number) {
  return { book: slug, checkpoint, score, total, op_key: quizKey };
}

export const passed = (score: number, total: number): boolean => total > 0 && score / total >= CHECKPOINT_PASS;

export type QuizOutcome =
  | { kind: "saved"; passed: boolean; xp: number; replayed: boolean }
  /** No answer, or one that cannot be read: the result may be stored. Retry sends the SAME request (replay safe). */
  | { kind: "unknown"; message: string }
  /** Refused: nothing new was stored. */
  | { kind: "refused"; message: string };

/** What the quiz route's answer means. `status` null = no answer at all. */
export function classifyQuizAnswer(status: number | null, body: unknown): QuizOutcome {
  if (status === null) return { kind: "unknown", message: "No answer from Onyx, so the result may not be saved." };
  const o = isObj(body) ? body : {};
  const code = typeof o.error === "string" ? o.error : "";
  if (status >= 200 && status < 300) {
    const q = isObj(o.quiz) ? o.quiz : null;
    if (o.success !== true || !q) return { kind: "unknown", message: "Onyx couldn't confirm the save." };
    return { kind: "saved", passed: o.passed === true, xp: Math.max(0, int(o.xp_gained)), replayed: o.replayed === true };
  }
  if (status === 409 && code === "key_reused") return { kind: "refused", message: "Onyx already holds a different result for this quiz. Nothing new was saved." };
  // The quiz table checks the result against the quiz's own answers (OXQ01..03): each has its own advice.
  if (status === 409 && code === "attempts_pending") return { kind: "refused", message: "Some answers are still being graded. Wait a moment, then tap Done again." };
  if (status === 409 && code === "score_mismatch") return { kind: "refused", message: "Onyx counts the quiz's answers differently from the screen. Close the checkpoint and open it again." };
  if (status === 409 && code === "quiz_other_book") return { kind: "refused", message: "This quiz holds an answer about another book, so it cannot be recorded." };
  if (status === 409 || status === 400) return { kind: "refused", message: "Onyx refused this result. Nothing was saved. Close the checkpoint and open it again." };
  if (status >= 400 && status < 500) return { kind: "refused", message: "Onyx refused this result. Nothing was saved." };
  return { kind: "unknown", message: "Onyx couldn't confirm the save." };
}

/**
 * The run route's answer for Rebuild chapter (202 {queued}; 409 bank_off = the book is not turned on); the sheet shows
 * these words. No answer at all is NOT "nothing started": the rebuild is counted before it is queued, so a lost answer
 * may have committed, and another tap would pay for a second one.
 */
export function classifyRunAnswer(status: number | null, body?: unknown): { ok: boolean; message: string } {
  if (status !== null && status >= 200 && status < 300) return { ok: true, message: "Rebuilding. The new questions replace the old ones when it is done." };
  if (status === null) return { ok: false, message: "No answer from Onyx, so the rebuild may have started. Check Status before trying again." };
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (status === 409 && code === "bank_off") return { ok: false, message: "Not started: questions are off for this book. Turn them on first." };
  if (status === 409 || status === 429) return { ok: false, message: "Not started: the spending cap is reached or a rebuild is already queued." };
  if (status >= 500) return { ok: false, message: "Onyx couldn't confirm the rebuild, so it may have started. Check Status before trying again." };
  return { ok: false, message: "Onyx couldn't start the rebuild." };
}
