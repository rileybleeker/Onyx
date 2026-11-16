/**
 * The checkpoint quiz's selection (READ-QUIZ-01 S5; docs/reading-question-bank.md "Checkpoint quiz"). Pure: the
 * route (lib/reading-checkpoint-server.ts) and the tests run the same code.
 *
 * A checkpoint quiz is CHECKPOINT_SIZE questions from chapters 1..N, one per idea: core ideas before supporting ones,
 * detail ideas never, at least half from the latest act (the chapters since the previous checkpoint), at least
 * CHECKPOINT_MIN_EXPLAIN explain questions, and no idea asked in the last CHECKPOINT_QUIET_DAYS days (an answer still
 * waiting for its grade and a chapter recall answer that covered the idea count as asking it). The pool comes from
 * pds.reading_bank_checkpoint_pool (the spoiler gate applied in SQL); this file only chooses.
 *
 * The quotas are enforced while choosing, not just hoped for: a quiz that cannot be built with half from the latest
 * act and three explain questions is withheld (`ready` false, `shortfall` says which part is short). The choice is
 * deterministic for a pool and a day.
 *
 * Resuming. A quiz opened again the same day keeps what it already holds. The quiz's answers are counted from the
 * database's own list of valid answers under its quiz key (`quizAnswers`), not from the cards that can be drawn: an
 * idea answered here and moved out of the quiz since (flagged "Not in this chapter") still has a valid answer that the
 * result is checked against, so it takes a slot (`remaining` = size minus every valid answer) and the quiz asks only
 * for the rest. The result is recorded from this count (`tally`), never from what is on screen.
 */
import {
  pickQuestion,
  roundKey,
  sha256Hex,
  uuidFromHash,
  interleave,
  type DeckAnswered,
  type DeckIdea,
  type DeckQuestion,
  type Importance,
  type RoundCard,
} from "./reading-recall";
import { CHECKPOINT_SIZE } from "./reading";

export const CHECKPOINT_MIN_EXPLAIN = 3;
export const CHECKPOINT_QUIET_DAYS = 7;
/** The ideas the cards RPC is asked for in one call (the SQL reads at most this many). */
export const CHECKPOINT_CARDS_MAX = 25;

/** One candidate idea, as pds.reading_bank_checkpoint_pool lists it. */
export interface PoolIdea {
  idea_id: number;
  chapter: number;
  importance: Importance;
  stage: number;
  last_reviewed: string | null;
  has_explain: boolean;
}

/** A valid answer of today, as the pool lists it: the daily deck's row plus the quiz key, the question's format and the idea's chapter. */
export interface PoolAnswer extends DeckAnswered {
  quiz_key?: string | null;
  format?: string | null;
  chapter?: number | null;
}

export interface CheckpointPool {
  book_id: number;
  today: string;
  quiz_through: number;
  chapter: number;
  enabled: boolean;
  ideas: PoolIdea[];
  answered_today: PoolAnswer[];
}

/** The round key of a checkpoint quiz: one per book, day and checkpoint chapter. */
export const checkpointRoundKey = (bookId: number, today: string, chapter: number) => roundKey(bookId, today, "checkpoint", chapter);
/**
 * The quiz key (the answers' quiz_key and the result's op_key): one per book, day and checkpoint chapter, so a
 * result recorded today closes today's quiz and the next day's quiz is a new one.
 */
export const checkpointQuizKey = (bookId: number, today: string, chapter: number) =>
  uuidFromHash(sha256Hex(`${bookId}|${today}|checkpoint-quiz|${chapter}`));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : d);
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const IMPORTANCE: ReadonlySet<string> = new Set(["core", "supporting", "detail"]);

