"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Highlight, ReadingOverview } from "@/lib/reading";
import {
  attemptFor,
  classifyReviewAnswer,
  GRADE_LABEL,
  intervalLabel,
  PRACTICE_GRADES,
  remainingQueue,
  reviewPreview,
  type PracticeGrade,
  type ReviewAttempt,
} from "@/lib/reading-practice";

/**
 * /reading Review card (PROD-T03). One due highlight at a time: say what it means, reveal the note, grade it.
 *
 * - Each grade button shows the interval the server will actually store (reviewPreview, the same scheduler the
 *   commit uses; the first Good is 1 day).
 * - One grade request at a time: while it is saving the buttons are aria-disabled (they keep focus) and a line says
 *   why. The card and the note stay on screen until the server confirms.
 * - A failure keeps the card. No answer / a server error: "Not saved" with Retry, which sends the SAME operation
 *   key (lib/reading-practice.ts attemptFor), so a grade that did land is answered from its receipt instead of
 *   being stored twice. A refusal: nothing was written, any grade can be picked again. Graded on another screen
 *   (409): Refresh. The message is a role=alert line with a word and an icon, not color alone.
 * - Success advances exactly once (this card's graded ids are kept, so a reload that raced the grade cannot bring
 *   the card back) and moves focus to the next card's reveal button, or to the "Nothing due" line.
 * - Retry and Refresh leave the screen while they work, so focus never drops to the page: a Retry that fails again
 *   puts focus on the new Retry button (or on the note when there is none), a Refresh puts it on the note and then
 *   on the next card once the re-read overview replaces this one.
 */

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : "—";

type Status =
  | { kind: "idle" }
  | { kind: "saving"; grade: PracticeGrade }
  | { kind: "unknown" | "refused" | "stale"; grade: PracticeGrade; message: string };

const GRADE_CLASS: Record<PracticeGrade, string> = {
  again: "border-[var(--color-down)]/50 text-[var(--color-down)]",
  good: "border-border-default text-text-primary",
  easy: "border-accent/60 text-accent",
};

