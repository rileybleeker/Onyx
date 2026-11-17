"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { ReadingOverview } from "@/lib/reading";
import { newRequestId } from "@/lib/chat-contract";
import InfoHint from "@/components/InfoHint";
import {
  buildDeck,
  minutesLeft,
  parsePending,
  parseSession,
  pendingBody,
  PENDING_KEY,
  percent,
  recallReport,
  SESSION_CARD_CAPS,
  SESSION_KEY,
  SESSION_MINUTE_CAPS,
  sessionEnded,
  sourceText,
  startSession,
  takeCard,
  type AttemptRow,
  type Card,
  type Pending,
  type Rate,
  type QuestionRow,
  type SessionState,
} from "@/lib/reading-retrieval";

/**
 * /reading "Practice from memory" (PROD-T08). Voluntary, bounded, resumable retrieval practice on the book's own
 * highlights, recall notes and chapters (lib/reading-retrieval.ts holds the rules; storage is the PROD-T07 question
 * and attempt tables behind /api/reading/questions).
 *
 * - Nothing is written on open or on scroll. Every write follows a tap: Submit answer, I got it / I missed it,
 *   Fix this question. Skipping and "Later" write nothing and carry no penalty.
 * - The prompt is on screen; the source and the rubric are hidden until Riley submits an answer or skips. He grades
 *   his own answer against them: a paraphrase that carries the same point counts. "This question is wrong" sends
 *   a correction; the old answers to the question then stop counting (the server keeps them, marked).
 * - The request whose outcome is unknown (offline, lost answer) is kept on this device under its own operation key
 *   until the server gives a definite answer, and is sent again only by the Retry button, with the same key, so a
 *   request that did land is answered from its receipt and never stored twice. The stored text is Riley's own
 *   answer; it is removed once confirmed and with the rest of this app's local data at sign-out.
 * - A session has a chosen card cap and an optional time cap, checked between cards. Closing the tab or going
 *   offline keeps it: the time away does not count (touch() caps each pause).
 * - Delayed recall (7 and 21 days after the first graded attempt) is reported on its own, apart from minutes,
 *   XP and first attempts.
 */

type Data = { questions: QuestionRow[]; attempts: AttemptRow[] };
type Notice = { kind: "unknown" | "refused" | "info"; text: string } | null;

const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* private mode / quota: the request still goes, only the offline protection is lost */
    }
  },
};

const REFUSED: Record<string, string> = {
  practice_unavailable: "Practice storage isn't available yet.",
  question_changed: "This question changed on another screen. Refresh and try again.",
  source_not_permitted: "That source can't be used for a question.",
  already_answered: "This card was already answered.",
  bad_answer: "Write an answer first.",
};

