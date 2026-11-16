"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Minus, MoreHorizontal, X } from "lucide-react";
import { DONT_KNOW_ANSWER, gradeLocal, orderAnswerText, parseRubric, QUICK_SIZE, type ModelVerdict, type Verdict } from "@/lib/reading-recall";
import { attemptFor, classifyReviewAnswer, GRADE_LABEL, intervalLabel, newOpKey, PRACTICE_GRADES, type PracticeGrade, type ReviewAttempt } from "@/lib/reading-practice";
import {
  ANSWER_MAX_CHARS,
  ATTEMPT_URL,
  choiceOrder,
  classifyAttemptAnswer,
  classifyFlagAnswer,
  classifyOverrideAnswer,
  coveredSplit,
  createFlagQueue,
  FLAG_LABEL,
  FLAG_URL,
  getJson,
  heldAttemptFor,
  inDays,
  nextLine,
  offeredOrder,
  overrideUrl,
  parseRoundAttempts,
  POLL_EVERY_MS,
  POLL_FOR_MS,
  postJson,
  realTimers,
  resendAttempt,
  REVIEW_URL,
  roundAttemptsUrl,
  SELF_VERDICTS,
  summarize,
  VERDICT_VIEW,
  weekday,
  type AttemptOutbox,
  type AttemptReceipt,
  type AttemptRequest,
  type AttemptResult,
  type FlagKind,
  type FlagQueue,
  type HeldFlag,
  type PracticeCard,
  type PracticeQuestion,
  type PracticeRound,
  type SummaryItem,
  type Timers,
} from "@/lib/reading-practice-client";
import { classifyQuizAnswer, decideRecord, passed as quizPassed, QUIZ_URL, quizRequest, type QuizTally } from "@/lib/reading-map";
import { CHECKPOINT_PASS, CHECKPOINT_SIZE } from "@/lib/reading";
import { AlertLine, AnswerBox, CardChips, ChoiceList, CoveredList, KeyPoints, OrderPicker, VerdictWord, WhereFrom } from "./PracticeCards";

/**
 * The practice runner (READ-QUIZ-01 S4; docs/reading-question-bank.md "Practice"). A round of cards from
 * GET /api/reading/practice/today, answered one at a time.
 *
 * - Phone (< 768 px): a full-screen sheet (fixed, safe-area padding) whose bottom bar stays above the keyboard
 *   (visualViewport). Desktop: the same card in place inside the Practice part, at most 640 px wide. Which one
 *   follows the media query live (a phone turned to landscape gets the in-place card), with no md: classes.
 * - Quick 3 is the first 3 cards still open today, so a second Quick 3 the same day goes on where the first stopped.
 * - The answer stays hidden until Check or "I don't know". Code-graded formats show the verdict at once (before the
 *   POST returns; the server re-grades with the same function and its verdict wins); model-graded ones show
 *   "Saved · grading" and the key points, and the verdict arrives from the round's attempts, polled every 2 s while
 *   anything is pending, for up to a minute. The next card never waits for a model grade.
 * - One request at a time; a card stays on failure. "Not sure it saved" offers Retry, which sends the SAME request
 *   (same attempt_key), so a lost answer is answered from its receipt. A refusal stored nothing: the answer can be
 *   changed and checked again, except a refusal of a RETRY that names no reason (session, origin, size, rate limit),
 *   which proves nothing about the earlier try and stays "not sure" with the same key (a highlight grade and a
 *   Disagree behave the same). Typed answers live in memory only; unconfirmed requests are re-sent with keepalive
 *   when the page hides. Nothing is written to disk. Those requests are held by the Practice part (`outbox`), not by
 *   the runner: closing, or the wait for them running out, settles nothing about a request that failed or is slow, so
 *   a reopened round shows that card as "Not sure it saved" with the same request (Retry, same attempt_key) instead of
 *   asking the question again under a new key while the first request may still commit.
 * - Skip for now stores nothing and moves the card to the end (a second Skip takes it out of today's round). An
 *   incorrect answer brings the idea back once at the end with another variant ("Again"; it never moves the
 *   schedule); a model grade that comes after the round ended offers it on the summary instead. Flags (Wrong,
 *   Unclear, Not in this chapter, Not read yet) are held 8 s with Undo, then sent; a held flag goes out when the page
 *   hides or the runner closes. A sent Wrong / Unclear voids the answers it hit at once (no verdict, no XP, no
 *   "moved up") and the round's attempts are read back.
 * - The summary lists every answered card (this sitting and earlier today); a tap opens its result again, with the
 *   feedback, Disagree, Grade it yourself and the flags. A resumed round reads its earlier answers' grades once on
 *   open and polls for one still pending.
 * - Closing (Done, ×, Esc, One more round) sends what is pending and tells the part when it has settled, so the part
 *   re-reads the round only after the answers and flags landed. × and Esc with a typed answer not yet checked ask
 *   first ("Leave without checking?"): the answer lives in memory only, so closing would lose it (an Esc that cancels
 *   an input method's composition never closes anything).
 * - "Not read yet" hides the held chapter and every later one at once, stored answers included: they leave the
 *   summary's list, the opened results and the chapter recall's Covered / Missed, because their prompts, answers
 *   and sources now state what Riley said he has not read (the counts stay; the answers are still valid).
 * - "Not in this chapter" locks its idea the same way once it is sent (the server moves the idea and every question of
 *   it to the end of the book): its answered cards leave the summary's list and the opened results, and a chapter
 *   recall answer that listed the idea leaves with its Covered / Missed lists; the round is re-read.
 * - Keys only act from inside the runner (or with nothing focused) and never on an event another widget handled;
 *   Esc only with focus inside.
 * - Chapter mode ("Practice 5" on a chapter sheet) is a round like any other. Checkpoint mode (READ-QUIZ-01 S5) is a
 *   quiz: its answers carry round_kind "checkpoint" and the quiz_key, there is no Skip and no "Again" (one answer per
 *   idea), and the summary is the quiz result: right of total, the 80% line, the answers to open again. Done waits
 *   until every answer is saved and graded (Disagree and "Grade it yourself" stay possible until then), then records
 *   the result once through POST /api/reading/quiz with op_key = quiz_key (a lost answer is retried with the SAME
 *   request, so it is stored once); leaving without Done records nothing. The result comes from the DATABASE's count
 *   of the quiz's valid answers (`onTally`: every answer under the quiz key, whether or not its card is on screen), not
 *   from the cards: a quiz is recorded only with exactly its full number of valid, graded answers, so a quiz cut down
 *   by flags (one answer, the rest removed) is never recorded as a smaller, passing one, and an answer whose idea left
 *   the quiz still counts. Done also waits for flags still held or on their way (a sent flag voids answers), and a
 *   quiz that is short says so and offers Close: reopening the checkpoint draws the replacements.
 * - The verdict is announced once (aria-live polite) as a word; every verdict on screen is an icon plus a word.
 *   Check / Next move focus predictably (to Next, then to the next prompt). Keys on a desktop: 1-4 pick an option,
 *   Enter checks a choice, Ctrl/Cmd+Enter checks a typed answer, N goes to the next card, Esc closes the menu or the
 *   runner (answers already stored stay; reopening the round resumes it).
 */

type Phase = "open" | "saving" | "saved" | "unknown" | "refused" | "stale" | "past" | "out";

interface Change {
  mode: "override" | "self";
  verdict: ModelVerdict;
  status: "saving" | "saved" | "unknown" | "refused";
  message?: string;
}

interface QuizSave {
  /** checking = reading the database's count; waiting / short / unread = nothing was sent (and why). */
  status: "idle" | "checking" | "saving" | "saved" | "unknown" | "refused" | "waiting" | "short" | "unread";
  message?: string;
  passed?: boolean;
  xp?: number;
  /** The database's count the result was (or would be) recorded from. */
  tally?: QuizTally;
}

interface Item {
  key: string;
  card: PracticeCard;
  /** The variant asked (an "Again" repeat asks the idea's other variant). */
  question: PracticeQuestion | null;
  again: boolean;
  skips: number;
  phase: Phase;
  /** Answered before this sitting (a resumed round): counted as done, never asked again today. */
  earlier: boolean;
  stored: boolean;
  answer: string;
  hinted: boolean;
  choice: number | null;
  order: number[];
  shownAt: number | null;
  req: AttemptRequest | null;
  /** The code grade shown at once (null for model-graded answers). */
  local: Verdict | null;
  receipt: AttemptReceipt | null;
  savedAt: number | null;
  message: string | null;
  // Highlight review cards.
  revealed: boolean;
  review: ReviewAttempt | null;
  reviewDays: number | null;
  reviewNext: string | null;
  reviewXp: number;
  change: Change | null;
}

function newItem(card: PracticeCard, question: PracticeQuestion | null = card.question, again = false): Item {
  return {
    key: again ? `${card.key}:again` : card.key,
    card,
    question,
    again,
    skips: 0,
    phase: card.done && !again ? "past" : "open",
    earlier: card.done && !again,
    stored: card.done && !again,
    answer: "",
    hinted: false,
    choice: null,
    order: [],
    shownAt: null,
    req: null,
    local: null,
    receipt: null,
    savedAt: null,
    message: null,
    revealed: false,
    review: null,
    reviewDays: null,
    reviewNext: null,
    reviewXp: 0,
    change: null,
  };
}

/**
 * A card whose answer was sent before the runner was closed and never confirmed (see AttemptOutbox): back as "Not sure
 * it saved" with the same request, so Retry sends it under the same key (a stored answer answers its receipt) and the
 * question is never asked again under a new one. The answer is shown as Riley gave it.
 */
function withHeldRequest(it: Item, req: AttemptRequest): Item {
  const q = it.question;
  if (!q || it.card.kind === "highlight") return it;
  const rub = parseRubric(q.rubric);
  const options = rub?.format === "cued" ? rub.options ?? [] : [];
  const steps = rub?.format === "order" ? rub.steps : [];
  const dontKnow = req.answer === DONT_KNOW_ANSWER;
  const choice = q.format === "cued" && req.hinted ? options.indexOf(req.answer) : -1;
  const used = new Set<number>();
  const order =
    q.format === "order"
      ? req.answer.split("\n").map((line) => {
          const i = steps.findIndex((step, k) => step === line && !used.has(k));
          if (i >= 0) used.add(i);
          return i;
        })
      : [];
  const g = gradeLocal(q.format, q.rubric, req.answer, req.hinted);
  return {
    ...it,
    phase: "unknown",
    req,
    hinted: req.hinted,
    answer: q.format === "order" || (q.format === "cued" && req.hinted) || dontKnow ? "" : req.answer,
    choice: choice >= 0 ? choice : null,
    order: order.length === steps.length && order.every((i) => i >= 0) ? order : [],
    local: g.kind === "graded" ? g.verdict : null,
    message: "This answer was sent before you closed the round, and Onyx never confirmed it. Retry to find out.",
  };
}

