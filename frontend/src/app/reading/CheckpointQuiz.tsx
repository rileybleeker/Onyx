"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Check } from "lucide-react";
import { getJson } from "@/lib/reading-practice-client";
import { checkpointRefusal, checkpointUrl, hasUnrecordedAnswers, parseCheckpoint, shortfallLine, type CheckpointData } from "@/lib/reading-map";
import { AlertLine } from "./PracticeCards";

const PracticeRunner = dynamic(() => import("./PracticeRunner"), { ssr: false, loading: () => <div className="h-[320px]" aria-hidden="true" /> });

/**
 * The checkpoint quiz in the app (READ-QUIZ-01 S5; replaces the "quiz me" link to chat once the book's questions are
 * on). Opened by the checkpoint tile's Start button, it reads the quiz round (GET /api/reading/practice/checkpoint,
 * no side effect: the same day gives the same quiz, so reopening resumes), and runs it in the practice runner in
 * checkpoint mode: 10 questions, one per idea, answers stored under one quiz key, and Done records the result through
 * POST /api/reading/quiz with op_key = quiz key (the runner does that, from the database's own count of the quiz's
 * answers, which this part reads for it; this part only hosts it).
 *
 * States, each in its own words: loading; the quiz round could not be read (Try again); not open yet (the checkpoint
 * chapter is not quizzable); questions are off; too few fresh questions (or too few from the latest chapters, or
 * without an explain variant: "ideas answered in the last 7 days wait"); already recorded today (the quiz key is one
 * per day); and the quiz itself.
 *
 * `onClose` says what happened so the page can refresh its numbers once answers have settled and show "Answered ·
 * record result" on a tile whose answers were stored without Done. That is read from the stored answers (this
 * opening's, or an earlier one's), so closing a quiz without touching it does not lose it.
 */
export interface CheckpointClose {
  /** Something was stored (an answer, a flag, the result). */
  changed: boolean;
  /** The result was recorded. */
  recorded: boolean;
  /**
   * Set when answers of this quiz may be stored without a result: resolves to whether they are (read from the quiz
   * once what was on its way has landed, or known from the opening read when nothing changed), so the tile can say
   * "Answered · record result" only when that is true (a flag alone is not an answer).
   */
  unrecorded?: Promise<boolean>;
  /** Resolves once answers and flags on their way have landed (the page re-reads after it). */
  settled?: Promise<void>;
}