export default function RetrievalSession({ o, onChanged }: { o: ReadingOverview; onChanged?: () => void }) {
  const slug = o.book.slug;
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [cards, setCards] = useState<number>(5);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rubric, setRubric] = useState("");
  const [skippedId, setSkippedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fix, setFix] = useState({ prompt: "", rubric: "", reason: "", drop: true });
  const [ended, setEnded] = useState<string | null>(null);
  const inFlight = useRef(false);
  // One key set per card, kept until a definite answer (so a retry of the same card reuses it).
  const work = useRef<{ cardId: string; attemptKey: string; questionKey: string } | null>(null);
  const fixKey = useRef<string | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/reading/questions?book=${encodeURIComponent(slug)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(REFUSED[json?.error] ?? "Couldn't load your practice questions.");
        return false;
      }
      setData({ questions: json.questions ?? [], attempts: json.attempts ?? [] });
      setLoadError(null);
      return true;
    } catch {
      setLoadError("Couldn't load your practice questions.");
      return false;
    }
  }, [slug]);

  useEffect(() => {
    void load();
    setSession(parseSession(store.get(SESSION_KEY), slug, o.today));
    setPending(parsePending(store.get(PENDING_KEY), slug));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, o.today]);

  const persistSession = (s: SessionState | null) => {
    setSession(s);
    store.set(SESSION_KEY, s ? JSON.stringify(s) : null);
  };
  const persistPending = (p: Pending | null) => {
    setPending(p);
    store.set(PENDING_KEY, p ? JSON.stringify(p) : null);
  };

  const highlights = o.highlights;
  const taken = useMemo(() => new Set(session?.taken ?? []), [session]);
  const deck = useMemo(
    () => (data ? buildDeck({ questions: data.questions, attempts: data.attempts, highlights, today: o.today, taken }) : []),
    [data, highlights, o.today, taken],
  );
  const allDeck = useMemo(
    () => (data ? buildDeck({ questions: data.questions, attempts: data.attempts, highlights, today: o.today }) : []),
    [data, highlights, o.today],
  );
  const report = useMemo(() => (data ? recallReport(data.questions, data.attempts) : null), [data]);

  const endReason = session ? sessionEnded(session) : null;
  const cur: Card | undefined = session && !endReason ? deck[0] : undefined;
  const phase: "ask" | "skipped" | "grade" | null = !cur ? null : cur.kind === "finish" ? "grade" : skippedId === cur.id ? "skipped" : "ask";

  // A new card starts with its own editable prompt, an empty answer and fresh keys.
  const curId = cur?.id ?? "";
  useEffect(() => {
    setAnswer("");
    setNotice((n) => (n?.kind === "unknown" ? n : null));
    setFixing(false);
    fixKey.current = null;
    if (cur?.kind === "new") {
      setPrompt(cur.prompt);
      setRubric("");
    } else if (cur) {
      setPrompt(cur.question.prompt);
      setRubric(cur.question.rubric ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId]);

  // Focus follows the card: its answer box, or the revealed source after an answer or a skip.
  useEffect(() => {
    if (curId) focusRef.current?.focus();
  }, [curId, phase]);

  const keys = (card: Card) => {
    if (!work.current || work.current.cardId !== card.id) {
      // A request from before a reload keeps its own keys, so sending the card again cannot store a second one.
      if (pending?.kind === "answer" && pending.cardId === card.id) {
        work.current = { cardId: card.id, attemptKey: pending.attempt_key, questionKey: pending.question_key };
        return work.current;
      }
      work.current = { cardId: card.id, attemptKey: newRequestId(), questionKey: card.kind === "new" ? newRequestId() : card.question.question_key };
    }
    return work.current;
  };

  const post = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> } | null> => {
    try {
      const res = await fetch("/api/reading/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    } catch {
      return null;
    }
  };

  const unknown = (what: string): Notice => ({
    kind: "unknown",
    text: `${what} wasn't confirmed saved. Retry can't store it twice.`,
  });

  const refusal = (r: { status: number; json: Record<string, unknown> }): Notice => ({
    kind: "refused",
    text: `Not saved: ${REFUSED[String(r.json.error)] ?? "Onyx refused it."}`,
  });

  const finishCard = (id: string, counted: boolean) => {
    if (!session) return;
    persistSession(takeCard(session, id, counted, Date.now()));
    setSkippedId(null);
    onChanged?.();
  };

  // --- answer ---
  const submitAnswer = async () => {
    if (!cur || cur.kind === "finish" || inFlight.current) return;
    if (!answer.trim()) return setNotice({ kind: "refused", text: "Write an answer first, or skip." });
    if (!prompt.trim()) return setNotice({ kind: "refused", text: "The question can't be empty." });
    const k = keys(cur);
    const p: Pending = {
      kind: "answer",
      book: slug,
      attempt_key: k.attemptKey,
      question_key: k.questionKey,
      prompt: prompt.trim(),
      rubric: rubric.trim() || null,
      source_kind: cur.kind === "new" ? "highlight" : cur.question.source_kind,
      source_ref: cur.kind === "new" ? cur.highlight.highlight_id : cur.question.source_ref,
      answer,
      cardId: cur.id,
    };
    await sendAnswer(p);
  };

  const sendAnswer = async (p: Pending) => {
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    persistPending(p);
    const r = await post(pendingBody(p));
    if (!r || r.status >= 500) {
      setNotice(unknown("Your answer"));
    } else if (r.status === 200) {
      persistPending(null);
      work.current = null;
      if (!(await load())) setNotice({ kind: "info", text: "Answer saved. Couldn't refresh the card: reload the page." });
    } else {
      persistPending(null);
      setNotice(refusal(r));
    }
    inFlight.current = false;
    setBusy(false);
  };

  // --- grade ---
  const sendGrade = async (card: Card & { kind: "finish" }, correct: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    const p: Pending = { kind: "grade", book: slug, attempt_key: card.attempt.attempt_key, correct, cardId: card.id, question_key: card.question.question_key, version: card.question.version };
    persistPending(p);
    const r = await post(pendingBody(p));
    if (!r || r.status >= 500) setNotice(unknown("Your grade"));
    else if (r.status === 200 || (r.status === 409 && (r.json.error === "already_graded" || r.json.error === "invalidated"))) {
      persistPending(null);
      if (r.status === 409) setNotice({ kind: "info", text: r.json.error === "invalidated" ? "That question was corrected, so this answer doesn't count." : "That answer was already graded." });
      finishCard(card.id, r.status === 200);
      void load();
    } else {
      persistPending(null);
      setNotice(refusal(r));
    }
    inFlight.current = false;
    setBusy(false);
  };

  const retryPending = async () => {
    if (!pending || inFlight.current) return;
    if (pending.kind === "answer") return sendAnswer(pending);
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    const r = await post(pendingBody(pending));
    if (!r || r.status >= 500) setNotice(unknown("Your grade"));
    else if (r.status === 200 || r.status === 409) {
      persistPending(null);
      if (session) persistSession(takeCard(session, pending.cardId, r.status === 200, Date.now()));
      void load();
    } else {
      persistPending(null);
      setNotice(refusal(r));
    }
    inFlight.current = false;
    setBusy(false);
  };

  // --- correction ---
  const sendFix = async (card: Card & { kind: "finish" }) => {
    if (inFlight.current) return;
    if (!fix.prompt.trim() || !fix.reason.trim()) return setNotice({ kind: "refused", text: "Give the corrected question and why it was wrong." });
    inFlight.current = true;
    setBusy(true);
    fixKey.current ??= newRequestId();
    const r = await post({
      op: "correct",
      op_key: fixKey.current,
      question_key: card.question.question_key,
      expected_version: card.question.version,
      prompt: fix.prompt.trim(),
      ...(fix.rubric.trim() ? { rubric: fix.rubric.trim() } : {}),
      source_kind: card.question.source_kind,
      source_ref: card.question.source_ref,
      reason: fix.reason.trim(),
      invalidate: fix.drop,
    });
    if (!r || r.status >= 500) setNotice(unknown("Your correction"));
    else if (r.status === 200) {
      fixKey.current = null;
      setFixing(false);
      setNotice({ kind: "info", text: fix.drop ? "Question corrected. Earlier answers to it no longer count." : "Question corrected." });
      finishCard(card.id, false);
      void load();
    } else setNotice(refusal(r));
    inFlight.current = false;
    setBusy(false);
  };

  const start = () => {
    setEnded(null);
    setNotice(null);
    persistSession(startSession(slug, o.today, cards, minutes, Date.now()));
  };
  const endSession = (why: string) => {
    persistSession(null);
    setSkippedId(null);
    setEnded(why);
  };

  // Reaching a cap, or running out of cards, closes the session with a plain line (checked between cards only).
  useEffect(() => {
    if (!session) return;
    if (endReason) endSession(endReason === "cards" ? `Done: ${session.done} card${session.done === 1 ? "" : "s"}.` : "Time's up. Nothing is lost; start again whenever you like.");
    else if (data && !cur && !busy) endSession(session.done ? `Done: ${session.done} card${session.done === 1 ? "" : "s"}. Nothing else is due.` : "Nothing is due right now.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endReason, cur, data, busy]);

  const dueCount = allDeck.filter((c) => c.kind !== "new").length;
  const newCount = allDeck.filter((c) => c.kind === "new").length;
  const source = cur && cur.kind !== "new" ? sourceText(cur.question.source_kind, cur.question.source_ref, highlights, o.sessions) : cur?.kind === "new" ? sourceText("highlight", cur.highlight.highlight_id, highlights, o.sessions) : null;
  const btn = "min-h-11 px-3 rounded-control border border-border-default text-text-primary disabled:opacity-40";
  const left = session ? minutesLeft(session) : null;

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-retrieval" aria-labelledby="retrieval-h">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="retrieval-h" className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">
          Practice from memory
        </h3>
        <span className="text-[11px] font-mono text-text-tertiary">
          {data ? `${dueCount} due · ${newCount} new` : loadError ? "unavailable" : "loading"}
        </span>
      </div>
      <InfoHint label="Practice from memory" variant="disclosure" summary="About this">
        <p>
          Answer from memory first; the source and the answer guide appear after you answer or skip. You judge your own answer against them: a
          paraphrase that makes the same point counts. Skipping and stopping cost nothing. Checks come 7 and 21 days after the first graded
          answer and are reported apart from minutes and XP. This is practice, not a measure of memory or health.
        </p>
      </InfoHint>

      <p role="status" aria-live="polite" className={ended ? "mt-2 text-[12px] text-text-secondary" : "sr-only"}>
        {ended ?? ""}
      </p>

      {loadError && (
        <p role="alert" className="mt-2 text-[12px] text-text-primary">
          <AlertTriangle aria-hidden="true" className="inline h-4 w-4 mr-1 text-[var(--color-mid)]" />
          {loadError}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      {pending && !busy && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-text-primary">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-[var(--color-mid)]" />
          <span>{pending.kind === "answer" ? "An answer" : "A grade"} from earlier wasn&apos;t confirmed saved. Sending it again can&apos;t store it twice.</span>
          <button type="button" className={btn} onClick={() => void retryPending()}>
            Send it
          </button>
        </div>
      )}

      {!session && data && (
        <div className="mt-3 space-y-3">
          <fieldset>
            <legend className="text-[12px] text-text-secondary">Cards this session</legend>
            <div className="mt-1 flex gap-2">
              {SESSION_CARD_CAPS.map((n) => (
                <label key={n} className={`min-h-11 px-3 flex items-center rounded-control border ${cards === n ? "border-accent text-accent" : "border-border-default text-text-primary"}`}>
                  <input type="radio" name="retrieval-cards" className="sr-only" checked={cards === n} onChange={() => setCards(n)} />
                  {n}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-[12px] text-text-secondary">Time limit</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {[null, ...SESSION_MINUTE_CAPS].map((m) => (
                <label key={String(m)} className={`min-h-11 px-3 flex items-center rounded-control border ${minutes === m ? "border-accent text-accent" : "border-border-default text-text-primary"}`}>
                  <input type="radio" name="retrieval-minutes" className="sr-only" checked={minutes === m} onChange={() => setMinutes(m)} />
                  {m == null ? "None" : `${m} min`}
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" disabled={dueCount + newCount === 0} onClick={start} className={`${btn} bg-accent text-on-accent border-transparent`}>
            {dueCount + newCount === 0 ? "Nothing to practice yet" : "Start practice"}
          </button>
        </div>
      )}

      {session && (
        <div className="mt-3" data-testid="reading-retrieval-card">
          <div className="flex items-center justify-between text-[11px] font-mono text-text-tertiary">
            <span>
              card {Math.min(session.done + 1, session.cards)} of {session.cards}
              {left != null ? ` · about ${left} min left` : ""}
            </span>
            <button type="button" className="underline" onClick={() => endSession(`Stopped after ${session.done} card${session.done === 1 ? "" : "s"}. You can start again any time.`)}>
              Stop
            </button>
          </div>

          {cur && (
            <div className="mt-2">
              {cur.kind === "recall" && (
                <p className="text-[11px] font-mono text-text-tertiary">{cur.bucket}-day check</p>
              )}
              {phase === "ask" ? (
                <>
                  {cur.kind === "new" ? (
                    <>
                      <label htmlFor="retrieval-prompt" className="text-[12px] text-text-secondary">
                        Question (edit it if you like)
                      </label>
                      <textarea id="retrieval-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={1000} className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2" />
                    </>
                  ) : (
                    <p className="text-[14px] text-text-primary leading-relaxed" id="retrieval-q">
                      {cur.question.prompt}
                    </p>
                  )}
                  <label htmlFor="retrieval-answer" className="mt-2 block text-[12px] text-text-secondary">
                    Your answer, from memory
                  </label>
                  <textarea
                    id="retrieval-answer"
                    ref={(el) => { focusRef.current = el; }}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    aria-describedby={cur.kind === "new" ? undefined : "retrieval-q"}
                    className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2"
                  />
                  {cur.kind === "new" && (
                    <>
                      <label htmlFor="retrieval-rubric" className="mt-2 block text-[12px] text-text-secondary">
                        What a good answer includes (optional, shown after you answer)
                      </label>
                      <textarea id="retrieval-rubric" value={rubric} onChange={(e) => setRubric(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2" />
                    </>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" aria-disabled={busy} onClick={() => !busy && void submitAnswer()} className={`${btn} bg-accent text-on-accent border-transparent`}>
                      Submit answer
                    </button>
                    <button type="button" disabled={busy} onClick={() => setSkippedId(cur.id)} className={btn}>
                      Skip and show the source
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[14px] text-text-primary leading-relaxed">{cur.kind === "new" ? prompt : cur.question.prompt}</p>
                  {phase === "grade" && cur.kind === "finish" && cur.attempt.answer && (
                    <p className="mt-2 text-[13px] text-text-secondary whitespace-pre-wrap">
                      <span className="text-[11px] font-mono text-text-tertiary block">Your answer</span>
                      {cur.attempt.answer}
                    </p>
                  )}
                  <div ref={(el) => { focusRef.current = el; }} tabIndex={-1} className="mt-2 border-l-2 border-accent/60 pl-3 outline-none">
                    <span className="text-[11px] font-mono text-text-tertiary block">Source{cur.kind !== "new" && cur.question.source_status === "changed" ? " (edited since the question was written)" : ""}</span>
                    <p className="text-[14px] text-text-primary whitespace-pre-wrap">{source ?? "The source is no longer available."}</p>
                    {(cur.kind !== "new" ? cur.question.rubric : null) && (
                      <p className="mt-2 text-[13px] text-text-secondary whitespace-pre-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary block">A good answer</span>
                        {cur.kind !== "new" ? cur.question.rubric : null}
                      </p>
                    )}
                  </div>
                  {phase === "grade" && cur.kind === "finish" ? (
                    <>
                      <p className="mt-2 text-[12px] text-text-secondary">Judge by meaning, not wording. A paraphrase that makes the same point counts.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" aria-disabled={busy} onClick={() => !busy && void sendGrade(cur, true)} className={btn}>
                          I got it
                        </button>
                        <button type="button" aria-disabled={busy} onClick={() => !busy && void sendGrade(cur, false)} className={btn}>
                          I missed it
                        </button>
                        <button type="button" disabled={busy} onClick={() => finishCard(cur.id, false)} className={btn}>
                          Later
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setFix({ prompt: cur.question.prompt, rubric: cur.question.rubric ?? "", reason: "", drop: true });
                            setFixing((f) => !f);
                          }}
                          className={btn}
                        >
                          This question is wrong
                        </button>
                      </div>
                      {fixing && (
                        <div className="mt-2 space-y-2" role="group" aria-label="Correct this question">
                          <label className="block text-[12px] text-text-secondary">
                            Corrected question
                            <textarea value={fix.prompt} onChange={(e) => setFix({ ...fix, prompt: e.target.value })} rows={2} maxLength={1000} className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2" />
                          </label>
                          <label className="block text-[12px] text-text-secondary">
                            What a good answer includes (optional)
                            <textarea value={fix.rubric} onChange={(e) => setFix({ ...fix, rubric: e.target.value })} rows={2} maxLength={2000} className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2" />
                          </label>
                          <label className="block text-[12px] text-text-secondary">
                            What was wrong
                            <input value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} maxLength={500} className="mt-1 w-full text-[16px] bg-transparent border border-border-default rounded-control p-2" />
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-text-secondary min-h-11">
                            <input type="checkbox" checked={fix.drop} onChange={(e) => setFix({ ...fix, drop: e.target.checked })} />
                            Earlier answers to this question stop counting
                          </label>
                          <button type="button" aria-disabled={busy} onClick={() => !busy && void sendFix(cur)} className={btn}>
                            Save correction
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="mt-2">
                      <p className="text-[12px] text-text-secondary">Skipped: nothing was recorded and nothing is held against you.</p>
                      <button type="button" className={`${btn} mt-2`} onClick={() => finishCard(cur.id, false)}>
                        Next card
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {notice && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-text-primary">
          {notice.kind !== "info" && <AlertTriangle aria-hidden="true" className={`h-4 w-4 ${notice.kind === "unknown" ? "text-[var(--color-mid)]" : "text-[var(--color-down)]"}`} />}
          <span>{notice.text}</span>
          {notice.kind === "unknown" && pending && (
            <button type="button" className={btn} onClick={() => void retryPending()}>
              Retry
            </button>
          )}
        </div>
      )}

      {report && (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]" data-testid="reading-retrieval-report" aria-label="Recall, apart from minutes and XP">
          {([
            ["First try", report.first],
            ["7-day recall", report.delayed7],
            ["21-day recall", report.delayed21],
          ] as Array<[string, Rate]>).map(([label, r]) => (
            <div key={label}>
              <dt className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">{label}</dt>
              <dd className="text-text-primary">
                {percent(r)} <span className="text-text-tertiary">({r.correct}/{r.n})</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {report && (report.pending > 0 || report.invalidated > 0) && (
        <p className="mt-1 text-[11px] text-text-tertiary">
          {report.pending ? `${report.pending} answer${report.pending === 1 ? "" : "s"} waiting for a grade. ` : ""}
          {report.invalidated ? `${report.invalidated} no longer count (question corrected).` : ""}
        </p>
      )}
    </section>
  );
}