/** The round's cards as items, the ones with an unconfirmed request back as such (the first of them opens the runner). */
function seedRound(round: PracticeRound, mode: PracticeRunnerProps["mode"], outbox: AttemptOutbox): { items: Record<string, Item>; order: string[]; held: string | null } {
  const cards = startingCards(round, mode);
  const items: Record<string, Item> = {};
  for (const c of cards) {
    const base = newItem(c);
    const req = base.stored ? null : heldAttemptFor(outbox, round.round_key, c.question);
    items[c.key] = req ? withHeldRequest(base, req) : base;
  }
  return { items, order: cards.map((c) => c.key), held: cards.find((c) => items[c.key].phase === "unknown")?.key ?? null };
}

/** The answer's key (lower case, as the round's attempts are keyed): this sitting's request, or the earlier one. */
const attemptKeyOf = (it: Item): string | null => (it.req?.attempt_key ?? it.card.attempt_key ?? null)?.toLowerCase() ?? null;
const isDone = (it: Item) => it.phase === "past" || it.phase === "out";
const answerable = (it: Item) => it.phase === "open" || it.phase === "refused";
const canNext = (it: Item) => it.phase === "saved" || it.phase === "stale";
/**
 * Still to be shown: not asked yet, or asked with an answer whose save was not confirmed (a card the runner reopened
 * with, see withHeldRequest, comes first; in this sitting an unconfirmed card is always the one on screen).
 */
const isWaiting = (it: Item) => it.phase === "open" || it.phase === "unknown";
/** The card shows a text box (not steps to order, not the four choices) ... */
const showsTextBox = (it: Item) => !it.earlier && it.question?.format !== "order" && !(it.question?.format === "cued" && it.hinted);
/** ... and Riley typed something in it that was not checked yet: it lives in memory only, so closing would lose it. */
const typedUnsent = (it: Item) => answerable(it) && it.card.kind !== "highlight" && showsTextBox(it) && it.answer.trim() !== "";
/** More characters than the attempt route takes (400 bad_answer): Check waits until it is shortened. */
const tooLong = (it: Item) => showsTextBox(it) && it.answer.length > ANSWER_MAX_CHARS;

type Results = Record<string, AttemptResult>;

/** A chapter recall card whose question lists this idea (the question the server re-versions when the idea moves or goes). */
function recallListsIdea(it: Item, ideaId: number): boolean {
  const rub = it.question ? parseRubric(it.question.rubric) : null;
  return rub?.format === "chapter_recall" && rub.ideas.some((i) => i.idea_id === ideaId);
}

/** A stored answer a sent Wrong / Unclear flag voided: marked here at once, and read back as invalidated. */
function isVoided(it: Item, results: Results, voided: ReadonlySet<string>): boolean {
  if (voided.has(it.key) || it.receipt?.grading_status === "invalidated") return true;
  const k = attemptKeyOf(it);
  return !!k && results[k]?.grading_status === "invalidated";
}

/**
 * The verdict on screen: a Disagree / self grade, then the server's grade, then the code grade shown at once. None
 * for a voided answer (it earns no XP and moves nothing, so it shows no verdict either).
 */
function verdictOf(it: Item, results: Results, voided: ReadonlySet<string>): Verdict | null {
  if (it.card.kind === "highlight" || isVoided(it, results, voided)) return null;
  if (it.change?.status === "saved") return it.change.verdict;
  const k = attemptKeyOf(it);
  const r = k ? results[k] : undefined;
  if (r?.grading_status === "graded" && r.verdict) return r.verdict;
  if (it.receipt) return it.receipt.grading_status === "graded" ? it.receipt.verdict : null;
  return it.local;
}
function isGrading(it: Item, results: Results, voided: ReadonlySet<string>): boolean {
  if (!it.stored || it.card.kind === "highlight" || it.change?.status === "saved" || isVoided(it, results, voided)) return false;
  // An answer from before this sitting (a resumed round): grading while the round's attempts, read when the runner
  // opens, say so.
  if (it.earlier) {
    const k = attemptKeyOf(it);
    return !!k && results[k]?.grading_status === "pending";
  }
  return verdictOf(it, results, voided) === null;
}

/**
 * Phone versus desktop follows the media query live (a phone turned to landscape is wider than 767 px), and the
 * classes are chosen from it, never from md: breakpoints: the phone sheet is drawn in document.body, where a
 * breakpoint class would turn it into an in-place card outside the page.
 */
const PHONE_QUERY = "(max-width: 767px)";
const phoneQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
const PHONE_SHEET_CLASS = "fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]";
const DESKTOP_SHEET_CLASS = "relative mx-auto block w-full max-w-[640px]";
/** How long closing waits for answers and flags on their way before the part re-reads anyway. */
const SETTLE_MAX_MS = 10_000;
const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-[15px] font-medium text-on-accent";
const SECONDARY = "inline-flex min-h-11 items-center justify-center rounded-control border border-border-default px-3 text-[14px] text-text-primary";

export interface CheckpointInfo {
  slug: string;
  chapter: number;
  /** "ch12". */
  key: string;
  quizKey: string;
  /** How many valid answers a complete quiz holds (CHECKPOINT_SIZE when absent). */
  size?: number;
}

export interface PracticeRunnerProps {
  round: PracticeRound;
  /** daily: the whole round; quick: the first 3 cards still open today; extra: "One more round". */
  mode: "daily" | "quick" | "extra" | "chapter" | "checkpoint";
  /** Checkpoint mode: the quiz this round belongs to ("ch12" is the key its result is recorded under). */
  checkpoint?: CheckpointInfo;
  /** The quiz result was stored (the first time, or a replay of the same request). */
  onRecorded?: (r: { score: number; total: number; passed: boolean; xp: number }) => void;
  /**
   * ×, Esc, Done. `changed`: something was stored or flagged; `finished`: the summary was reached. `settled` is set
   * when answers or flags were still on their way at close: it resolves once they are (at most SETTLE_MAX_MS), and the
   * part re-reads then, so a reopened round never offers an answer still being stored or a chapter just held.
   */
  onClose: (changed: boolean, finished: boolean, settled?: Promise<void>) => void;
  /** "One more round" from the summary (offered when the round says more are left); `settled` as for onClose. */
  onMore?: (settled?: Promise<void>) => void;
  /** Re-read the round (after a "Not read yet" hold); cards it no longer holds leave this sitting. */
  onReread?: () => Promise<PracticeRound | null>;
  /**
   * Answers sent and not confirmed (see AttemptOutbox). The Practice part passes the one that outlives this runner; a
   * runner mounted without one keeps its own for this sitting only.
   */
  outbox?: AttemptOutbox;
  /**
   * Checkpoint mode: the database's count of the quiz's valid answers, read when Done is tapped (null = could not be
   * read). Without it the count is the answers this sitting knows of, which still has to reach the quiz's full size.
   */
  onTally?: () => Promise<QuizTally | null>;
  /** The clock and timers (tests pass a manual one). */
  timers?: Timers;
}

/** Quick 3 = the first 3 cards of the round still open today (a second Quick 3 the same day goes on from there). */
const startingCards = (round: PracticeRound, mode: PracticeRunnerProps["mode"]): PracticeCard[] =>
  mode === "quick" ? round.cards.filter((c) => !c.done).slice(0, QUICK_SIZE) : round.cards;

