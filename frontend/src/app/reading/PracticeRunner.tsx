"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, X } from "lucide-react";
import { DONT_KNOW_ANSWER, gradeLocal, orderAnswerText, parseRubric, QUICK_SIZE, type ModelVerdict, type Verdict } from "@/lib/reading-recall";
import { attemptFor, classifyReviewAnswer, GRADE_LABEL, intervalLabel, newOpKey, PRACTICE_GRADES, type PracticeGrade, type ReviewAttempt } from "@/lib/reading-practice";
import {
  ATTEMPT_URL,
  classifyAttemptAnswer,
  classifyFlagAnswer,
  classifyOverrideAnswer,
  coveredSplit,
  createFlagQueue,
  FLAG_LABEL,
  FLAG_URL,
  getJson,
  inDays,
  nextLine,
  offeredOrder,
  overrideUrl,
  parseRoundAttempts,
  POLL_EVERY_MS,
  POLL_FOR_MS,
  postJson,
  realTimers,
  REVIEW_URL,
  roundAttemptsUrl,
  SELF_VERDICTS,
  summarize,
  VERDICT_VIEW,
  weekday,
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
import { AlertLine, AnswerBox, CardChips, ChoiceList, CoveredList, KeyPoints, OrderPicker, VerdictWord, WhereFrom } from "./PracticeCards";

/**
 * The practice runner (READ-QUIZ-01 S4; docs/reading-question-bank.md "Practice"). A round of cards from
 * GET /api/reading/practice/today, answered one at a time.
 *
 * - Phone (< 768 px): a full-screen sheet (fixed, safe-area padding) whose bottom bar stays above the keyboard
 *   (visualViewport). Desktop: the same card in place inside the Practice part, at most 640 px wide.
 * - The answer stays hidden until Check or "I don't know". Code-graded formats show the verdict at once (before the
 *   POST returns; the server re-grades with the same function and its verdict wins); model-graded ones show
 *   "Saved · grading" and the key points, and the verdict arrives from the round's attempts, polled every 2 s while
 *   anything is pending, for up to a minute. The next card never waits for a model grade.
 * - One request at a time; a card stays on failure. "Not sure it saved" offers Retry, which sends the SAME request
 *   (same attempt_key), so a lost answer is answered from its receipt. A refusal stored nothing: the answer can be
 *   changed and checked again. Typed answers live in memory only; unconfirmed requests are re-sent with keepalive
 *   when the page hides. Nothing is written to disk.
 * - Skip for now stores nothing and moves the card to the end (a second Skip takes it out of today's round). An
 *   incorrect answer brings the idea back once at the end with another variant ("Again"; it never moves the
 *   schedule). Flags (Wrong, Unclear, Not in this chapter, Not read yet) are held 8 s with Undo, then sent; a held
 *   flag goes out when the page hides or the runner closes.
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

const attemptKeyOf = (it: Item): string | null => it.req?.attempt_key ?? it.card.attempt_key ?? null;
const isDone = (it: Item) => it.phase === "past" || it.phase === "out";
const answerable = (it: Item) => it.phase === "open" || it.phase === "refused";
const canNext = (it: Item) => it.phase === "saved" || it.phase === "stale";

/** The verdict on screen: a Disagree / self grade, then the server's grade, then the code grade shown at once. */
function verdictOf(it: Item, results: Record<string, AttemptResult>): Verdict | null {
  if (it.card.kind === "highlight") return null;
  if (it.change?.status === "saved") return it.change.verdict;
  const k = attemptKeyOf(it);
  const r = k ? results[k] : undefined;
  if (r?.grading_status === "invalidated") return null;
  if (r?.grading_status === "graded" && r.verdict) return r.verdict;
  if (it.receipt) return it.receipt.grading_status === "graded" ? it.receipt.verdict : null;
  return it.local;
}
function isGrading(it: Item, results: Record<string, AttemptResult>): boolean {
  if (!it.stored || it.card.kind === "highlight" || it.earlier) return false;
  const k = attemptKeyOf(it);
  if (k && results[k]?.grading_status === "invalidated") return false;
  return verdictOf(it, results) === null;
}

const PHONE_QUERY = "(max-width: 767px)";
const SHEET_CLASS =
  "fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] " +
  "md:relative md:inset-auto md:z-auto md:mx-auto md:block md:w-full md:max-w-[640px] md:bg-transparent md:pt-0 md:pb-0";
const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-[15px] font-medium text-on-accent";
const SECONDARY = "inline-flex min-h-11 items-center justify-center rounded-control border border-border-default px-3 text-[14px] text-text-primary";

export interface PracticeRunnerProps {
  round: PracticeRound;
  /** daily: the whole round; quick: its first 3 cards; extra: "One more round". */
  mode: "daily" | "quick" | "extra";
  /** ×, Esc, Done. `changed`: something was stored or flagged; `finished`: the summary was reached. */
  onClose: (changed: boolean, finished: boolean) => void;
  /** "One more round" from the summary (offered when the round says more are left). */
  onMore?: () => void;
  /** Re-read the round (after a "Not read yet" hold); cards it no longer holds leave this sitting. */
  onReread?: () => Promise<PracticeRound | null>;
  /** The clock and timers (tests pass a manual one). */
  timers?: Timers;
}

export default function PracticeRunner({ round, mode, onClose, onMore, onReread, timers = realTimers }: PracticeRunnerProps) {
  const [items, setItems] = useState<Record<string, Item>>(() => {
    const cards = mode === "quick" ? round.cards.slice(0, QUICK_SIZE) : round.cards;
    return Object.fromEntries(cards.map((c) => [c.key, newItem(c)]));
  });
  const [order, setOrder] = useState<string[]>(() => (mode === "quick" ? round.cards.slice(0, QUICK_SIZE) : round.cards).map((c) => c.key));
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AttemptResult>>({});
  const [flags, setFlags] = useState<HeldFlag[]>([]);
  const [voided, setVoided] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [focus, setFocus] = useState<"prompt" | "next" | "retry" | "summary" | "menu" | "input" | "note" | null>("prompt");
  const [pollTick, setPollTick] = useState(0);
  const [sheet, setSheet] = useState<{ top: number; height: number } | null>(null);
  // A phone (< 768 px) gets the full-screen sheet, drawn in document.body: inside the page it would sit in the app
  // shell's own stacking context, under the fixed mobile header and tab bar. Decided once (the runner is client-only).
  const [phone] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const alive = useRef(true);
  const busy = useRef(false);
  const changed = useRef(false);
  const finished = useRef(false);
  const announced = useRef(new Set<string>());
  const againDone = useRef(new Set<string>());
  // Requests sent and not confirmed (in flight, or no answer): re-sent with keepalive when the page hides.
  const outbox = useRef(new Map<string, AttemptRequest>());
  const promptRef = useRef<HTMLHeadingElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const summaryRef = useRef<HTMLHeadingElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const onRereadRef = useRef(onReread);
  onRereadRef.current = onReread;

  const patch = (key: string, p: Partial<Item> | ((it: Item) => Partial<Item>)) =>
    setItems((prev) => {
      const it = prev[key];
      if (!it) return prev;
      return { ...prev, [key]: { ...it, ...(typeof p === "function" ? p(it) : p) } };
    });

  // The flag queue: created once, its state mirrored into `flags` for the screen.
  const queueRef = useRef<FlagQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createFlagQueue({
      timers,
      send: async (f, keepalive) => {
        const r = await postJson(FLAG_URL, { flag_key: f.flag_key, question_id: f.question_id, kind: f.kind }, { keepalive });
        return classifyFlagAnswer(r.status, r.body);
      },
      onChange: (list) => {
        if (alive.current) setFlags(list);
      },
      onSent: (f, r) => {
        changed.current = true;
        if (!alive.current) return;
        if (r.invalidated) setVoided((v) => v + r.invalidated);
        if (f.kind === "not_read_yet") void reconcile();
      },
    });
  }
  const queue = queueRef.current;

  // A "Not read yet" hold lowered the spoiler gate: re-read the round, and the cards it no longer holds leave.
  async function reconcile() {
    const fresh = await onRereadRef.current?.().catch(() => null);
    if (!fresh || !alive.current) return;
    const keep = new Set(fresh.cards.map((c) => c.key));
    setItems((prev) => {
      const next = { ...prev };
      for (const [k, it] of Object.entries(prev)) if (!isDone(it) && !it.stored && !keep.has(it.card.key)) next[k] = { ...it, phase: "out" };
      return next;
    });
  }

  const hidden = useMemo(() => new Set(flags.filter((f) => f.status !== "refused").flatMap((f) => f.cardKeys)), [flags]);
  const visible = order.filter((k) => items[k] && items[k].phase !== "out" && !hidden.has(k));
  const curKey =
    currentKey && visible.includes(currentKey) && !isDone(items[currentKey])
      ? currentKey
      : visible.find((k) => items[k].phase === "open") ?? null;
  const cur = curKey ? items[curKey] : null;
  const showSummary = cur === null;

  // The card on screen changed: its own menu and disclosure state; the time it was shown (response time).
  useEffect(() => {
    if (curKey !== currentKey) setCurrentKey(curKey);
    setMenuOpen(false);
    setSourcesOpen(false);
    if (curKey && items[curKey]?.shownAt === null) patch(curKey, { shownAt: timers.now() });
    if (!curKey) finished.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey]);

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

  // A verdict on screen for the first time: announce it once; an incorrect stored answer brings the idea back once.
  const gradedSig = order
    .map((k) => items[k])
    .filter((it): it is Item => !!it)
    .map((it) => `${it.key}:${verdictOf(it, results) ?? "-"}:${it.stored ? 1 : 0}`)
    .join("|");
  useEffect(() => {
    const add: Item[] = [];
    for (const k of order) {
      const it = items[k];
      if (!it) continue;
      const v = verdictOf(it, results);
      if (!v) continue;
      if (!announced.current.has(it.key)) {
        announced.current.add(it.key);
        if (it.key === curKey) setAnnounce(`${VERDICT_VIEW[v].word}.`);
      }
      if (it.stored && !it.earlier && !it.again && (v === "incorrect" || v === "dont_know") && it.card.kind === "idea" && it.card.again_question && !againDone.current.has(it.key)) {
        againDone.current.add(it.key);
        if (it.card.again_question.question_id !== it.question?.question_id) add.push(newItem(it.card, it.card.again_question, true));
      }
    }
    if (add.length) {
      setItems((prev) => ({ ...prev, ...Object.fromEntries(add.map((a) => [a.key, a])) }));
      setOrder((prev) => [...prev, ...add.map((a) => a.key).filter((k) => !prev.includes(k))]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradedSig]);

  // Poll the round's attempts while a model grade is pending (every 2 s, up to a minute after each answer).
  const waitingSig = order
    .map((k) => items[k])
    .filter((it): it is Item => !!it && isGrading(it, results) && it.savedAt !== null)
    .map((it) => `${it.key}@${it.savedAt}`)
    .join("|");
  useEffect(() => {
    if (!waitingSig) return;
    const waiting = Object.values(itemsRef.current).filter((it) => isGrading(it, resultsRef.current) && it.savedAt !== null);
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

  // Phone: the sheet follows the visual viewport, so the bottom bar stays above the keyboard; the page behind it
  // does not scroll.
  useEffect(() => {
    if (!phone || typeof window === "undefined") return;
    const vv = window.visualViewport;
    const html = document.documentElement;
    const prev = [html.style.overflow, document.body.style.overflow];
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    if (!vv) {
      return () => {
        html.style.overflow = prev[0];
        document.body.style.overflow = prev[1];
      };
    }
    const update = () => setSheet({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      html.style.overflow = prev[0];
      document.body.style.overflow = prev[1];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page hides (tab switch, app closed): send held flags and re-send unconfirmed answers with keepalive.
  // Closing the runner does the same.
  useEffect(() => {
    const flushAll = () => {
      void queue.flush(true);
      for (const req of outbox.current.values()) void postJson(ATTEMPT_URL, req, { keepalive: true });
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
      flushAll();
      queue.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------- actions ---------------------------- */

  const close = () => onClose(changed.current, finished.current);

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
    busy.current = true;
    outbox.current.set(req.attempt_key, req);
    const { status, body } = await postJson(ATTEMPT_URL, req);
    busy.current = false;
    if (!alive.current) return;
    const out = classifyAttemptAnswer(status, body);
    if (out.kind === "saved") {
      outbox.current.delete(req.attempt_key);
      changed.current = true;
      const receipt = out.receipt;
      patch(key, (it) => ({
        phase: "saved",
        stored: true,
        receipt,
        savedAt: timers.now(),
        message: null,
        // The server's verdict wins; a pending receipt means the model grades it.
        local: receipt ? (receipt.grading_status === "graded" ? receipt.verdict : null) : it.local,
      }));
      return;
    }
    if (out.kind === "unknown") {
      patch(key, { phase: "unknown", message: out.message });
      setFocus("retry");
      return;
    }
    outbox.current.delete(req.attempt_key);
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
    if (!answer) return;
    const hinted = !dontKnow && it.hinted;
    const g = gradeLocal(q.format, q.rubric, answer, hinted);
    const shown = it.shownAt ?? timers.now();
    const req: AttemptRequest = {
      attempt_key: newOpKey(),
      question_id: q.question_id,
      version: q.version,
      round_key: round.round_key,
      round_date: round.today,
      round_kind: round.kind,
      answer,
      hinted,
      response_ms: Math.max(0, Math.min(3_600_000, Math.round(timers.now() - shown))),
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
    patch(key, { phase: "saving", review: attempt, message: null });
    setFocus("next");
    busy.current = true;
    const { status, body } = await postJson(REVIEW_URL, attempt);
    busy.current = false;
    if (!alive.current) return;
    const out = classifyReviewAnswer(status, body);
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
    const nextKey = visible.find((k) => k !== it.key && items[k].phase === "open") ?? null;
    setCurrentKey(nextKey);
    setAnnounce("");
    setFocus(nextKey ? "prompt" : "summary");
  }

  function skip() {
    const it = cur;
    if (!it || !answerable(it)) return;
    setMenuOpen(false);
    if (it.skips >= 1) {
      patch(it.key, { phase: "out" });
    } else {
      patch(it.key, { skips: 1 });
      setOrder((prev) => [...prev.filter((k) => k !== it.key), it.key]);
    }
    const others = visible.filter((k) => k !== it.key && items[k].phase === "open");
    const nextKey = others[0] ?? (it.skips >= 1 ? null : it.key);
    setCurrentKey(nextKey);
    setFocus(nextKey ? "prompt" : "summary");
  }

  function flag(kind: FlagKind) {
    const it = cur;
    const q = it?.question;
    if (!it || !q || it.phase === "saving" || it.phase === "unknown") return;
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
    const nextKey = visible.find((k) => !keys.includes(k) && items[k].phase === "open") ?? null;
    setCurrentKey(nextKey);
    setFocus(nextKey ? "prompt" : "summary");
  }

  function undoFlag(flagKey: string) {
    const f = flags.find((x) => x.flag_key === flagKey);
    if (!queue.undo(flagKey) || !f) return;
    // The flagged card comes back on screen, where it was.
    const back = f.cardKeys.find((k) => items[k] && answerable(items[k]));
    if (back) {
      setCurrentKey(back);
      setFocus("prompt");
    }
  }

  async function changeGrade(key: string, mode: "override" | "self", verdict: ModelVerdict) {
    const it = itemsRef.current[key];
    const k = it ? attemptKeyOf(it) : null;
    if (!it || !k || busy.current || it.change?.status === "saved" || it.change?.status === "saving") return;
    patch(key, { change: { mode, verdict, status: "saving" } });
    busy.current = true;
    const r = await postJson(overrideUrl(k), mode === "override" ? { verdict } : { self_grade: verdict });
    busy.current = false;
    if (!alive.current) return;
    const out = classifyOverrideAnswer(r.status, r.body);
    if (out.kind === "saved") changed.current = true;
    patch(key, { change: { mode, verdict, status: out.kind, message: out.kind === "saved" ? undefined : out.message } });
  }

  /* ---------------------------- keys ---------------------------- */

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName ?? "";
    const typing = tag === "TEXTAREA" || tag === "INPUT" || t?.isContentEditable === true;
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Escape") {
      e.preventDefault?.();
      if (menuOpen) {
        setMenuOpen(false);
        setFocus("menu");
      } else close();
      return;
    }
    if (!cur) return;
    const rub = cur.question ? parseRubric(cur.question.rubric) : null;
    const choices = cur.hinted && rub?.format === "cued" ? rub.options ?? [] : [];
    if (answerable(cur) && !typing && !mods && /^[1-4]$/.test(e.key) && choices.length) {
      const i = Number(e.key) - 1;
      if (i < choices.length) {
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
    .filter((it): it is Item => !!it && (it.stored || (!hidden.has(it.key) && !it.again)))
    .map((it) => {
      const v = verdictOf(it, results);
      const counts = it.stored && !it.earlier && !it.again && it.card.kind === "idea" && (it.card.preview?.counts ?? false);
      return {
        roundCard: !it.again,
        answered: it.stored,
        counts,
        verdict: v,
        grading: isGrading(it, results),
        stageBefore: it.card.idea?.stage ?? null,
        stageAfter: counts && v ? it.card.preview?.next[v]?.stage ?? null : null,
        nextReview: it.receipt?.next_review ?? it.reviewNext ?? null,
        reviewXp: it.reviewXp,
      };
    });
  const summary = summarize(summaryItems, round.today);
  const recallItem = order.map((k) => items[k]).find((it) => it?.card.kind === "chapter_recall" && it.stored);
  const recallResult = recallItem ? results[attemptKeyOf(recallItem) ?? ""] : undefined;
  const recallSplit = coveredSplit(recallResult?.covered_ideas);
  const pos = curKey ? visible.indexOf(curKey) + 1 : visible.length;

  const view = (
    <div data-testid="practice-runner" role="region" aria-label="Practice round" className={SHEET_CLASS} style={sheet ? { top: sheet.top, height: sheet.height, bottom: "auto" } : undefined}>
      {/* Top bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-1 md:border-0 md:px-0">
        <span className="font-mono text-[13px] text-text-secondary">{showSummary ? `${summary.answered} / ${summary.total}` : `${pos} / ${visible.length}`}</span>
        <span aria-hidden="true" className="flex flex-wrap gap-1">
          {visible.map((k) => (
            <span key={k} className={`h-1.5 w-1.5 rounded-full ${k === curKey ? "bg-accent" : items[k].stored || isDone(items[k]) ? "bg-accent/40" : "bg-white/15"}`} />
          ))}
        </span>
        <button
          type="button"
          aria-label="Close practice"
          onClick={close}
          className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-text-secondary hover:text-text-primary"
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 md:overflow-visible md:px-0">
        {cur ? (
          <CardView
            it={cur}
            today={round.today}
            pollOver={cur.savedAt !== null && isGrading(cur, results) && timers.now() - cur.savedAt > POLL_FOR_MS}
            results={results}
            sourcesOpen={sourcesOpen}
            setSourcesOpen={setSourcesOpen}
            refs={{ promptRef, retryRef, inputRef, noteRef }}
            onAnswer={(v) => patch(cur.key, { answer: v })}
            onChoice={(i) => patch(cur.key, { choice: i })}
            onOrder={(o) => patch(cur.key, { order: o })}
            onRetry={() => retry(cur.key)}
            onReveal={() => {
              patch(cur.key, { revealed: true });
              setFocus("note");
            }}
            onGradeHighlight={(g) => void gradeHighlight(cur.key, g)}
            onChange={(m, v) => void changeGrade(cur.key, m, v)}
          />
        ) : (
          <section data-testid="practice-summary" className="space-y-3">
            <h2 ref={summaryRef} tabIndex={-1} className="text-[17px] font-medium text-text-primary outline-none">
              Round done
            </h2>
            <p className="font-mono text-[15px] text-text-primary">
              {summary.answered} of {summary.total} · +{summary.xp} XP
            </p>
            {summary.movedUp > 0 && (
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
                  .filter((it): it is Item => !!it && isGrading(it, results) && results[attemptKeyOf(it) ?? ""]?.self_gradable === true)
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
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" onClick={close} className={PRIMARY}>
                Done
              </button>
              {onMore && round.extra_available > 0 && (
                <button type="button" onClick={onMore} className={SECONDARY}>
                  One more round
                </button>
              )}
            </div>
          </section>
        )}
        <p aria-live="polite" role="status" className="sr-only">
          {announce}
        </p>
        <FlagBars flags={flags} onUndo={undoFlag} onRetry={(k) => void queue.retry(k)} />
      </div>

      {cur && (
        <div className="shrink-0 border-t border-border-subtle bg-surface px-4 py-2 md:mt-3 md:border-0 md:bg-transparent md:px-0 md:py-0">
          <div className="flex items-center gap-2">
            {answerable(cur) ? (
              cur.card.kind === "highlight" ? (
                <span className="flex-1" />
              ) : (
                <>
                  <button type="button" disabled={!answerOf(cur) || busy.current} onClick={() => check(cur.key)} className={`${PRIMARY} disabled:opacity-40`}>
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
                  it={cur}
                  onSkip={skip}
                  onShowChoices={() => {
                    setMenuOpen(false);
                    patch(cur.key, { hinted: true, choice: null });
                  }}
                  onFlag={flag}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
  return phone && typeof document !== "undefined" ? createPortal(view, document.body) : view;
}

/* ------------------------------------------------------------------ */

function CardMenu({ it, onSkip, onShowChoices, onFlag }: { it: Item; onSkip: () => void; onShowChoices: () => void; onFlag: (k: FlagKind) => void }) {
  const rub = it.question ? parseRubric(it.question.rubric) : null;
  const canChoices = answerable(it) && it.question?.format === "cued" && !it.hinted && rub?.format === "cued" && (rub.options?.length ?? 0) === 4;
  const busyNow = it.phase === "saving" || it.phase === "unknown";
  const kinds: FlagKind[] =
    it.card.kind === "idea" ? ["wrong", "unclear", "not_in_chapter", "not_read_yet"] : it.card.kind === "chapter_recall" ? ["unclear", "not_read_yet"] : [];
  const item = "flex min-h-11 w-full items-center px-3 text-left text-[14px] text-text-primary hover:bg-white/[0.05]";
  return (
    <div role="menu" aria-label="Card actions" className="absolute bottom-full right-0 z-10 mb-2 w-56 overflow-hidden rounded-control border border-border-default bg-surface-raised py-1 shadow-card">
      {answerable(it) && (
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
  results: Record<string, AttemptResult>;
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

function CardView({ it, today, pollOver, results, sourcesOpen, setSourcesOpen, refs, onAnswer, onChoice, onOrder, onRetry, onReveal, onGradeHighlight, onChange }: CardViewProps) {
  const card = it.card;
  const q = it.question;
  const rub = q ? parseRubric(q.rubric) : null;
  const open = answerable(it);
  const answered = !open;
  const verdict = verdictOf(it, results);
  const result = results[attemptKeyOf(it) ?? ""];
  const grading = isGrading(it, results);

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

  return (
    <article data-testid="practice-card" className="space-y-3">
      <CardChips chapter={card.chapter} format={format} sourceCount={card.source_count} onSources={answered ? () => setSourcesOpen(true) : undefined} />
      <h2 ref={refs.promptRef} tabIndex={-1} className="text-[17px] leading-snug text-text-primary outline-none">
        {q.prompt}
      </h2>

      {/* The answer: typed / dictated, 4 choices (hinted), or steps to order. Read-only once checked. */}
      {format === "order" ? (
        <OrderPicker steps={steps} offered={offered} picked={it.order} onChange={onOrder} disabled={answered} />
      ) : format === "cued" && it.hinted ? (
        <ChoiceList
          options={options}
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

      {it.phase === "refused" && it.message && <AlertLine heading="Not saved:" message={it.message} />}

      {answered && (
        <div data-testid="practice-result" className="space-y-3 rounded-control border border-border-subtle bg-white/[0.02] p-3">
          {/* Verdict line: an icon and a word; or "Saved · grading" while the model grades. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
            {verdict ? (
              <VerdictWord verdict={verdict} />
            ) : it.phase === "saved" && grading ? (
              <span className="text-text-secondary">{pollOver && !result?.self_gradable ? "Still grading · shows later" : "Saved · grading"}</span>
            ) : it.phase === "saving" ? (
              <span className="text-text-secondary">Saving</span>
            ) : null}
            {it.phase === "saving" && verdict && <span className="text-[12px] text-text-tertiary">Saving</span>}
            {it.phase === "saved" && verdict && (
              <span className="font-mono text-[12px] text-text-tertiary">
                {nextLine({ today, verdict, preview: card.preview, receiptNext: it.receipt?.next_review ?? null, again: it.again })}
              </span>
            )}
            {it.phase === "saved" && format === "chapter_recall" && card.recall?.next_due_on && (
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
              {result?.overridable && it.change?.status !== "saved" && (
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