/** The pool function's answer, or null when it is not one. Rows of another shape are left out. */
export function parsePool(raw: unknown): CheckpointPool | null {
  if (!isObj(raw) || typeof raw.book_id !== "number" || !isYmd(raw.today)) return null;
  const ideas: PoolIdea[] = [];
  for (const i of Array.isArray(raw.ideas) ? raw.ideas : []) {
    if (!isObj(i) || typeof i.idea_id !== "number" || typeof i.chapter !== "number" || !IMPORTANCE.has(String(i.importance))) continue;
    ideas.push({
      idea_id: i.idea_id,
      chapter: i.chapter,
      importance: i.importance as Importance,
      stage: int(i.stage),
      last_reviewed: isYmd(i.last_reviewed) ? i.last_reviewed : null,
      has_explain: i.has_explain === true,
    });
  }
  const answered: PoolAnswer[] = [];
  for (const a of Array.isArray(raw.answered_today) ? raw.answered_today : []) {
    if (!isObj(a) || typeof a.attempt_key !== "string" || typeof a.question_id !== "number") continue;
    answered.push({
      ...(a as unknown as DeckAnswered),
      quiz_key: typeof a.quiz_key === "string" ? a.quiz_key.toLowerCase() : null,
      format: typeof a.format === "string" ? a.format : null,
      chapter: typeof a.chapter === "number" ? Math.trunc(a.chapter) : null,
    });
  }
  return {
    book_id: raw.book_id,
    today: raw.today,
    quiz_through: int(raw.quiz_through),
    chapter: int(raw.chapter),
    enabled: raw.enabled === true,
    ideas,
    answered_today: answered,
  };
}

const ymdMs = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const daysBetween = (from: string, to: string) => Math.round((ymdMs(to) - ymdMs(from)) / 86_400_000);
const importanceRank = (i: Importance) => (i === "core" ? 0 : i === "supporting" ? 1 : 2);

/**
 * Every valid answer of THIS quiz: the quiz key when the row carries one (the database checks a result against the
 * answers under its quiz key), else the round key; not voided; one list, ordered by attempt key. This is the list the
 * result's total and score are checked against, whether or not the idea is still in the pool.
 */
export function quizAnswers(pool: CheckpointPool): PoolAnswer[] {
  const key = checkpointRoundKey(pool.book_id, pool.today, pool.chapter);
  const quiz = checkpointQuizKey(pool.book_id, pool.today, pool.chapter);
  return pool.answered_today
    .filter((a) => a.grading_status !== "invalidated" && (a.quiz_key ? a.quiz_key === quiz : a.round_key === key))
    .sort((x, y) => x.attempt_key.localeCompare(y.attempt_key));
}

export interface QuizTally {
  /** Valid answers under the quiz key: what the result's total must equal. */
  total: number;
  /** Of those, graded right: what the result's score must equal. */
  right: number;
  /** Not graded yet (a model grade on its way): the result is refused until there are none. */
  pending: number;
}

/** The counts the database checks a recorded result against (pds.reading_quiz_link_attempts). */
export function quizTally(pool: CheckpointPool): QuizTally {
  const own = quizAnswers(pool);
  return {
    total: own.length,
    right: own.filter((a) => a.grading_status === "graded" && a.verdict === "correct").length,
    pending: own.filter((a) => a.grading_status !== "graded").length,
  };
}

export type Shortfall = "ideas" | "latest" | "explain";

export interface CheckpointSelection {
  /** The quiz's ideas still in the pool, best first: the ones still to ask and the ones already answered. */
  picked: PoolIdea[];
  /** The ideas still to ask (a subset of `picked`). */
  fresh: PoolIdea[];
  /** Ideas already answered in this quiz (one answer each), whether or not the idea is still in the pool. */
  done: Map<number, PoolAnswer>;
  /** Every valid answer of the quiz (`done` has one per idea; an answer whose idea left the pool is only here). */
  answers: PoolAnswer[];
  tally: QuizTally;
  /** Explain answers held by valid answers whose idea has no card here (they count toward the explain quota). */
  orphanExplain: number;
  /** Questions still to ask: the quiz size minus every valid answer. */
  remaining: number;
  /** Ideas that could be asked (answered ones included). */
  eligible: number;
  /** The quiz can be taken now (or finished). */
  ready: boolean;
  /** What is short when it cannot. */
  shortfall: Shortfall | null;
  /** A resumed quiz filled without meeting the quotas (what it already holds changed under it). */
  relaxed: boolean;
}

