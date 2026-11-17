import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { answerOf, answeredIdeaIds, bankFailure, cardOut, SLUG_RE, type BankAnswer } from "./reading-recall-server";
import { roundMinutes, type Deck, type DeckIdea } from "./reading-recall";
import {
  buildCheckpointCards,
  CHECKPOINT_CARDS_MAX,
  CHECKPOINT_MIN_EXPLAIN,
  checkpointQuizKey,
  checkpointRoundKey,
  explainCount,
  parsePool,
  selectCheckpointIdeas,
} from "./reading-checkpoint";
import { CHECKPOINT_SIZE, checkpointActStart, checkpointChapters, checkpointKey, getBook } from "./reading";

/**
 * The checkpoint quiz's round, server side (READ-QUIZ-01 S5; docs/reading-question-bank.md "Checkpoint quiz").
 * GET /api/reading/practice/checkpoint?book=&chapter=N. The client MUST be the service-role client scoped to schema
 * "pds": the bank's tables are service-role only, and both reads go through SQL that applies the spoiler gate
 * (pds.reading_bank_checkpoint_pool, pds.reading_bank_idea_cards), so a locked chapter's ideas never leave the server.
 *
 * Two steps, the second in parallel with the quiz lookup: the pool of ideas that may be asked and today's answers, the
 * choice in code (lib/reading-checkpoint.ts selectCheckpointIdeas), then the full cards of the picked ideas. It
 * writes nothing and starts nothing: the same day gives the same quiz, and a quiz opened again keeps the cards already
 * answered in it (marked done), so closing and reopening resumes. The answer is a practice round (the shape of
 * lib/reading-recall-server.ts getRound: the runner reads it as one) plus {checkpoint, chapter, quiz_key, quiz,
 * tally, remaining, eligible, size, ready, shortfall}; `quiz` is set once today's result was recorded (then there are
 * no cards: a quiz key is one per day). `tally` is the database's own count of the quiz's valid answers
 * ({total, right, pending}), from every answer under the quiz key whether or not its idea is still in the quiz: the
 * result is recorded from it, because the database checks the result against exactly those answers.
 *
 * A quiz is `ready` only when it can be built with the quotas met (half from the latest act, at least three explain
 * questions), a resumed one included (what it already holds counts toward them); otherwise `shortfall` names what is
 * short ("ideas" | "latest" | "explain") and there are no cards (the answers already given stay valid).
 * `brief=1` answers the same without the cards (no cards read): the page asks it to learn, after a reload, whether a
 * quiz holds answers without a recorded result. Errors leave as short codes only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export interface CheckpointQuery {
  slug: string | null;
  chapter: number;
  /** Without the cards: the tally and today's result only. */
  brief?: boolean;
}