export default function ReviewCard({
  o,
  onGraded,
  onRefresh,
}: {
  o: ReadingOverview;
  /** After a stored grade: the XP the server reported (0 on a replay of an earlier try). */
  onGraded: (xp: number) => void;
  /** Re-read the overview (the card changed on another screen). */
  onRefresh: () => void;
}) {
  const [graded, setGraded] = useState<number[]>([]);
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // The last request whose outcome is unknown: the next tap on this card reuses its key.
  const [pending, setPending] = useState<ReviewAttempt | null>(null);
  const [focus, setFocus] = useState<"next" | "note" | "retry" | null>(null);
  // Set by Refresh: when the re-read overview puts another card on top, focus moves to it.
  const focusNextCard = useRef(false);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const revealRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const doneRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A new behavioral day or another book: the graded list starts over.
  useEffect(() => {
    setGraded((prev) => (prev.length ? [] : prev));
  }, [o.book.book_id, o.today]);

  const queue = useMemo(() => remainingQueue(o.dueReviews, new Set(graded)), [o.dueReviews, graded]);
  const cur: Highlight | undefined = queue[0];
  const cardKey = cur ? `${cur.highlight_id}:${cur.review_count}` : "";
  const curRef = useRef<Highlight | undefined>(cur);
  curRef.current = cur;

  // Another card on top (advanced, or a reload changed it): its own fresh state. Not while a request is out.
  useEffect(() => {
    if (inFlight.current) return;
    setStatus((s) => (s.kind === "idle" ? s : { kind: "idle" }));
    setPending((p) => (p && cur && p.highlight_id === cur.highlight_id && p.expected_review_count === cur.review_count ? p : null));
    if (focusNextCard.current) {
      focusNextCard.current = false;
      setFocus("next");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);

  useEffect(() => {
    if (!focus) return;
    if (focus === "next") (revealRef.current ?? doneRef.current ?? noteRef.current)?.focus();
    else if (focus === "retry") (retryRef.current ?? noteRef.current)?.focus();
    else noteRef.current?.focus();
    // Functional: a target another effect set in this same pass (Refresh, then the next card) is kept.
    setFocus((f) => (f === focus ? null : f));
  }, [focus, cardKey, revealedId]);

  const preview = useMemo(() => (cur ? reviewPreview(cur, o.today) : null), [cur, o.today]);
  const nextDue = useMemo(() => {
    const future = o.highlights.map((h) => h.next_review).filter((d): d is string => !!d && d > o.today).sort();
    return future[0] ?? null;
  }, [o.highlights, o.today]);

  const saving = status.kind === "saving";
  const blocked = saving || status.kind === "stale";

  // `fromRetry`: the Retry button that was pressed leaves the screen while this request is out.
  const grade = async (g: PracticeGrade, fromRetry = false) => {
    if (!cur || inFlight.current || status.kind === "stale") return;
    const attempt = attemptFor(pending, cur, g);
    inFlight.current = true;
    setPending(attempt);
    setStatus({ kind: "saving", grade: g });
    let httpStatus: number | null = null;
    let body: unknown = null;
    try {
      const res = await fetch("/api/reading/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt),
      });
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch {
      httpStatus = null;
    }
    inFlight.current = false;
    if (!alive.current) return;
    const out = classifyReviewAnswer(httpStatus, body);
    if (out.kind === "saved") {
      setPending(null);
      setStatus({ kind: "idle" });
      setRevealedId(null);
      setGraded((prev) => (prev.includes(attempt.highlight_id) ? prev : [...prev, attempt.highlight_id]));
      setFocus("next");
      onGraded(out.xp);
      return;
    }
    // Refused or stale: nothing was written under this key, so it is not reused.
    if (out.kind !== "unknown") setPending(null);
    // The card left the top while the request was out (the overview was re-read): its message would sit on another card.
    if (curRef.current?.highlight_id !== attempt.highlight_id) {
      setStatus({ kind: "idle" });
      if (fromRetry) setFocus("next");
      return;
    }
    setStatus({ kind: out.kind, grade: g, message: out.message });
    if (fromRetry) setFocus("retry");
  };

  const header = queue.length
    ? `${queue.length} due`
    : o.reviewsToday
      ? `${o.reviewsToday} done today`
      : nextDue
        ? `next ${fmtDate(nextDue)}`
        : "nothing scheduled";

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-review">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Review</h3>
        <span className="text-[11px] font-mono text-text-tertiary">{header}</span>
      </div>
      {cur && preview ? (
        <div className="mt-2" data-testid="reading-review-card">
          <blockquote className="text-[14px] text-text-primary leading-relaxed border-l-2 border-accent/60 pl-3">{cur.passage}</blockquote>
          <div className="mt-2 text-[11px] font-mono text-text-tertiary">
            {cur.chapter != null ? `ch ${cur.chapter}` : ""} {cur.concept ? `· ${cur.concept}` : ""}
          </div>
          {revealedId !== cur.highlight_id ? (
            <button
              ref={revealRef}
              onClick={() => {
                setRevealedId(cur.highlight_id);
                setFocus("note");
              }}
              className="mt-3 min-h-11 px-3 py-2 text-[13px] rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-text-secondary"
            >
              Say what this means, then reveal your note
            </button>
          ) : (
            <>
              <p ref={noteRef} tabIndex={-1} className="mt-3 text-[13px] text-text-secondary italic outline-none">
                {cur.comment || "No comment on this one. Add one below."}
              </p>
              <div className="mt-3 flex gap-3" role="group" aria-label="Grade this highlight">
                {PRACTICE_GRADES.map((g) => {
                  const days = preview[g].interval_days;
                  return (
                    <button
                      key={g}
                      type="button"
                      aria-label={`${GRADE_LABEL[g]}, next review in ${intervalLabel(days)}`}
                      aria-disabled={blocked || undefined}
                      onClick={() => {
                        if (!blocked) void grade(g);
                      }}
                      className={`flex-1 min-h-12 px-2 py-1.5 rounded-control border bg-white/[0.02] ${blocked ? "opacity-40 cursor-not-allowed" : ""} ${GRADE_CLASS[g]}`}
                    >
                      <span className="block text-[14px] font-medium leading-none">{GRADE_LABEL[g]}</span>
                      <span className="block text-[11px] font-mono opacity-80 mt-1">{intervalLabel(days)}</span>
                    </button>
                  );
                })}
              </div>
              {saving && (
                <p role="status" className="mt-2 text-[12px] text-text-secondary">
                  Saving your {GRADE_LABEL[status.grade]} grade. The grade buttons wait until Onyx answers.
                </p>
              )}
              {(status.kind === "unknown" || status.kind === "refused" || status.kind === "stale") && (
                <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-text-primary">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle aria-hidden="true" className="h-4 w-4 text-[var(--color-down)]" />
                    <span>
                      <strong className="font-medium">Not saved:</strong> {status.message}
                      {status.kind === "refused" ? " Pick a grade again." : ""}
                    </span>
                  </span>
                  {status.kind === "unknown" && (
                    <button
                      ref={retryRef}
                      type="button"
                      onClick={() => void grade(status.grade, true)}
                      className="min-h-11 px-3 rounded-control border border-border-default text-text-primary"
                    >
                      Retry {GRADE_LABEL[status.grade]}
                    </button>
                  )}
                  {status.kind === "stale" && (
                    <button
                      type="button"
                      onClick={() => {
                        setStatus({ kind: "idle" });
                        focusNextCard.current = true;
                        setFocus("note");
                        onRefresh();
                      }}
                      className="min-h-11 px-3 rounded-control border border-border-default text-text-primary">
                      Refresh
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <p ref={doneRef} tabIndex={-1} className="mt-2 text-[13px] text-text-tertiary outline-none">
          Nothing due. New highlights come up the next day, then at growing intervals based on your grades.
        </p>
      )}
    </section>
  );
}