/**
 * Which ideas the quiz asks. Candidates: chapters 1..N, not detail, quiet for CHECKPOINT_QUIET_DAYS, not asked
 * elsewhere today, not already answered here, ranked by importance, then ideas with an explain variant, then a hash
 * fixed by the idea and the day. Taken, in this order: the best of the latest act until half the quiz is from it,
 * then explain-capable ideas until the quiz holds CHECKPOINT_MIN_EXPLAIN, then the best of the rest until it is full.
 * What the quiz already holds counts toward each quota. A fresh quiz that cannot meet them is not ready; a resumed
 * one that cannot is still filled (it was balanced when it began) as long as there are enough ideas.
 */
export function selectCheckpointIdeas(pool: CheckpointPool, opts: { actFrom: number; size?: number }): CheckpointSelection {
  const size = opts.size ?? CHECKPOINT_SIZE;
  const half = Math.ceil(size / 2);
  const answers = quizAnswers(pool);
  const done = new Map<number, PoolAnswer>();
  for (const a of answers) if (a.idea_id !== null && a.idea_id !== undefined && !done.has(a.idea_id)) done.set(a.idea_id, a);
  const ownKeys = new Set(answers.map((a) => a.attempt_key));
  // An idea another round asked today (an answer in the daily round, a chapter recall that covered it, another
  // checkpoint) rests, whether or not its grade has landed yet.
  const askedElsewhere = new Set<number>();
  for (const a of pool.answered_today) {
    if (ownKeys.has(a.attempt_key) || a.grading_status === "invalidated") continue;
    if (a.idea_id !== null && a.idea_id !== undefined) askedElsewhere.add(a.idea_id);
    for (const c of a.covers ?? []) askedElsewhere.add(c);
  }
  const hash = new Map(pool.ideas.map((i) => [i.idea_id, sha256Hex(`${i.idea_id}|${pool.today}`)]));
  const rank = (a: PoolIdea, b: PoolIdea) =>
    importanceRank(a.importance) - importanceRank(b.importance) ||
    Number(!a.has_explain) - Number(!b.has_explain) ||
    String(hash.get(a.idea_id)).localeCompare(String(hash.get(b.idea_id))) ||
    a.idea_id - b.idea_id;
  const seen = new Set<number>();
  const inPool = new Map<number, PoolIdea>();
  const candidates: PoolIdea[] = [];
  for (const i of pool.ideas) {
    if (seen.has(i.idea_id)) continue;
    seen.add(i.idea_id);
    inPool.set(i.idea_id, i);
    if (i.chapter < 1 || i.chapter > pool.chapter || i.importance === "detail") continue;
    if (done.has(i.idea_id) || askedElsewhere.has(i.idea_id)) continue;
    if (i.last_reviewed !== null && daysBetween(i.last_reviewed, pool.today) < CHECKPOINT_QUIET_DAYS) continue;
    candidates.push(i);
  }
  candidates.sort(rank);

  const inLatest = (i: PoolIdea) => i.chapter >= opts.actFrom;
  const remaining = Math.max(0, size - answers.length);
  const latestDone = answers.filter((a) => (a.chapter ?? 0) >= opts.actFrom && (a.chapter ?? 0) <= pool.chapter).length;
  const explainDone = answers.filter((a) => a.format === "explain").length;
  const needLatest = Math.max(0, half - latestDone);
  const needExplain = Math.max(0, CHECKPOINT_MIN_EXPLAIN - explainDone);

  const attempt = (explainFirst: boolean) => {
    const out: PoolIdea[] = [];
    const taken = new Set<number>();
    const take = (i: PoolIdea) => {
      if (out.length >= remaining || taken.has(i.idea_id)) return;
      taken.add(i.idea_id);
      out.push(i);
    };
    const latest = () => out.filter(inLatest).length;
    const explains = () => out.filter((i) => i.has_explain).length;
    const explainThenRank = (a: PoolIdea, b: PoolIdea) => Number(!a.has_explain) - Number(!b.has_explain) || rank(a, b);
    for (const i of candidates.filter(inLatest).sort(explainFirst ? explainThenRank : rank)) {
      if (latest() >= needLatest) break;
      take(i);
    }
    for (const i of candidates.filter((c) => c.has_explain)) {
      if (explains() >= needExplain) break;
      take(i);
    }
    for (const i of candidates) take(i);
    out.sort(rank);
    const met = remaining === 0 || (out.length === remaining && latest() >= needLatest && explains() >= needExplain);
    return { out, met };
  };
  // The first try keeps importance first; when that cannot meet both quotas, explain-capable ideas of the latest act
  // come first (they serve both quotas at once).
  let best = attempt(false);
  if (!best.met) {
    const second = attempt(true);
    if (second.met) best = second;
  }

  const donePool = [...done.keys()].map((id) => inPool.get(id)).filter((i): i is PoolIdea => !!i);
  const picked = [...best.out, ...donePool].sort(rank);
  const orphanExplain = answers.filter((a) => a.format === "explain" && !(a.idea_id !== null && a.idea_id !== undefined && inPool.has(a.idea_id))).length;
  const started = answers.length > 0;
  const fillable = candidates.length >= remaining;
  const ready = remaining === 0 ? true : started ? fillable : best.met;
  let shortfall: Shortfall | null = null;
  if (!ready) {
    if (!fillable) shortfall = "ideas";
    else if (candidates.filter(inLatest).length < needLatest) shortfall = "latest";
    else shortfall = "explain";
  }
  return {
    picked,
    fresh: best.out,
    done,
    answers,
    tally: quizTally(pool),
    orphanExplain,
    remaining,
    eligible: candidates.length + answers.length,
    ready,
    shortfall,
    relaxed: ready && started && remaining > 0 && !best.met,
  };
}