export default function PracticeRunner({ round, mode, checkpoint, onClose, onMore, onReread, onTally, onRecorded, outbox: held, timers = realTimers }: PracticeRunnerProps) {
  // A checkpoint quiz: answers carry the quiz key, there is no Skip and no "Again", and Done records the result.
  const isQuiz = mode === "checkpoint" && !!checkpoint;
  const ownOutbox = useRef<AttemptOutbox | null>(null);
  if (!ownOutbox.current) ownOutbox.current = new Map();
  // Requests sent and not confirmed: re-sent with keepalive when the page hides, and kept past this runner when it closes.
  const outbox: AttemptOutbox = held ?? ownOutbox.current;
  const [seed] = useState(() => seedRound(round, mode, outbox));
  const [items, setItems] = useState<Record<string, Item>>(seed.items);
  const [order, setOrder] = useState<string[]>(seed.order);
  const [currentKey, setCurrentKey] = useState<string | null>(seed.held);
  const [results, setResults] = useState<Results>({});
  const [flags, setFlags] = useState<HeldFlag[]>([]);
  const [voided, setVoided] = useState(0);
  // Item keys whose stored answers a sent Wrong / Unclear flag voided (before the round's attempts say so).
  const [voidedKeys, setVoidedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // "Again" repeats whose model grade arrived after the round was over: offered on the summary, never pushed on it.
  const [againOffer, setAgainOffer] = useState<Item[]>([]);
  // Card keys a sent "Not read yet" put behind the gate: shown nowhere any more (the server stopped serving them).
  const [gated, setGated] = useState<ReadonlySet<string>>(() => new Set());
  // × / Esc with a typed answer not yet checked: asking before it is dropped.
  const [confirmLeave, setConfirmLeave] = useState(false);
  // An answered card opened again from the summary (its result, feedback, Disagree, Grade it yourself, flags).
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [focus, setFocus] = useState<"prompt" | "next" | "retry" | "summary" | "menu" | "input" | "note" | null>("prompt");
  const [pollTick, setPollTick] = useState(0);
  // Checkpoint mode: the result's save (idle -> saving -> saved, or unknown / refused with Retry or a way out).
  const [rec, setRec] = useState<QuizSave>({ status: "idle" });
  const [sheet, setSheet] = useState<{ top: number; height: number } | null>(null);
  // A phone (< 768 px) gets the full-screen sheet, drawn in document.body: inside the page it would sit in the app
  // shell's own stacking context, under the fixed mobile header and tab bar. Follows the media query (rotation).
  const [phone, setPhone] = useState(() => phoneQuery()?.matches === true);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const voidedRef = useRef(voidedKeys);
  voidedRef.current = voidedKeys;
  const gatedRef = useRef(gated);
  gatedRef.current = gated;
  const alive = useRef(true);
  const busy = useRef(false);
  const changed = useRef(false);
  const finished = useRef(false);
  const announced = useRef(new Set<string>());
  const againDone = useRef(new Set<string>());
  // Requests on their way (answers, grades, highlight reviews, flags) and the answers among them: closing waits for
  // them (leave) before the part re-reads.
  const inflight = useRef(new Set<Promise<unknown>>());
  const inflightKeys = useRef(new Set<string>());
  const drained = useRef(false);
  // Card keys of unanswered chapter recalls that list an idea a sent "Not in this chapter" moved (see reconcile).
  const staleRecall = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLHeadingElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const summaryRef = useRef<HTMLHeadingElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const onRereadRef = useRef(onReread);
  onRereadRef.current = onReread;
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onTallyRef = useRef(onTally);
  onTallyRef.current = onTally;
  // What this sitting knows of the quiz (set each render below): the fallback count when no `onTally` is given.
  const knownTally = useRef<QuizTally>({ total: 0, right: 0, pending: 0 });
  // The result's request, kept so Retry sends the SAME one (the score cannot differ between two tries).
  const quizReq = useRef<ReturnType<typeof quizRequest> | null>(null);

  const patch = (key: string, p: Partial<Item> | ((it: Item) => Partial<Item>)) =>
    setItems((prev) => {
      const it = prev[key];
      if (!it) return prev;
      return { ...prev, [key]: { ...it, ...(typeof p === "function" ? p(it) : p) } };
    });

  /** Keep a request in `inflight` until it settles (postJson never rejects). */
  function track<T>(p: Promise<T>): Promise<T> {
    inflight.current.add(p);
    const done = () => {
      inflight.current.delete(p);
    };
    void p.then(done, done);
    return p;
  }

  // The flag queue: created once, its state mirrored into `flags` for the screen.
  const queueRef = useRef<FlagQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createFlagQueue({
      timers,
      send: async (f, keepalive, retried) => {
        const r = await track(postJson(FLAG_URL, { flag_key: f.flag_key, question_id: f.question_id, kind: f.kind }, { keepalive }));
        // A retry whose refusal names no reason proves nothing about the earlier try: it stays "not sure" with Retry.
        return classifyFlagAnswer(r.status, r.body, retried);
      },
      onChange: (list) => {
        if (alive.current) setFlags(list);
      },
      onSent: (f, r) => {
        changed.current = true;
        if (!alive.current) return;
        if (r.invalidated) setVoided((v) => v + r.invalidated);
        if (f.kind === "wrong" || f.kind === "unclear") voidAnswers(f);
        if (f.kind === "not_read_yet") {
          holdGate(f);
          void reconcile();
        }
        if (f.kind === "not_in_chapter") {
          lockIdea(f);
          void reconcile();
        }
      },
    });
  }
  const queue = queueRef.current;

  /**
   * A "Not read yet" hold lowered the spoiler gate, or a "Not in this chapter" moved an idea: re-read the round. The
   * cards it no longer holds leave, and an unanswered card it still holds under ANOTHER question (a card key does not
   * carry the question: `recall:<chapter>` stays while the server re-versions the chapter recall without the moved
   * idea) takes the new question, so Check never reveals, or sends an answer to, a version that is gone. A card with a
   * request on its way is left to the server's answer.
   */
  async function reconcile() {
    const fresh = await onRereadRef.current?.().catch(() => null);
    if (!alive.current) return;
    // Recall cards that list a moved idea (lockIdea noted them): they cannot be offered as they are.
    const stale = staleRecall.current;
    staleRecall.current = new Set();
    if (!fresh) {
      if (stale.size) {
        setItems((prev) => {
          const next = { ...prev };
          for (const [k, it] of Object.entries(prev)) if (stale.has(it.card.key) && !isDone(it) && !it.stored && answerable(it) && !it.req) next[k] = { ...it, phase: "out" };
          return next;
        });
      }
      return;
    }
    const freshByKey = new Map(fresh.cards.map((c) => [c.key, c]));
    setItems((prev) => {
      const next = { ...prev };
      for (const [k, it] of Object.entries(prev)) {
        if (isDone(it) || it.stored) continue;
        const fc = freshByKey.get(it.card.key);
        if (!fc) {
          next[k] = { ...it, phase: "out" };
          continue;
        }
        // An "Again" repeat asks the idea's other variant; every other card its own question.
        const q = it.again ? fc.again_question : fc.question;
        if (!q || !it.question || it.card.kind === "highlight" || !answerable(it) || it.req) continue;
        if (q.question_id === it.question.question_id && q.version === it.question.version) continue;
        next[k] = {
          ...it,
          card: fc,
          question: q,
          // What was picked or ordered belongs to the old question's options; a typed answer stays only for the same question.
          hinted: false,
          choice: null,
          order: [],
          answer: q.question_id === it.question.question_id ? it.answer : "",
        };
      }
      return next;
    });
  }

  /**
   * A "Not read yet" hold the server confirmed: that chapter and every later one (and the whole-book ideas, which
   * unlock at the end of the book) are locked now, so no card of them may stay on screen. The unanswered ones leave
   * the round; the answered ones leave the summary's list and the opened results (render-time: `gated`), because
   * their prompts, reference answers, sources and Covered / Missed lists would show what the server no longer serves.
   * A card whose answer is on its way (or not confirmed) leaves the screen too ("past"): the request goes on (the
   * outbox re-sends it) and `send` keeps the card off screen whatever the answer is.
   */
  function holdGate(f: HeldFlag) {
    const all = Object.values(itemsRef.current);
    const flagged = all.find((x) => x.question?.question_id === f.question_id);
    // The server holds from the flagged chapter (at least 1: a whole-book card holds everything), and the whole-book
    // ideas (chapter 0) unlock only at the end of the book, so every hold covers them.
    const from = flagged?.card.chapter != null ? Math.max(1, flagged.card.chapter) : null;
    const keys = all
      .filter((x) => x.card.kind !== "highlight" && (x.card.key === flagged?.card.key || (from !== null && x.card.chapter !== null && (x.card.chapter >= from || x.card.chapter === 0))))
      .map((x) => x.card.key);
    gateCards(keys);
  }

  /**
   * A "Not in this chapter" the server confirmed moved the idea (and every question of it) to the end of the book,
   * so its prompts, reference answers and sources are locked until the book is finished, and the chapter recall
   * questions that list it were re-versioned without it. The answers stay valid (the counts stay), but their cards
   * leave the summary's list and the opened results like a held chapter's, and a chapter recall answer that listed
   * the idea leaves the Covered / Missed lists with it (the server hides that attempt too). An unanswered card of
   * the idea is already off screen (the flag's own cards), and an unanswered recall card takes the re-versioned
   * question from the re-read (reconcile), or leaves when the round cannot be read.
   */
  function lockIdea(f: HeldFlag) {
    const all = Object.values(itemsRef.current);
    const ideaId = all.find((x) => x.question?.question_id === f.question_id)?.card.idea?.idea_id ?? null;
    if (ideaId === null) return;
    // An unanswered recall that lists the idea is re-versioned by the server: the re-read replaces it (or drops it).
    for (const x of all) if (x.card.kind === "chapter_recall" && !x.stored && answerable(x) && !x.req && recallListsIdea(x, ideaId)) staleRecall.current.add(x.card.key);
    const keys = all
      .filter((x) => x.card.kind !== "highlight" && (x.card.idea?.idea_id === ideaId || (x.card.kind === "chapter_recall" && x.stored && recallListsIdea(x, ideaId))))
      .map((x) => x.card.key);
    gateCards(keys);
  }

  /** Put these cards (by card key) behind the gate: nothing of them stays on screen, whatever their answers' state. */
  function gateCards(keys: string[]) {
    if (!keys.length) return;
    const set = new Set(keys);
    gatedRef.current = new Set([...gatedRef.current, ...set]);
    setGated(gatedRef.current);
    setItems((prev) => {
      const next = { ...prev };
      for (const [k, it] of Object.entries(prev)) {
        if (!set.has(it.card.key)) continue;
        if (!it.stored && answerable(it)) next[k] = { ...it, phase: "out" };
        else if (it.phase === "saved" || it.phase === "stale" || it.phase === "saving" || it.phase === "unknown") next[k] = { ...it, phase: "past" };
      }
      return next;
    });
    setViewKey((v) => (v && itemsRef.current[v] && set.has(itemsRef.current[v].card.key) ? null : v));
  }

  /**
   * The round's attempts, read once (the runner opening on a resumed round, a sent Wrong / Unclear flag). With
   * `resume`, an earlier answer still waiting for its model grade starts the poll window from now.
   */
  async function refreshResults(resume = false) {
    const r = await getJson(roundAttemptsUrl(round.round_key));
    if (!alive.current || r.status !== 200) return;
    const map = parseRoundAttempts(r.body);
    setResults((prev) => ({ ...prev, ...Object.fromEntries(map) }));
    if (!resume) return;
    const now = timers.now();
    setItems((prev) => {
      let next: Record<string, Item> | null = null;
      for (const [k, it] of Object.entries(prev)) {
        const key = attemptKeyOf(it);
        if (it.earlier && it.savedAt === null && key && map.get(key)?.grading_status === "pending") (next ??= { ...prev })[k] = { ...it, savedAt: now };
      }
      return next ?? prev;
    });
  }

  /**
   * A Wrong / Unclear flag the server confirmed voided answers: Unclear those to its question, Wrong those to every
   * question of its idea. They leave the summary's XP and "moved up" at once; the round's attempts are then read
   * back (the voided answers read invalidated, and a chapter recall answer no longer lists an idea flagged Wrong).
   */
  function voidAnswers(f: HeldFlag) {
    const all = Object.values(itemsRef.current);
    const ideaId = f.kind === "wrong" ? all.find((x) => x.question?.question_id === f.question_id)?.card.idea?.idea_id ?? null : null;
    const keys = all
      .filter((x) => x.stored && x.card.kind !== "highlight" && (x.question?.question_id === f.question_id || (ideaId !== null && x.card.idea?.idea_id === ideaId)))
      .map((x) => x.key);
    if (keys.length) setVoidedKeys((prev) => new Set([...prev, ...keys]));
    void refreshResults();
  }

  const hidden = useMemo(() => new Set(flags.filter((f) => f.status !== "refused").flatMap((f) => f.cardKeys)), [flags]);
  const visible = order.filter((k) => items[k] && items[k].phase !== "out" && !hidden.has(k));
  const curKey =
    currentKey && visible.includes(currentKey) && !isDone(items[currentKey])
      ? currentKey
      : visible.find((k) => isWaiting(items[k])) ?? null;
  const cur = curKey ? items[curKey] : null;
  const showSummary = cur === null;
  // An answered card opened again from the summary.
  const viewed = showSummary && viewKey && items[viewKey]?.stored && !gated.has(items[viewKey].card.key) ? items[viewKey] : null;
  const active = cur ?? viewed;
  const vOf = (it: Item) => verdictOf(it, results, voidedKeys);
  const gOf = (it: Item) => isGrading(it, results, voidedKeys);

  // The card on screen changed: its own menu and disclosure state; the time it was shown (response time).
  useEffect(() => {
    if (curKey !== currentKey) setCurrentKey(curKey);
    setMenuOpen(false);
    setSourcesOpen(false);
    setConfirmLeave(false);
    if (curKey && items[curKey]?.shownAt === null) patch(curKey, { shownAt: timers.now() });
    if (!curKey) finished.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey]);

  // A resumed round: read the answers stored earlier today once, so their grades, feedback and Disagree show (and
  // a model grade still pending is polled for).
  useEffect(() => {
    if (Object.values(itemsRef.current).some((it) => it.earlier && it.card.kind !== "highlight" && attemptKeyOf(it))) void refreshResults(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus: one target per action, set once and cleared.
  useEffect(() => {
    if (!focus) return;
    const target =
      focus === "prompt"
        ? promptRef.current ?? summaryRef.current
        : focus === "next"
          ? nextRef.current
          : focus === "retry"
            ? retryRef.current ?? nextRef.current
            : focus === "summary"
              ? summaryRef.current
              : focus === "menu"
                ? menuRef.current
                : focus === "note"
                  ? noteRef.current
                  : inputRef.current;
    target?.focus?.();
    setFocus((f) => (f === focus ? null : f));
  }, [focus, curKey]);

  // A verdict on screen for the first time: announce it once; an incorrect stored answer brings the idea back once
  // (at the end of the round while it is still going; offered on the summary when the grade came after it ended).
  const gradedSig = order
    .map((k) => items[k])
    .filter((it): it is Item => !!it)
    .map((it) => `${it.key}:${vOf(it) ?? "-"}:${it.stored ? 1 : 0}`)
    .join("|");
  useEffect(() => {
    const add: Item[] = [];
    for (const k of order) {
      const it = items[k];
      if (!it) continue;
      const v = vOf(it);
      if (!v) continue;
      if (!announced.current.has(it.key)) {
        announced.current.add(it.key);
        if (it.key === curKey || it.key === viewKey) setAnnounce(`${VERDICT_VIEW[v].word}.`);
      }
      if (!isQuiz && it.stored && !it.earlier && !it.again && (v === "incorrect" || v === "dont_know") && it.card.kind === "idea" && it.card.again_question && !againDone.current.has(it.key) && !gatedRef.current.has(it.card.key)) {
        againDone.current.add(it.key);
        if (it.card.again_question.question_id !== it.question?.question_id) add.push(newItem(it.card, it.card.again_question, true));
      }
    }
    if (add.length) {
      if (curKey === null) {
        setAgainOffer((prev) => [...prev, ...add.filter((a) => !prev.some((p) => p.key === a.key))]);
      } else {
        setItems((prev) => ({ ...prev, ...Object.fromEntries(add.map((a) => [a.key, a])) }));
        setOrder((prev) => [...prev, ...add.map((a) => a.key).filter((k) => !prev.includes(k))]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradedSig]);

  // Poll the round's attempts while a model grade is pending (every 2 s, up to a minute after each answer).
  const waitingSig = order
    .map((k) => items[k])
    .filter((it): it is Item => !!it && gOf(it) && it.savedAt !== null)
    .map((it) => `${it.key}@${it.savedAt}`)
    .join("|");
  useEffect(() => {
    if (!waitingSig) return;
    const waiting = Object.values(itemsRef.current).filter((it) => isGrading(it, resultsRef.current, voidedRef.current) && it.savedAt !== null);
    const now = timers.now();
    if (!waiting.some((it) => now - (it.savedAt as number) < POLL_FOR_MS + 2 * POLL_EVERY_MS)) return;
    const id = timers.set(() => {
      void (async () => {
        const r = await getJson(roundAttemptsUrl(round.round_key));
        if (!alive.current) return;
        if (r.status === 200) {
          const map = parseRoundAttempts(r.body);
          setResults((prev) => ({ ...prev, ...Object.fromEntries(map) }));
        }
        setPollTick((t) => t + 1);
      })();
    }, POLL_EVERY_MS);
    return () => timers.clear(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSig, pollTick]);

  // Phone or desktop, live: rotating a phone past 767 px moves the runner in place (and back), its typed answer kept.
  useEffect(() => {
    const mq = phoneQuery();
    if (!mq) return;
    const update = () => setPhone(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
    else mq.addListener?.(update);
    return () => {
      if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
      else mq.removeListener?.(update);
    };
  }, []);

  // Phone: the sheet follows the visual viewport, so the bottom bar stays above the keyboard; the page behind it
  // does not scroll. Undone when the runner closes or the phone turns wide enough for the in-place card.
  useEffect(() => {
    if (!phone || typeof window === "undefined" || typeof document === "undefined" || !document.documentElement || !document.body) {
      setSheet(null);
      return;
    }
    const vv = window.visualViewport;
    const html = document.documentElement;
    const body = document.body;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    const restore = () => {
      html.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
    if (!vv) return restore;
    const update = () => setSheet({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      restore();
    };
  }, [phone]);

  /**
   * Send what is not settled: held flags (and unconfirmed ones) go out now, and unconfirmed answers are re-sent (the
   * same request, so a stored one answers its receipt). With `keepalive` (the page is going away) every answer not
   * confirmed is re-sent, including one on its way, whose fetch may die with the page (a flag on its way too);
   * otherwise only those no request is carrying. Returns the work started plus the requests already on their way.
   */
  function sendPending(keepalive: boolean): Promise<unknown>[] {
    const work: Promise<unknown>[] = [...inflight.current];
    if (queue.list().some((f) => f.status === "held" || f.status === "unknown" || (keepalive && f.status === "sending"))) work.push(queue.flush(keepalive));
    for (const [key, req] of outbox) if (keepalive || !inflightKeys.current.has(key)) work.push(resendAttempt(outbox, req, keepalive));
    return work;
  }

  /**
   * Leaving the runner (Done, ×, Esc, One more round): send what is pending and say when it has settled (at most
   * SETTLE_MAX_MS), so the part re-reads the round after the answers and flags landed. undefined = nothing pending.
   */
  function leave(): Promise<void> | undefined {
    if (drained.current) return undefined;
    drained.current = true;
    const work = sendPending(false);
    if (!work.length) return undefined;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      void Promise.allSettled(work).then(finish);
      timers.set(finish, SETTLE_MAX_MS);
    });
  }

  // The page hides (tab switch, app closed): send held flags and re-send unconfirmed answers with keepalive. The
  // runner going away without a close (the page navigating) does the same.
  useEffect(() => {
    const flushAll = () => {
      void sendPending(true);
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") flushAll();
    };
    const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
    const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";
    if (hasWindow) window.addEventListener("pagehide", flushAll);
    if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
    alive.current = true;
    return () => {
      if (hasWindow) window.removeEventListener("pagehide", flushAll);
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
      alive.current = false;
      if (!drained.current) {
        drained.current = true;
        flushAll();
      }
      queue.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------- actions ---------------------------- */

  const close = () => onClose(changed.current, finished.current, leave());
  // × and Esc: with a typed answer not checked yet, ask first (the answer is in memory only).
  const requestClose = () => {
    if (cur && typedUnsent(cur)) setConfirmLeave(true);
    else close();
  };
  const more = () => onMore?.(leave());

  function answerOf(it: Item): string | null {
    const q = it.question;
    if (!q) return null;
    const rub = parseRubric(q.rubric);
    if (q.format === "order") {
      const steps = rub?.format === "order" ? rub.steps : [];
      return steps.length && it.order.length === steps.length ? orderAnswerText(it.order.map((i) => steps[i])) : null;
    }
    if (q.format === "cued" && it.hinted) {
      const opts = rub?.format === "cued" ? rub.options ?? [] : [];
      return it.choice !== null && opts[it.choice] ? opts[it.choice] : null;
    }
    return it.answer.trim() ? it.answer : null;
  }

  async function send(key: string, req: AttemptRequest) {
    // A request still in the outbox was sent before without a confirmed answer, so it may be stored already: a
    // refusal of this retry that proves nothing (session, origin, size, rate limit) must not free its key.
    const retried = outbox.has(req.attempt_key);
    busy.current = true;
    outbox.set(req.attempt_key, req);
    inflightKeys.current.add(req.attempt_key);
    const { status, body } = await track(postJson(ATTEMPT_URL, req));
    inflightKeys.current.delete(req.attempt_key);
    busy.current = false;
    const out = classifyAttemptAnswer(status, body, retried);
    // The held request follows its answer whether or not this runner is still on screen: a conclusive answer
    // (stored, refused, left out) releases it, an unknown one stays for the reopened round to retry under the same key.
    if (out.kind !== "unknown") outbox.delete(req.attempt_key);
    if (!alive.current) return;
    if (out.kind === "saved") {
      changed.current = true;
      const receipt = out.receipt;
      patch(key, (it) => ({
        // An answer that lands after a "Not read yet" hold on its chapter is stored but never shown again.
        phase: gatedRef.current.has(it.card.key) ? "past" : "saved",
        stored: true,
        receipt,
        savedAt: timers.now(),
        message: null,
        // The server's verdict wins; a pending receipt means the model grades it.
        local: receipt ? (receipt.grading_status === "graded" ? receipt.verdict : null) : it.local,
      }));
      // A chapter recall answer graded on the spot (an "I don't know") has no pending grade to poll for, yet its
      // Covered / Missed lists (what the missed ideas say, and where they come from) come from the round's attempts.
      if (itemsRef.current[key]?.card.kind === "chapter_recall" && (!receipt || receipt.grading_status === "graded")) void refreshResults();
      return;
    }
    // A card a "Not read yet" put behind the gate while its answer was on its way stays off screen: the request
    // goes on (the outbox re-sends an unconfirmed one when the runner closes), and nothing of the card comes back.
    const gatedNow = gatedRef.current.has(itemsRef.current[key]?.card.key ?? "");
    if (out.kind === "unknown") {
      if (gatedNow) return;
      patch(key, { phase: "unknown", message: out.message });
      setFocus("retry");
      return;
    }
    if (gatedNow) return;
    if (out.kind === "refused") {
      patch(key, { phase: "refused", message: out.message, req: null, local: null });
      setFocus("input");
      return;
    }
    patch(key, { phase: "stale", message: out.message, local: null });
    setFocus("next");
  }

  function check(key: string, dontKnow = false) {
    const it = itemsRef.current[key];
    if (!it || !answerable(it) || busy.current || !it.question || it.card.kind === "highlight") return;
    const q = it.question;
    const answer = dontKnow ? DONT_KNOW_ANSWER : answerOf(it);
    if (!answer || answer.length > ANSWER_MAX_CHARS) return;
    const hinted = !dontKnow && it.hinted;
    const g = gradeLocal(q.format, q.rubric, answer, hinted);
    const shown = it.shownAt ?? timers.now();
    const req: AttemptRequest = {
      attempt_key: newOpKey(),
      question_id: q.question_id,
      version: q.version,
      round_key: round.round_key,
      round_date: round.today,
      round_kind: isQuiz ? "checkpoint" : round.kind,
      answer,
      hinted,
      response_ms: Math.max(0, Math.min(3_600_000, Math.round(timers.now() - shown))),
      // Only a checkpoint answer carries the quiz key (the route refuses one without the other).
      ...(isQuiz && checkpoint ? { quiz_key: checkpoint.quizKey } : {}),
    };
    patch(key, { phase: "saving", req, local: g.kind === "graded" ? g.verdict : null, message: null });
    setFocus("next");
    void send(key, req);
  }

  function retry(key: string) {
    const it = itemsRef.current[key];
    if (!it || it.phase !== "unknown" || busy.current) return;
    if (it.card.kind === "highlight") {
      if (it.review) void gradeHighlight(key, it.review.grade);
      return;
    }
    if (!it.req) return;
    patch(key, { phase: "saving", message: null });
    setFocus("next");
    void send(key, it.req);
  }

  async function gradeHighlight(key: string, g: PracticeGrade) {
    const it = itemsRef.current[key];
    const h = it?.card.highlight;
    if (!it || !h || busy.current || !(answerable(it) || it.phase === "unknown")) return;
    const attempt = attemptFor(it.review, { highlight_id: h.highlight_id, review_count: h.review_count }, g);
    // This tap reuses the key of a try whose answer never came: a refusal of it settles nothing about that try.
    const retried = it.review !== null && it.review.op_key === attempt.op_key;
    patch(key, { phase: "saving", review: attempt, message: null });
    setFocus("next");
    busy.current = true;
    const { status, body } = await track(postJson(REVIEW_URL, attempt));
    busy.current = false;
    if (!alive.current) return;
    const out = classifyReviewAnswer(status, body, retried);
    const b = (body ?? {}) as { interval_days?: unknown; next_review?: unknown };
    if (out.kind === "saved") {
      changed.current = true;
      patch(key, {
        phase: "saved",
        stored: true,
        savedAt: timers.now(),
        reviewXp: out.xp,
        reviewDays: typeof b.interval_days === "number" ? b.interval_days : it.card.review_preview?.[g]?.interval_days ?? null,
        reviewNext: typeof b.next_review === "string" ? b.next_review : it.card.review_preview?.[g]?.next_review ?? null,
      });
      return;
    }
    if (out.kind === "unknown") {
      patch(key, { phase: "unknown", message: out.message });
      setFocus("retry");
      return;
    }
    if (out.kind === "refused") {
      patch(key, { phase: "refused", review: null, message: out.message });
      setFocus("note");
      return;
    }
    patch(key, { phase: "stale", review: null, message: out.message });
  }

  function next() {
    const it = cur;
    if (!it || !canNext(it)) return;
    patch(it.key, { phase: "past" });
    const nextKey = visible.find((k) => k !== it.key && isWaiting(items[k])) ?? null;
    setCurrentKey(nextKey);
    setAnnounce("");
    setFocus(nextKey ? "prompt" : "summary");
  }

  function skip() {
    const it = cur;
    // A quiz has no Skip: every question is answered once (I don't know is an answer).
    if (!it || !answerable(it) || isQuiz) return;
    setMenuOpen(false);
    if (it.skips >= 1) {
      patch(it.key, { phase: "out" });
    } else {
      patch(it.key, { skips: 1 });
      setOrder((prev) => [...prev.filter((k) => k !== it.key), it.key]);
    }
    const others = visible.filter((k) => k !== it.key && isWaiting(items[k]));
    const nextKey = others[0] ?? (it.skips >= 1 ? null : it.key);
    setCurrentKey(nextKey);
    setFocus(nextKey ? "prompt" : "summary");
  }

  /** A flag on the card on screen, or on an answered card opened from the summary (then back to the summary). */
  function flag(kind: FlagKind) {
    const it = active;
    const q = it?.question;
    if (!it || !q || it.phase === "saving" || it.phase === "unknown" || hidden.has(it.key)) return;
    setMenuOpen(false);
    const ideaId = it.card.idea?.idea_id ?? null;
    const keys = visible.filter((k) => {
      const x = items[k];
      if (k === it.key) return true;
      if (isDone(x) || x.stored) return false;
      // Not read yet holds this chapter and every later one (the gate drops below it); highlight reviews are not gated.
      if (kind === "not_read_yet") return x.card.kind !== "highlight" && x.card.chapter !== null && it.card.chapter !== null && x.card.chapter >= it.card.chapter;
      // Wrong retires the idea with every question; Unclear and Not in this chapter take its other variant too.
      return ideaId !== null && x.card.idea?.idea_id === ideaId;
    });
    queue.add({ flag_key: newOpKey(), question_id: q.question_id, kind, cardKeys: keys });
    if (!cur) {
      setViewKey(null);
      setFocus("summary");
      return;
    }
    const nextKey = visible.find((k) => !keys.includes(k) && isWaiting(items[k])) ?? null;
    setCurrentKey(nextKey);
    setFocus(nextKey ? "prompt" : "summary");
  }

  function undoFlag(flagKey: string) {
    const f = flags.find((x) => x.flag_key === flagKey);
    if (!queue.undo(flagKey) || !f) return;
    // The flagged card comes back on screen, where it was.
    const back = f.cardKeys.find((k) => items[k] && answerable(items[k]));
    if (back) {
      setViewKey(null);
      setCurrentKey(back);
      setFocus("prompt");
    }
  }

  /** Open an answered card from the summary: its result, feedback, Disagree, Grade it yourself and flags. */
  function openAnswered(key: string) {
    setViewKey(key);
    setMenuOpen(false);
    setSourcesOpen(false);
    setFocus("prompt");
  }
  function backToSummary() {
    setViewKey(null);
    setMenuOpen(false);
    setFocus("summary");
  }

  /** The "Again" repeats offered on the summary: they join the round now, at its end. */
  function takeAgain(list: Item[]) {
    if (!list.length) return;
    setItems((prev) => ({ ...prev, ...Object.fromEntries(list.map((a) => [a.key, a])) }));
    setOrder((prev) => [...prev, ...list.map((a) => a.key).filter((k) => !prev.includes(k))]);
    setAgainOffer([]);
    setViewKey(null);
    setCurrentKey(list[0].key);
    setFocus("prompt");
  }

  async function changeGrade(key: string, mode: "override" | "self", verdict: ModelVerdict) {
    const it = itemsRef.current[key];
    const k = it ? attemptKeyOf(it) : null;
    if (!it || !k || busy.current || it.change?.status === "saved" || it.change?.status === "saving") return;
    // An earlier try of this change whose outcome is not known may be stored: a refusal that names no reason is not proof.
    const retried = it.change?.status === "unknown";
    patch(key, { change: { mode, verdict, status: "saving" } });
    busy.current = true;
    const r = await track(postJson(overrideUrl(k), mode === "override" ? { verdict } : { self_grade: verdict }));
    busy.current = false;
    if (!alive.current) return;
    const out = classifyOverrideAnswer(r.status, r.body, retried);
    if (out.kind === "saved") {
      changed.current = true;
      // The committed grade and schedule: "Next: ..." and the summary's next due read this receipt from now on.
      patch(key, { change: { mode, verdict, status: "saved" }, receipt: out.value });
      // The poll stops once the grade is saved, so read the round's attempts once more: a chapter recall answer's
      // covered ideas take the new grade, and the Covered / Missed lists can show.
      void refreshResults();
      return;
    }
    patch(key, { change: { mode, verdict, status: out.kind, message: out.message } });
  }

  /**
   * Done on a checkpoint quiz: record the result once, from the database's own count of the quiz's valid answers. The
   * count is read when Done is tapped (and only the first time: the request is then kept, so Retry after a lost answer
   * sends the SAME one, op_key = quiz_key, and a stored result answers its own receipt, never a second row). Nothing is
   * sent unless the quiz holds exactly its full number of answers and none is waiting for its grade.
   */
  async function recordQuiz() {
    if (!isQuiz || !checkpoint || rec.status === "checking" || rec.status === "saving" || rec.status === "saved") return;
    const size = checkpoint.size ?? CHECKPOINT_SIZE;
    let req = quizReq.current;
    let tally = rec.tally;
    if (!req) {
      setRec({ status: "checking", tally });
      const read = onTallyRef.current ? await track(onTallyRef.current().catch(() => null)) : knownTally.current;
      if (!alive.current) return;
      if (!read) {
        setRec({ status: "unread", message: "Couldn't check the quiz's answers. Try again." });
        return;
      }
      tally = read;
      const d = decideRecord(read, size);
      if (d.kind === "grading") {
        setRec({ status: "waiting", tally: read, message: `${d.pending} ${d.pending === 1 ? "answer is" : "answers are"} still being graded. Tap Done again in a moment.` });
        return;
      }
      if (d.kind === "short") {
        setRec({ status: "short", tally: read, message: `${d.total} of ${d.size} answers count: a question you flagged was taken out. Close, then open the checkpoint again for replacements.` });
        return;
      }
      if (d.kind === "over") {
        setRec({ status: "refused", tally: read, message: `The quiz holds ${d.total} answers, more than its ${d.size}. It cannot be recorded.` });
        return;
      }
      req = quizRequest(checkpoint.slug, checkpoint.key, checkpoint.quizKey, d.score, d.total);
      quizReq.current = req;
    }
    setRec({ status: "saving", tally });
    const r = await track(postJson(QUIZ_URL, req));
    if (!alive.current) return;
    const out = classifyQuizAnswer(r.status, r.body);
    if (out.kind === "saved") {
      changed.current = true;
      setRec({ status: "saved", passed: out.passed, xp: out.xp, tally });
      onRecordedRef.current?.({ score: req.score, total: req.total, passed: out.passed, xp: out.xp });
      setFocus("summary");
      return;
    }
    // A refusal stored nothing: the next Done reads the count again and builds a new request.
    if (out.kind === "refused") quizReq.current = null;
    setRec({ status: out.kind, message: out.message, tally });
  }

  /* ---------------------------- keys ---------------------------- */

  // Keys go to the runner only from inside it (or with nothing focused): never an event another widget already
  // handled (the command palette, a G go-shortcut, an open hint), and Esc only with focus inside the runner, so
  // closing a popover elsewhere never closes the round and drops a typed answer.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName ?? "";
    const root = rootRef.current;
    const inside = !!(root && t && typeof root.contains === "function" && root.contains(t));
    const free = !t || tag === "BODY" || tag === "HTML";
    if (!inside && !free) return;
    const typing = tag === "TEXTAREA" || tag === "INPUT" || t?.isContentEditable === true;
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Escape") {
      if (!inside) return;
      // An Esc that cancels an input method's composition (a dictation or an IME) is the keyboard's, not ours.
      if (e.isComposing === true || e.keyCode === 229) return;
      e.preventDefault?.();
      if (menuOpen) {
        setMenuOpen(false);
        setFocus("menu");
      } else if (viewed) backToSummary();
      else if (confirmLeave) setConfirmLeave(false);
      else requestClose();
      return;
    }
    if (!cur) return;
    const rub = cur.question ? parseRubric(cur.question.rubric) : null;
    const choices = cur.hinted && rub?.format === "cued" ? rub.options ?? [] : [];
    if (answerable(cur) && !typing && !mods && /^[1-4]$/.test(e.key) && choices.length && cur.question) {
      // The key is the option's place on screen (the options are offered shuffled).
      const shownOrder = choiceOrder(choices.length, `${cur.question.question_id}|${round.today}`);
      const i = shownOrder[Number(e.key) - 1];
      if (i !== undefined) {
        e.preventDefault?.();
        patch(cur.key, { choice: i });
      }
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (answerable(cur) && answerOf(cur)) {
        e.preventDefault?.();
        check(cur.key);
      }
      return;
    }
    if (e.key === "Enter" && !mods && !typing && tag !== "BUTTON" && tag !== "A" && tag !== "SUMMARY") {
      if (answerable(cur) && choices.length && cur.choice !== null) {
        e.preventDefault?.();
        check(cur.key);
      }
      return;
    }
    if ((e.key === "n" || e.key === "N") && !typing && !mods && canNext(cur)) {
      e.preventDefault?.();
      next();
    }
  };
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ---------------------------- render ---------------------------- */

  const summaryItems: SummaryItem[] = order
    .map((k) => items[k])
    .filter((it): it is Item => !!it && (it.stored || (!hidden.has(it.key) && !it.again && !gated.has(it.card.key))))
    .map((it) => {
      const v = vOf(it);
      // A voided answer earns no XP and moves no idea up (acceptance 9); it still counts as answered.
      const counts = !isQuiz && !isVoided(it, results, voidedKeys) && it.stored && !it.earlier && !it.again && it.card.kind === "idea" && (it.card.preview?.counts ?? false);
      return {
        roundCard: !it.again,
        answered: it.stored,
        counts,
        verdict: v,
        grading: gOf(it),
        stageBefore: it.card.idea?.stage ?? null,
        stageAfter: counts && v ? it.card.preview?.next[v]?.stage ?? null : null,
        nextReview: it.receipt?.next_review ?? it.reviewNext ?? null,
        reviewXp: it.reviewXp,
      };
    });
  const summary = summarize(summaryItems, round.today);
  // Checkpoint mode: what the result is made of. An answer counts while the server still counts it (a Wrong / Unclear
  // flag voids one; a "Not read yet" hold does not), the score is the ones graded right, and Done waits until every
  // answer is saved and graded (an answer on its way, a model grade, a Disagree being saved, a grade not read yet).
  const quizItems = isQuiz ? order.map((k) => items[k]).filter((it): it is Item => !!it && it.stored && it.card.kind === "idea" && !isVoided(it, results, voidedKeys)) : [];
  const quizVerdicts = quizItems.map((it) => vOf(it));
  const quizScore = quizVerdicts.filter((v) => v === "correct").length;
  const quizTotal = quizItems.length;
  const quizUnread = quizItems.filter((it, i) => quizVerdicts[i] === null && !gOf(it)).length;
  const quizUnsent = Object.values(items).some((it) => it.phase === "saving" || it.phase === "unknown" || it.change?.status === "saving");
  // A flag still held (its Undo window), on its way or unconfirmed: a sent Wrong / Unclear flag voids answers, so the
  // count the result is built from is not settled until it has landed.
  const quizFlagsOpen = flags.some((f) => f.status === "held" || f.status === "sending" || f.status === "unknown");
  const quizWaiting = summary.stillGrading > 0 || quizUnread > 0 || quizUnsent || quizFlagsOpen;
  const quizSize = checkpoint?.size ?? CHECKPOINT_SIZE;
  // The numbers on screen: the database's count once Done read it, else what this sitting knows (complete = full size).
  const shownScore = rec.tally ? rec.tally.right : quizScore;
  const shownTotal = rec.tally ? rec.tally.total : quizTotal;
  const quizComplete = shownTotal >= quizSize;
  const quizPct = shownTotal > 0 ? Math.round((100 * shownScore) / shownTotal) : 0;
  knownTally.current = { total: quizTotal, right: quizScore, pending: quizUnread + summary.stillGrading };
  const recallItem = order.map((k) => items[k]).find((it) => it?.card.kind === "chapter_recall" && it.stored && !gated.has(it.card.key) && !isVoided(it, results, voidedKeys));
  const recallResult = recallItem ? results[attemptKeyOf(recallItem) ?? ""] : undefined;
  const recallSplit = coveredSplit(recallResult?.covered_ideas);
  const pos = curKey ? visible.indexOf(curKey) + 1 : visible.length;
  // The answered cards of this sitting and of earlier today, each openable from the summary.
  // (A card a "Not read yet" put behind the gate is left out: its prompt and sources are locked now.)
  const answeredList = order.map((k) => items[k]).filter((it): it is Item => !!it && it.stored && it.card.kind !== "highlight" && !!it.question && !gated.has(it.card.key));
  // An "Again" offer whose idea was flagged or gated since is dropped.
  const againShown = againOffer.filter((a) => !voidedKeys.has(a.card.key) && !hidden.has(a.card.key) && !gated.has(a.card.key));

  const cardProps = (it: Item): CardViewProps => ({
    it,
    today: round.today,
    pollOver: it.savedAt !== null && gOf(it) && timers.now() - it.savedAt > POLL_FOR_MS,
    results,
    voided: voidedKeys,
    sourcesOpen,
    setSourcesOpen,
    refs: { promptRef, retryRef, inputRef, noteRef },
    onAnswer: (v) => patch(it.key, { answer: v }),
    onChoice: (i) => patch(it.key, { choice: i }),
    onOrder: (o) => patch(it.key, { order: o }),
    onRetry: () => retry(it.key),
    onReveal: () => {
      patch(it.key, { revealed: true });
      setFocus("note");
    },
    onGradeHighlight: (g) => void gradeHighlight(it.key, g),
    onChange: (m, v) => void changeGrade(it.key, m, v),
  });

  const view = (
    <div
      ref={rootRef}
      data-testid="practice-runner"
      data-layout={phone ? "sheet" : "inline"}
      role="region"
      aria-label="Practice round"
      className={phone ? PHONE_SHEET_CLASS : DESKTOP_SHEET_CLASS}
      style={phone && sheet ? { top: sheet.top, height: sheet.height, bottom: "auto" } : undefined}
    >
      {/* Top bar */}
      <div className={`flex shrink-0 items-center gap-3 py-1 ${phone ? "border-b border-border-subtle px-4" : ""}`}>
        <span className="font-mono text-[13px] text-text-secondary">{showSummary ? `${summary.answered} / ${summary.total}` : `${pos} / ${visible.length}`}</span>
        <span aria-hidden="true" className="flex flex-wrap gap-1">
          {visible.map((k) => (
            <span key={k} className={`h-1.5 w-1.5 rounded-full ${k === curKey ? "bg-accent" : items[k].stored || isDone(items[k]) ? "bg-accent/40" : "bg-white/15"}`} />
          ))}
        </span>
        <button
          type="button"
          aria-label="Close practice"
          onClick={requestClose}
          className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-secondary hover:text-text-primary"
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      <div className={phone ? "flex-1 overflow-y-auto px-4 py-3" : "py-3"}>
        {cur ? (
          <CardView {...cardProps(cur)} />
        ) : viewed ? (
          <CardView {...cardProps(viewed)} />
        ) : (
          <section data-testid="practice-summary" className="space-y-3">
            <h2 ref={summaryRef} tabIndex={-1} className="text-[17px] font-medium text-text-primary outline-none">
              {isQuiz && checkpoint ? `Checkpoint · ch ${checkpoint.chapter}` : "Round done"}
            </h2>
            {isQuiz ? (
              <div className="space-y-1.5">
                <p data-testid="quiz-score" className="font-mono text-[15px] text-text-primary">
                  {quizComplete ? `${shownScore} of ${shownTotal} · ${quizPct}%` : `${shownTotal} of ${quizSize} answered`}
                </p>
                {quizUnsent ? (
                  <p role="status" className="text-[14px] text-text-secondary">
                    Saving answers
                  </p>
                ) : quizFlagsOpen ? (
                  <p role="status" className="text-[14px] text-text-secondary">
                    Saving your flags
                  </p>
                ) : quizUnread > 0 ? (
                  <p role="status" className="flex flex-wrap items-center gap-2 text-[14px] text-text-secondary">
                    <span>Checking answers</span>
                    <button type="button" onClick={() => void refreshResults(true)} className="inline-flex min-h-11 items-center px-1 text-accent">
                      Read grades again
                    </button>
                  </p>
                ) : summary.stillGrading === 0 && quizComplete ? (
                  <p data-testid="quiz-pass" className={`inline-flex items-center gap-1.5 text-[14px] font-medium ${quizPassed(shownScore, shownTotal) ? "text-up" : "text-mid"}`}>
                    {quizPassed(shownScore, shownTotal) ? <Check aria-hidden="true" className="h-4 w-4" /> : <Minus aria-hidden="true" className="h-4 w-4" />}
                    <span>{quizPassed(shownScore, shownTotal) ? "Passed" : "Not yet"}</span>
                    <span className="font-mono text-[12px] font-normal text-text-tertiary">{Math.round(CHECKPOINT_PASS * 100)}% passes</span>
                  </p>
                ) : null}
                {rec.status === "saved" && (
                  <p data-testid="quiz-recorded" className="text-[14px] text-text-secondary">
                    Recorded · <span className="font-mono">+{rec.xp ?? 0} XP</span>
                  </p>
                )}
              </div>
            ) : (
              <p className="font-mono text-[15px] text-text-primary">
                {summary.answered} of {summary.total} · +{summary.xp} XP
              </p>
            )}
            {!isQuiz && summary.movedUp > 0 && (
              <p className="text-[14px] text-text-secondary">
                <span className="font-mono">{summary.movedUp}</span> {summary.movedUp === 1 ? "idea" : "ideas"} moved up
              </p>
            )}
            {summary.stillGrading > 0 && (
              <div className="space-y-2">
                <p className="text-[14px] text-text-secondary">
                  <span className="font-mono">{summary.stillGrading}</span> still grading
                </p>
                {order
                  .map((k) => items[k])
                  .filter((it): it is Item => !!it && !gated.has(it.card.key) && gOf(it) && results[attemptKeyOf(it) ?? ""]?.self_gradable === true)
                  .map((it) => (
                    <SelfGrade key={it.key} it={it} onPick={(v) => void changeGrade(it.key, "self", v)} />
                  ))}
              </div>
            )}
            {summary.nextDue && <p className="text-[14px] text-text-secondary">Next due {weekday(summary.nextDue)}</p>}
            {voided > 0 && (
              <p className="text-[14px] text-text-secondary">
                <span className="font-mono">{voided}</span> {voided === 1 ? "answer" : "answers"} voided after your correction
              </p>
            )}
            <CoveredList covered={recallSplit.covered} missed={recallSplit.missed} />
            {answeredList.length > 0 && (
              <ul aria-label="Your answers" className="space-y-1.5">
                {answeredList.map((it) => (
                  <li key={it.key}>
                    <AnsweredRow it={it} verdict={vOf(it)} grading={gOf(it)} voided={isVoided(it, results, voidedKeys)} onOpen={() => openAnswered(it.key)} />
                  </li>
                ))}
              </ul>
            )}
            {isQuiz && (rec.status === "unknown" || rec.status === "refused" || rec.status === "short" || rec.status === "unread") && (
              <AlertLine
                heading={rec.status === "unknown" ? "Not sure it saved:" : rec.status === "short" ? "Not recorded:" : rec.status === "unread" ? "Couldn't check:" : "Not saved:"}
                message={rec.message ?? ""}
              >
                {(rec.status === "unknown" || rec.status === "unread") && (
                  <button type="button" onClick={() => void recordQuiz()} className={SECONDARY}>
                    Retry
                  </button>
                )}
              </AlertLine>
            )}
            {isQuiz && rec.status === "waiting" && (
              <p role="status" className="text-[14px] text-text-secondary">
                {rec.message}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {isQuiz && rec.status === "short" ? (
                <button type="button" onClick={close} className={PRIMARY}>
                  Close
                </button>
              ) : isQuiz && rec.status !== "saved" ? (
                <button
                  type="button"
                  aria-disabled={quizWaiting || rec.status === "checking" || rec.status === "saving" || undefined}
                  onClick={() => {
                    if (!quizWaiting && rec.status !== "checking" && rec.status !== "saving") void recordQuiz();
                  }}
                  className={`${PRIMARY} ${quizWaiting || rec.status === "checking" || rec.status === "saving" ? "opacity-40" : ""}`}
                >
                  Done
                </button>
              ) : (
                <button type="button" onClick={close} className={PRIMARY}>
                  {isQuiz && rec.status === "saved" ? "Close" : "Done"}
                </button>
              )}
              {againShown.length > 0 && (
                <button type="button" onClick={() => takeAgain(againShown)} className={SECONDARY}>
                  {`Try again · ${againShown.length}`}
                </button>
              )}
              {onMore && round.extra_available > 0 && (
                <button type="button" onClick={more} className={SECONDARY}>
                  One more round
                </button>
              )}
            </div>
          </section>
        )}
        <p aria-live="polite" role="status" className="sr-only">
          {announce}
        </p>
        {confirmLeave && cur && typedUnsent(cur) && (
          <div role="alert" data-testid="practice-leave" className="mt-3 flex flex-wrap items-center gap-2 rounded-control border border-border-subtle bg-surface-raised p-3 text-[13px] text-text-primary">
            <span className="flex-1">Leave without checking? What you typed is not saved.</span>
            <button type="button" onClick={() => setConfirmLeave(false)} className={SECONDARY}>
              Keep writing
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmLeave(false);
                close();
              }}
              className={SECONDARY}
            >
              Leave
            </button>
          </div>
        )}
        <FlagBars flags={flags} onUndo={undoFlag} onRetry={(k) => void queue.retry(k)} />
      </div>

      {active && (
        <div className={phone ? "shrink-0 border-t border-border-subtle bg-surface px-4 py-2" : "mt-3"}>
          <div className="flex items-center gap-2">
            {!cur ? (
              <button type="button" onClick={backToSummary} className={SECONDARY}>
                Back to summary
              </button>
            ) : answerable(cur) ? (
              cur.card.kind === "highlight" ? (
                <span className="flex-1" />
              ) : (
                <>
                  <button type="button" disabled={!answerOf(cur) || busy.current || tooLong(cur)} onClick={() => check(cur.key)} className={`${PRIMARY} disabled:opacity-40`}>
                    Check
                  </button>
                  <button type="button" onClick={() => check(cur.key, true)} className={SECONDARY}>
                    I don&apos;t know
                  </button>
                </>
              )
            ) : (
              <button
                ref={nextRef}
                type="button"
                aria-disabled={!canNext(cur) || undefined}
                onClick={() => {
                  if (canNext(cur)) next();
                }}
                className={`${PRIMARY} ${canNext(cur) ? "" : "opacity-40 cursor-not-allowed"}`}
              >
                Next
              </button>
            )}
            {hasMenu(active, !hidden.has(active.key)) && (
              <div className="relative ml-auto">
                <button
                  ref={menuRef}
                  type="button"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border-subtle text-text-secondary"
                >
                  <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
                </button>
                {menuOpen && (
                  <CardMenu
                    it={active}
                    canFlag={!hidden.has(active.key)}
                    onSkip={skip}
                    canSkip={!isQuiz}
                    onShowChoices={() => {
                      setMenuOpen(false);
                      patch(active.key, { hinted: true, choice: null });
                    }}
                    onFlag={flag}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
  // The phone sheet is drawn in document.body (a real element; never in a test's stand-in document).
  const portalTo = phone && typeof document !== "undefined" && document.body?.nodeType === 1 ? document.body : null;
  return portalTo ? createPortal(view, portalTo) : view;
}

/* ------------------------------------------------------------------ */

/** The flags a card offers: all four on an idea, Unclear and Not read yet on a chapter recall, none on a highlight. */
const flagKindsOf = (it: Item): FlagKind[] =>
  it.card.kind === "idea" ? ["wrong", "unclear", "not_in_chapter", "not_read_yet"] : it.card.kind === "chapter_recall" ? ["unclear", "not_read_yet"] : [];

/** Whether the ⋯ menu has anything in it (an answered card already flagged offers nothing). */
const hasMenu = (it: Item, canFlag: boolean) => answerable(it) || (canFlag && it.phase !== "saving" && it.phase !== "unknown" && flagKindsOf(it).length > 0);

function CardMenu({ it, canFlag, onSkip, canSkip, onShowChoices, onFlag }: { it: Item; canFlag: boolean; onSkip: () => void; canSkip: boolean; onShowChoices: () => void; onFlag: (k: FlagKind) => void }) {
  const rub = it.question ? parseRubric(it.question.rubric) : null;
  const canChoices = answerable(it) && it.question?.format === "cued" && !it.hinted && rub?.format === "cued" && (rub.options?.length ?? 0) === 4;
  const busyNow = it.phase === "saving" || it.phase === "unknown";
  const kinds = canFlag ? flagKindsOf(it) : [];
  const item = "flex min-h-11 w-full items-center px-3 text-left text-[14px] text-text-primary hover:bg-white/[0.05]";
  return (
    <div role="menu" aria-label="Card actions" className="absolute bottom-full right-0 z-10 mb-2 w-56 overflow-hidden rounded-control border border-border-default bg-surface-raised py-1 shadow-card">
      {answerable(it) && canSkip && (
        <button type="button" role="menuitem" onClick={onSkip} className={item}>
          Skip for now
        </button>
      )}
      {canChoices && (
        <button type="button" role="menuitem" onClick={onShowChoices} className={item}>
          Show choices
        </button>
      )}
      {!busyNow &&
        kinds.map((k) => (
          <button key={k} type="button" role="menuitem" onClick={() => onFlag(k)} className={item}>
            {FLAG_LABEL[k]}
          </button>
        ))}
    </div>
  );
}

/** One answered card on the summary: its chapter, its prompt and how it went; a tap opens its result again. */
function AnsweredRow({ it, verdict, grading, voided, onOpen }: { it: Item; verdict: Verdict | null; grading: boolean; voided: boolean; onOpen: () => void }) {
  const ch = it.card.chapter;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-3 rounded-control border border-border-subtle bg-white/[0.02] px-3 py-2 text-left text-[13px] text-text-primary hover:bg-white/[0.05]"
    >
      <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{ch != null && ch >= 1 ? `Ch ${ch}` : ch === 0 ? "Book" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{it.question?.prompt}</span>
      <span className="shrink-0 text-[12px]">
        {voided ? (
          <span className="text-text-tertiary">Voided</span>
        ) : verdict ? (
          <VerdictWord verdict={verdict} />
        ) : grading ? (
          <span className="text-text-secondary">Grading</span>
        ) : (
          <span className="text-text-tertiary">Saved</span>
        )}
      </span>
    </button>
  );
}

function FlagBars({ flags, onUndo, onRetry }: { flags: HeldFlag[]; onUndo: (k: string) => void; onRetry: (k: string) => void }) {
  const shown = flags.filter((f) => f.status !== "sent");
  if (!shown.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {shown.map((f) =>
        f.status === "held" || f.status === "sending" ? (
          <div key={f.flag_key} role="status" className="flex min-h-11 items-center gap-3 rounded-control border border-border-subtle bg-surface-raised px-3 text-[13px] text-text-primary">
            <span className="flex-1">Flagged · {FLAG_LABEL[f.kind]}</span>
            {f.status === "held" && (
              <button type="button" onClick={() => onUndo(f.flag_key)} className="min-h-11 px-2 font-medium text-accent">
                Undo
              </button>
            )}
          </div>
        ) : f.status === "unknown" ? (
          <AlertLine key={f.flag_key} heading="Flag not sure:" message={f.message ?? ""}>
            <button type="button" onClick={() => onRetry(f.flag_key)} className={SECONDARY}>
              Retry flag
            </button>
          </AlertLine>
        ) : (
          <AlertLine key={f.flag_key} heading="Flag not saved:" message={f.message ?? ""} />
        ),
      )}
    </div>
  );
}

function SelfGrade({ it, onPick }: { it: Item; onPick: (v: ModelVerdict) => void }) {
  const c = it.change;
  return (
    <div className="rounded-control border border-border-subtle p-3">
      <p className="text-[13px] text-text-secondary">{it.question?.prompt}</p>
      {c?.status === "saved" ? (
        <p className="mt-2 text-[13px]">
          <VerdictWord verdict={c.verdict} />
        </p>
      ) : (
        <div className="mt-2" role="group" aria-label="Grade it yourself">
          <p className="mb-1 text-[12px] text-text-tertiary">Grade it yourself</p>
          <div className="flex flex-wrap gap-2">
            {SELF_VERDICTS.map((s) => (
              <button
                key={s.verdict}
                type="button"
                aria-disabled={c?.status === "saving" || undefined}
                onClick={() => {
                  if (c?.status !== "saving") onPick(s.verdict);
                }}
                className={SECONDARY}
              >
                {s.label}
              </button>
            ))}
          </div>
          {(c?.status === "unknown" || c?.status === "refused") && <AlertLine heading={c.status === "unknown" ? "Not sure it saved:" : "Not saved:"} message={c.message ?? ""} />}
        </div>
      )}
    </div>
  );
}

interface CardViewProps {
  it: Item;
  today: string;
  /** The poll for this card's model grade ran out ("Still grading · shows later"). */
  pollOver: boolean;
  results: Results;
  /** Item keys whose answers a sent Wrong / Unclear flag voided. */
  voided: ReadonlySet<string>;
  sourcesOpen: boolean;
  setSourcesOpen: (open: boolean) => void;
  refs: {
    promptRef: RefObject<HTMLHeadingElement | null>;
    retryRef: RefObject<HTMLButtonElement | null>;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    noteRef: RefObject<HTMLParagraphElement | null>;
  };
  onAnswer: (v: string) => void;
  onChoice: (i: number) => void;
  onOrder: (o: number[]) => void;
  onRetry: () => void;
  onReveal: () => void;
  onGradeHighlight: (g: PracticeGrade) => void;
  onChange: (mode: "override" | "self", v: ModelVerdict) => void;
}

function CardView({ it, today, pollOver, results, voided, sourcesOpen, setSourcesOpen, refs, onAnswer, onChoice, onOrder, onRetry, onReveal, onGradeHighlight, onChange }: CardViewProps) {
  const card = it.card;
  const q = it.question;
  const rub = q ? parseRubric(q.rubric) : null;
  const open = answerable(it);
  const answered = !open;
  const verdict = verdictOf(it, results, voided);
  const result = results[attemptKeyOf(it) ?? ""];
  const grading = isGrading(it, results, voided);
  const isVoid = isVoided(it, results, voided);
  // Stored and settled: on screen after Check, or opened again from the summary ("past").
  const settled = it.phase === "saved" || it.phase === "past";

  if (card.kind === "highlight" && card.highlight) {
    const h = card.highlight;
    const preview = card.review_preview;
    return (
      <article data-testid="practice-card" className="space-y-3">
        <h2 ref={refs.promptRef} tabIndex={-1} className="font-mono text-[12px] text-text-tertiary outline-none">
          Your highlight{h.chapter != null ? ` · Ch ${h.chapter}` : ""}
          {h.page != null ? ` · p. ${h.page}` : ""}
        </h2>
        <blockquote className="border-l-2 border-accent/60 pl-3 text-[17px] leading-relaxed text-text-primary">{h.passage}</blockquote>
        {!it.revealed ? (
          <button type="button" onClick={onReveal} className={SECONDARY}>
            Say what this means, then reveal your note
          </button>
        ) : (
          <>
            <p ref={refs.noteRef} tabIndex={-1} className="text-[14px] italic text-text-secondary outline-none">
              {h.comment || "No note on this one."}
            </p>
            {it.phase === "saved" ? (
              <p className="text-[13px] text-up">Saved{it.reviewDays != null ? ` · next in ${intervalLabel(it.reviewDays)}` : ""}</p>
            ) : (
              <div className="flex gap-2" role="group" aria-label="Grade this highlight">
                {PRACTICE_GRADES.map((g) => {
                  const days = preview?.[g]?.interval_days ?? null;
                  const blocked = it.phase === "saving" || it.phase === "stale";
                  return (
                    <button
                      key={g}
                      type="button"
                      aria-label={days != null ? `${GRADE_LABEL[g]}, next review in ${intervalLabel(days)}` : GRADE_LABEL[g]}
                      aria-disabled={blocked || undefined}
                      onClick={() => {
                        if (!blocked) onGradeHighlight(g);
                      }}
                      className={`flex-1 min-h-12 rounded-control border border-border-default bg-white/[0.02] px-2 py-1.5 text-text-primary ${blocked ? "opacity-40" : ""}`}
                    >
                      <span className="block text-[14px] font-medium leading-none">{GRADE_LABEL[g]}</span>
                      {days != null && <span className="mt-1 block font-mono text-[11px] opacity-80">{intervalLabel(days)}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {it.phase === "saving" && <p className="text-[12px] text-text-secondary">Saving</p>}
            {it.phase === "unknown" && (
              <AlertLine heading="Not sure it saved:" message={it.message ?? ""}>
                <button ref={refs.retryRef} type="button" onClick={onRetry} className={SECONDARY}>
                  Retry
                </button>
              </AlertLine>
            )}
            {(it.phase === "refused" || it.phase === "stale") && it.message && <AlertLine heading="Not saved:" message={it.message} />}
          </>
        )}
      </article>
    );
  }

  if (!q) return null;
  const format = q.format;
  const options = rub?.format === "cued" ? rub.options ?? [] : [];
  const steps = rub?.format === "order" ? rub.steps : [];
  const offered = format === "order" ? offeredOrder(steps, `${q.question_id}|${today}`) : [];
  const choicesShown = format === "cued" && it.hinted ? choiceOrder(options.length, `${q.question_id}|${today}`) : [];
  const typedLength = open && showsTextBox(it) ? it.answer.length : 0;

  return (
    <article data-testid="practice-card" className="space-y-3">
      <CardChips chapter={card.chapter} format={format} sourceCount={card.source_count} onSources={answered ? () => setSourcesOpen(true) : undefined} />
      <h2 ref={refs.promptRef} tabIndex={-1} className="text-[17px] leading-snug text-text-primary outline-none">
        {q.prompt}
      </h2>

      {/* The answer: typed / dictated, 4 choices (hinted), or steps to order. Read-only once checked. An answer from
          before this sitting is not sent back by the server, so it is not shown again. */}
      {it.earlier ? (
        <p className="text-[13px] text-text-tertiary">Answered earlier today</p>
      ) : format === "order" ? (
        <OrderPicker steps={steps} offered={offered} picked={it.order} onChange={onOrder} disabled={answered} />
      ) : format === "cued" && it.hinted ? (
        <ChoiceList
          options={options}
          order={choicesShown}
          picked={it.choice}
          onPick={onChoice}
          disabled={answered}
          correct={rub?.format === "cued" && typeof rub.correct === "number" ? rub.correct : null}
          answered={answered && it.phase !== "stale"}
        />
      ) : (
        <AnswerBox
          value={it.req && it.req.answer === DONT_KNOW_ANSWER ? DONT_KNOW_ANSWER : it.answer}
          onChange={onAnswer}
          disabled={answered}
          inputRef={refs.inputRef}
          label={format === "chapter_recall" ? "What you remember" : "Your answer"}
        />
      )}

      {typedLength > ANSWER_MAX_CHARS - 400 &&
        (typedLength > ANSWER_MAX_CHARS ? (
          <AlertLine heading="Too long:" message={`${typedLength.toLocaleString("en-US")} characters; ${ANSWER_MAX_CHARS.toLocaleString("en-US")} is the most Onyx takes. Shorten it to check.`} />
        ) : (
          <p className="font-mono text-[12px] text-text-tertiary">
            {typedLength.toLocaleString("en-US")} / {ANSWER_MAX_CHARS.toLocaleString("en-US")}
          </p>
        ))}

      {it.phase === "refused" && it.message && <AlertLine heading="Not saved:" message={it.message} />}

      {answered && (
        <div data-testid="practice-result" className="space-y-3 rounded-control border border-border-subtle bg-white/[0.02] p-3">
          {/* Verdict line: an icon and a word; or "Saved · grading" while the model grades. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
            {isVoid ? (
              <span className="text-text-secondary">Voided after your flag</span>
            ) : verdict ? (
              <VerdictWord verdict={verdict} />
            ) : settled && grading ? (
              <span className="text-text-secondary">{pollOver && !result?.self_gradable ? "Still grading · shows later" : "Saved · grading"}</span>
            ) : it.phase === "saving" ? (
              <span className="text-text-secondary">Saving</span>
            ) : null}
            {it.phase === "saving" && verdict && <span className="text-[12px] text-text-tertiary">Saving</span>}
            {settled && verdict && (
              <span className="font-mono text-[12px] text-text-tertiary">
                {nextLine({ today, verdict, preview: card.preview, receiptNext: it.receipt?.next_review ?? null, again: it.again })}
              </span>
            )}
            {settled && !isVoid && format === "chapter_recall" && card.recall?.next_due_on && (
              <span className="font-mono text-[12px] text-text-tertiary">Next recall {inDays(today, card.recall.next_due_on)}</span>
            )}
          </div>

          {it.phase === "unknown" && (
            <AlertLine heading="Not sure it saved:" message={it.message ?? ""}>
              <button ref={refs.retryRef} type="button" onClick={onRetry} className={SECONDARY}>
                Retry
              </button>
            </AlertLine>
          )}
          {it.phase === "stale" && <AlertLine heading="Left out:" message={it.message ?? ""} />}

          {it.phase !== "stale" && (
            <>
              {/* The reference: the answer, the key points, the order, or the chapter's ideas. */}
              {rub?.format === "cued" && !it.hinted && (
                <p className="text-[14px] text-text-primary">
                  <span className="text-text-tertiary">Answer: </span>
                  {rub.answer}
                </p>
              )}
              {rub?.format === "explain" && <KeyPoints points={rub.points} hits={result?.rubric_hits ?? null} />}
              {rub?.format === "order" && (
                <ol className="list-decimal space-y-0.5 pl-5 text-[14px] text-text-primary">
                  {rub.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {rub?.format === "chapter_recall" && !result?.covered_ideas?.some((c) => c.verdict) && (
                <ul className="space-y-0.5 text-[14px] text-text-primary">
                  {rub.ideas.map((i) => (
                    <li key={i.idea_id}>{i.title}</li>
                  ))}
                </ul>
              )}
              {format === "chapter_recall" && <CoveredList {...coveredSplit(result?.covered_ideas)} />}
              {rub && "explanation" in rub && rub.explanation && <p className="text-[13px] text-text-secondary">{rub.explanation}</p>}
              {result?.feedback && <p className="text-[13px] text-text-secondary">{result.feedback}</p>}

              {grading && result?.self_gradable && <SelfGrade it={it} onPick={(v) => onChange("self", v)} />}

              {/* Disagree: once, on a model grade. */}
              {!isVoid && result?.overridable && it.change?.status !== "saved" && (
                <div role="group" aria-label="Disagree?" className="space-y-1">
                  <p className="text-[12px] text-text-tertiary">Disagree?</p>
                  <div className="flex flex-wrap gap-2">
                    {SELF_VERDICTS.filter((s) => s.verdict !== verdict).map((s) => (
                      <button
                        key={s.verdict}
                        type="button"
                        aria-disabled={it.change?.status === "saving" || undefined}
                        onClick={() => {
                          if (it.change?.status !== "saving") onChange("override", s.verdict);
                        }}
                        className={SECONDARY}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {(it.change?.status === "unknown" || it.change?.status === "refused") && (
                    <AlertLine heading={it.change.status === "unknown" ? "Not sure it saved:" : "Not saved:"} message={it.change.message ?? ""} />
                  )}
                </div>
              )}
              {it.change?.status === "saved" && it.change.mode === "override" && <p className="text-[12px] text-text-tertiary">Changed by you</p>}

              <WhereFrom sources={card.sources} chapter={card.chapter} version={q.version} open={sourcesOpen} onToggle={setSourcesOpen} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
