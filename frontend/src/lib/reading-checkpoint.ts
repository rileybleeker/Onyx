/**
 * The checkpoint quiz's selection (READ-QUIZ-01 S5; docs/reading-question-bank.md "Checkpoint quiz"). Pure: the
 * route (lib/reading-checkpoint-server.ts) and the tests run the same code.
 *
 * A checkpoint quiz is CHECKPOINT_SIZE questions from chapters 1..N, one per idea: core ideas before supporting ones,
 * detail ideas never, at least half from the latest act (the chapters since the previous checkpoint), at least
 * CHECKPOINT_MIN_EXPLAIN explain questions, and no idea answered in the last CHECKPOINT_QUIET_DAYS days. The pool
 * comes from pds.reading_bank_checkpoint_pool (the spoiler gate applied in SQL); this file only chooses.
 *
 * The choice is deterministic for a pool and a day, and a quiz opened again the same day keeps the ideas already
 * answered in it (their cards come back marked done), so closing and reopening resumes. An idea answered in this quiz
 * counts as a candidate again whatever its last answer date says, and is always part of the selection.
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

export interface CheckpointPool {
  book_id: number;
  today: string;
  quiz_through: number;
  chapter: number;
  enabled: boolean;
  ideas: PoolIdea[];
  answered_today: DeckAnswered[];
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
  const answered = (Array.isArray(raw.answered_today) ? raw.answered_today : []).filter(
    (a): a is DeckAnswered => isObj(a) && typeof a.attempt_key === "string" && typeof a.question_id === "number",
  );
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

/** The answers that belong to THIS quiz: its round key, one per idea (the first by attempt key). */
export function quizAnswers(pool: CheckpointPool): Map<number, DeckAnswered> {
  const key = checkpointRoundKey(pool.book_id, pool.today, pool.chapter);
  const out = new Map<number, DeckAnswered>();
  for (const a of [...pool.answered_today].sort((x, y) => x.attempt_key.localeCompare(y.attempt_key))) {
    if (a.round_key !== key || a.idea_id === null || a.idea_id === undefined || a.grading_status === "invalidated") continue;
    if (!out.has(a.idea_id)) out.set(a.idea_id, a);
  }
  return out;
}

export interface CheckpointSelection {
  /** The ideas of the quiz, best first (answered ones included). */
  picked: PoolIdea[];
  /** How many ideas could be asked (answered ones included). */
  eligible: number;
  /** The ideas already answered in this quiz. */
  done: Map<number, DeckAnswered>;
  /** Enough ideas to offer the quiz, or a quiz that was already started. */
  ready: boolean;
}

/**
 * Which ideas the quiz asks. Candidates: chapters 1..N, not detail, quiet for CHECKPOINT_QUIET_DAYS (or answered in this
 * quiz). Ranked by importance, then ideas with an explain variant, then a hash fixed by the idea and the day. Taken:
 * the best of the latest act until half the quiz is from it, then the best of all until the quiz is full; an idea
 * already answered in this quiz is always kept (see below).
 */
export function selectCheckpointIdeas(pool: CheckpointPool, opts: { actFrom: number; size?: number }): CheckpointSelection {
  const size = opts.size ?? CHECKPOINT_SIZE;
  const done = quizAnswers(pool);
  const hash = new Map(pool.ideas.map((i) => [i.idea_id, sha256Hex(`${i.idea_id}|${pool.today}`)]));
  const rank = (a: PoolIdea, b: PoolIdea) =>
    importanceRank(a.importance) - importanceRank(b.importance) ||
    Number(!a.has_explain) - Number(!b.has_explain) ||
    String(hash.get(a.idea_id)).localeCompare(String(hash.get(b.idea_id))) ||
    a.idea_id - b.idea_id;
  const seen = new Set<number>();
  const candidates = pool.ideas
    .filter((i) => {
      if (seen.has(i.idea_id)) return false;
      seen.add(i.idea_id);
      if (i.chapter < 1 || i.chapter > pool.chapter || i.importance === "detail") return false;
      return done.has(i.idea_id) || i.last_reviewed === null || daysBetween(i.last_reviewed, pool.today) >= CHECKPOINT_QUIET_DAYS;
    })
    .sort(rank);
  const inLatest = (i: PoolIdea) => i.chapter >= opts.actFrom;
  // The choice is made over every candidate, answered ones included, so it is the same before and after an idea is
  // answered; an answered idea that the choice would not have made (a pool that changed meanwhile) takes the place of
  // the lowest-ranked one still unanswered.
  const picked: PoolIdea[] = [];
  const taken = new Set<number>();
  const half = Math.ceil(size / 2);
  for (const i of candidates) {
    if (picked.length >= size || picked.filter(inLatest).length >= half) break;
    if (inLatest(i)) {
      picked.push(i);
      taken.add(i.idea_id);
    }
  }
  for (const i of candidates) {
    if (picked.length >= size) break;
    if (!taken.has(i.idea_id)) {
      picked.push(i);
      taken.add(i.idea_id);
    }
  }
  for (const i of candidates) {
    if (!done.has(i.idea_id) || taken.has(i.idea_id)) continue;
    picked.sort(rank);
    const out = [...picked].reverse().findIndex((x) => !done.has(x.idea_id));
    if (out < 0) break;
    const [gone] = picked.splice(picked.length - 1 - out, 1);
    taken.delete(gone.idea_id);
    picked.push(i);
    taken.add(i.idea_id);
  }
  picked.sort(rank);
  return { picked, eligible: candidates.length, done, ready: candidates.length >= size || done.size > 0 };
}

const explainOf = (idea: DeckIdea): DeckQuestion | null => (idea.questions ?? []).find((q) => q.format === "explain") ?? null;

/**
 * The cards of a selection. An idea answered in this quiz keeps the question it was answered with (marked done);
 * the others take pickQuestion's variant for their stage, and the first ones that have an explain variant are turned
 * into explain questions until the quiz has CHECKPOINT_MIN_EXPLAIN of them. An idea with no usable question, or whose
 * answered question is gone, has no card. Interleaved like a round (no two of one chapter in a row when avoidable).
 */
export function buildCheckpointCards(sel: CheckpointSelection, ideas: DeckIdea[], today: string): RoundCard[] {
  const byId = new Map(ideas.map((i) => [i.idea_id, i]));
  const rows: { idea: DeckIdea; question: DeckQuestion; done: DeckAnswered | null }[] = [];
  for (const p of sel.picked) {
    const idea = byId.get(p.idea_id);
    if (!idea) continue;
    const answered = sel.done.get(p.idea_id) ?? null;
    const question = answered ? (idea.questions ?? []).find((q) => q.question_id === answered.question_id) ?? null : pickQuestion(idea);
    if (!question) continue;
    rows.push({ idea, question, done: answered });
  }
  let explains = rows.filter((r) => r.question.format === "explain").length;
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