const explainOf = (idea: DeckIdea): DeckQuestion | null => (idea.questions ?? []).find((q) => q.format === "explain") ?? null;

/** How many explain questions a set of cards holds, plus the explain answers whose idea has no card. */
export const explainCount = (cards: Pick<RoundCard, "format">[], sel: Pick<CheckpointSelection, "orphanExplain">): number =>
  cards.filter((c) => c.format === "explain").length + sel.orphanExplain;

/**
 * The cards of a selection. An idea answered in this quiz keeps the question it was answered with (marked done);
 * the others take pickQuestion's variant for their stage, and the first ones that have an explain variant are turned
 * into explain questions until the quiz has CHECKPOINT_MIN_EXPLAIN of them (answers whose idea has no card count).
 * An idea with no usable question, or whose answered question is gone, has no card. Interleaved like a round (no two
 * of one chapter in a row when avoidable).
 */
export function buildCheckpointCards(sel: CheckpointSelection, ideas: DeckIdea[], today: string): RoundCard[] {
  const byId = new Map(ideas.map((i) => [i.idea_id, i]));
  const rows: { idea: DeckIdea; question: DeckQuestion; done: PoolAnswer | null }[] = [];
  for (const p of sel.picked) {
    const idea = byId.get(p.idea_id);
    if (!idea) continue;
    const answered = sel.done.get(p.idea_id) ?? null;
    const question = answered ? (idea.questions ?? []).find((q) => q.question_id === answered.question_id) ?? null : pickQuestion(idea);
    if (!question) continue;
    rows.push({ idea, question, done: answered });
  }
  let explains = rows.filter((r) => r.question.format === "explain").length + sel.orphanExplain;
  for (const r of rows) {
    if (explains >= CHECKPOINT_MIN_EXPLAIN) break;
    if (r.done || r.question.format === "explain") continue;
    const q = explainOf(r.idea);
    if (!q) continue;
    r.question = q;
    explains += 1;
  }
  const cards: RoundCard[] = rows.map((r) => ({
    key: `idea:${r.idea.idea_id}`,
    kind: "idea",
    chapter: r.idea.chapter,
    format: r.question.format,
    slot: "checkpoint",
    idea: r.idea,
    question: r.question,
    done: r.done !== null,
    attempt_key: r.done?.attempt_key,
  }));
  return interleave(cards, today);
}