export default function CheckpointQuiz({
  slug,
  checkpoint,
  chapter,
  onClose,
  onRecorded,
}: {
  slug: string;
  /** "ch12". */
  checkpoint: string;
  chapter: number;
  onClose: (r: CheckpointClose) => void;
  /** The result was stored: the page re-reads its numbers at once. */
  onRecorded?: (r: { score: number; total: number; passed: boolean; xp: number }) => void;
}) {
  const url = checkpointUrl(slug, chapter);
  const [data, setData] = useState<CheckpointData | null>(null);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "refused"; reason: "off" | "locked" | "failed"; message: string }>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const recorded = useRef(false);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Read the quiz round when it opens (and again on Try again). A GET: it stores nothing.
  useEffect(() => {
    setState({ kind: "loading" });
    void (async () => {
      const r = await getJson(url);
      if (!alive.current) return;
      const parsed = r.status === 200 ? parseCheckpoint(r.body) : null;
      if (parsed) {
        setData(parsed);
        setState({ kind: "ready" });
        return;
      }
      const why = checkpointRefusal(r.status, r.body);
      setState({ kind: "refused", reason: why.kind, message: why.message });
    })();
  }, [url, attempt]);

  // On a wide screen the quiz opens in place, below the checkpoint tiles: bring it into view.
  useEffect(() => {
    const el = rootRef.current;
    const wide = typeof window !== "undefined" && typeof window.matchMedia === "function" ? !window.matchMedia("(max-width: 767px)").matches : false;
    if (el && wide && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [state.kind]);

  const leave = (changed: boolean, settled?: Promise<void>) => {
    const done = recorded.current;
    let unrecorded: Promise<boolean> | undefined;
    if (!done && changed) {
      unrecorded = (async () => {
        try {
          await settled;
        } catch {
          /* read anyway */
        }
        const r = await getJson(checkpointUrl(slug, chapter, true));
        const parsed = r.status === 200 ? parseCheckpoint(r.body) : null;
        return !!parsed && hasUnrecordedAnswers(parsed);
      })();
    } else if (!done && data && hasUnrecordedAnswers(data)) {
      // Nothing changed in this opening, but an earlier one left answers without a result: still to be recorded.
      unrecorded = Promise.resolve(true);
    }
    onClose({ changed, recorded: done, settled, unrecorded });
  };

  // The database's count of this quiz's valid answers, read when Done is tapped (the result is built from it).
  const readTally = async () => {
    const r = await getJson(checkpointUrl(slug, chapter, true));
    const parsed = r.status === 200 ? parseCheckpoint(r.body) : null;
    return parsed ? parsed.tally : null;
  };

  const heading = `Checkpoint · ch ${chapter}`;

  return (
    <section ref={rootRef} className="mb-4 rounded-card border border-border-subtle bg-surface-card p-4 shadow-card" data-testid="checkpoint-quiz" aria-label={heading}>
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">{heading}</h3>

      {state.kind === "loading" && <p className="mt-2 text-[14px] text-text-tertiary">Building the quiz</p>}

      {state.kind === "refused" && (
        <div className="mt-2 space-y-2">
          <AlertLine heading={state.reason === "failed" ? "Couldn't load:" : "Not available:"} message={state.message} />
          <div className="flex flex-wrap gap-2">
            {state.reason === "failed" && (
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="inline-flex min-h-11 items-center rounded-control border border-border-default px-3 text-[14px] text-text-primary">
                Try again
              </button>
            )}
            <button type="button" onClick={() => leave(false)} className="inline-flex min-h-11 items-center px-3 text-[14px] text-text-secondary">
              Close
            </button>
          </div>
        </div>
      )}

      {state.kind === "ready" && data && data.recorded && (
        <div className="mt-2 space-y-2">
          <p data-testid="quiz-already" className="inline-flex items-center gap-1.5 text-[14px] text-text-primary">
            <Check aria-hidden="true" className="h-4 w-4 text-up" />
            <span>
              Recorded today · <span className="font-mono">{data.recorded.score}/{data.recorded.total}</span>
            </span>
          </p>
          <button type="button" onClick={() => leave(false)} className="inline-flex min-h-11 items-center rounded-control border border-border-default px-3 text-[14px] text-text-primary">
            Close
          </button>
        </div>
      )}

      {state.kind === "ready" && data && !data.recorded && !data.ready && (
        <div className="mt-2 space-y-2">
          <p data-testid="quiz-few" className="text-[14px] text-text-secondary">
            {data.shortfall === "latest" || data.shortfall === "explain" ? (
              shortfallLine(data.shortfall, data.eligible, data.size)
            ) : (
              <>
                Not enough fresh questions yet · <span className="font-mono">{data.eligible} of {data.size}</span>
              </>
            )}
          </p>
          {data.tally.total > 0 && (
            <p className="text-[14px] text-text-secondary">
              Answered so far · <span className="font-mono">{data.tally.total} of {data.size}</span>
            </p>
          )}
          <p className="text-[12px] text-text-tertiary">Ideas answered in the last 7 days wait.</p>
          <button type="button" onClick={() => leave(false)} className="inline-flex min-h-11 items-center rounded-control border border-border-default px-3 text-[14px] text-text-primary">
            Close
          </button>
        </div>
      )}

      {state.kind === "ready" && data && !data.recorded && data.ready && (
        <div className="mt-2">
          <PracticeRunner
            key={data.round.round_key}
            round={data.round}
            mode="checkpoint"
            checkpoint={{ slug, chapter, key: checkpoint, quizKey: data.quizKey, size: data.size }}
            onTally={readTally}
            onClose={(changed, _finished, settled) => leave(changed, settled)}
            onRecorded={(r) => {
              recorded.current = true;
              onRecorded?.(r);
            }}
            onReread={async () => {
              const r = await getJson(url);
              const parsed = r.status === 200 ? parseCheckpoint(r.body) : null;
              return parsed ? parsed.round : null;
            }}
          />
        </div>
      )}
    </section>
  );
}