/** GET query: `book` (a slug, optional), `chapter` (the checkpoint's chapter, required) and `brief=1` (optional). */
export function parseCheckpointQuery(sp: URLSearchParams): { ok: true; query: CheckpointQuery } | { ok: false; error: string } {
  const slug = sp.get("book") || null;
  if (slug !== null && !SLUG_RE.test(slug)) return { ok: false, error: "bad_book" };
  const raw = sp.get("chapter");
  const chapter = Number(raw);
  if (raw === null || !/^\d{1,6}$/.test(raw) || !Number.isInteger(chapter) || chapter < 1) return { ok: false, error: "bad_request" };
  const brief = sp.get("brief");
  if (brief !== null && brief !== "1") return { ok: false, error: "bad_request" };
  return { ok: true, query: brief === "1" ? { slug, chapter, brief: true } : { slug, chapter } };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function getCheckpointRound(supabase: Supa, q: CheckpointQuery): Promise<BankAnswer> {
  try {
    const [poolRes, book] = await Promise.all([supabase.rpc("reading_bank_checkpoint_pool", { p_slug: q.slug, p_chapter: q.chapter }), getBook(supabase, q.slug)]);
    if (poolRes.error) {
      const f = bankFailure(null, poolRes.error);
      return { status: f?.status ?? 500, body: { error: f?.error ?? "failed" } };
    }
    if (poolRes.data == null || !book) return { status: 404, body: { error: "book_not_found" } };
    const pool = parsePool(poolRes.data);
    if (!pool) return { status: 500, body: { error: "failed" } };
    if (book.book_id !== pool.book_id) return { status: 404, body: { error: "book_not_found" } };
    const total = book.total_chapters ?? 0;
    if (!checkpointChapters(total).includes(q.chapter)) return { status: 400, body: { error: "bad_checkpoint" } };
    if (!pool.enabled) return { status: 409, body: { error: "bank_off" } };
    if (pool.quiz_through < q.chapter) return { status: 409, body: { error: "locked" } };

    const roundKey = checkpointRoundKey(pool.book_id, pool.today, q.chapter);
    const quizKey = checkpointQuizKey(pool.book_id, pool.today, q.chapter);
    const sel = selectCheckpointIdeas(pool, { actFrom: checkpointActStart(total, q.chapter) });
    const ids = !q.brief && sel.ready ? sel.picked.map((p) => p.idea_id).slice(0, CHECKPOINT_CARDS_MAX) : [];
    const cardsRead: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> = ids.length
      ? supabase.rpc("reading_bank_idea_cards", { p_slug: q.slug, p_ids: ids })
      : Promise.resolve({ data: [], error: null });
    const [quizRes, cardsRes] = await Promise.all([supabase.from("reading_quizzes").select("quiz_id, score, total").eq("op_key", quizKey).maybeSingle(), cardsRead]);
    if (cardsRes.error) {
      const f = bankFailure(null, cardsRes.error);
      return { status: f?.status ?? 500, body: { error: f?.error ?? "failed" } };
    }
    // A failed lookup reads as "not recorded": the answer route says quiz_closed if it was after all.
    const rec = !quizRes.error && isObj(quizRes.data) ? { score: Number(quizRes.data.score), total: Number(quizRes.data.total) } : null;
    const ideas = (Array.isArray(cardsRes.data) ? cardsRes.data : []).filter((i): i is DeckIdea => isObj(i) && typeof i.idea_id === "number");
    const cards = rec || q.brief ? [] : buildCheckpointCards(sel, ideas, pool.today);
    // A quiz that cannot be drawn whole is withheld, never trimmed: every idea still to ask needs a card, and the quiz
    // (new or resumed: what it already holds counts) needs its explain questions (the choice made sure ideas with an
    // explain variant were picked).
    const drawn = cards.filter((c) => !c.done).length;
    let ready = !rec && sel.ready;
    let shortfall = sel.shortfall;
    if (ready && !q.brief) {
      if (drawn < sel.fresh.length) {
        ready = false;
        shortfall = "ideas";
      } else if (sel.remaining > 0 && explainCount(cards, sel) < CHECKPOINT_MIN_EXPLAIN) {
        ready = false;
        shortfall = "explain";
      }
    }
    const shown = ready ? cards : [];
    const deck: Deck = { book_id: pool.book_id, today: pool.today, quiz_through: pool.quiz_through, enabled: true, ideas, chapter_recall: [], highlights: [], answered_today: pool.answered_today };
    const answered = answeredIdeaIds(deck);
    const out = shown.map((c) => cardOut(c, deck, answered));
    return {
      status: 200,
      body: {
        today: pool.today,
        quiz_through: pool.quiz_through,
        enabled: true,
        round_key: roundKey,
        kind: "checkpoint",
        n: q.chapter,
        cards: out,
        done: out.filter((c) => c.done).length,
        minutes: roundMinutes(shown),
        extra_available: 0,
        chapter_recall: null,
        checkpoint: checkpointKey(q.chapter),
        chapter: q.chapter,
        quiz_key: quizKey,
        quiz: rec,
        tally: sel.tally,
        remaining: sel.remaining,
        eligible: sel.eligible,
        size: CHECKPOINT_SIZE,
        ready,
        shortfall: ready ? null : shortfall,
      },
    };
  } catch (e) {
    return answerOf(e);
  }
}
