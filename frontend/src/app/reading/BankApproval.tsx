"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { APPROVAL_URL, capDollars, classifyApprovalAnswer, estimateDollars, postJson, type BankState } from "@/lib/reading-practice-client";

/**
 * "Questions on every chapter" (READ-QUIZ-01 S4): Riley's one tap per book that approves spending on its question
 * bank. It shows the server's estimate for the chapters still to build and the cap (estimate x 1.25, rounded up, at
 * most $25), and Turn on sends exactly that cap (PUT /api/reading/bank/approval {book, on, cap_cents}); the route
 * recomputes it and answers 409 estimate_changed when it moved, and the card then shows the new numbers before
 * asking again. Nothing is spent before this tap. Mode "more" is the same approval after a budget pause
 * ("Allow $N more"), with the remaining estimate.
 *
 * One request at a time; the button keeps focus (aria-disabled) while it saves; a failure is a role=alert line with
 * an icon and a word.
 */
export default function BankApproval({
  slug,
  bank,
  mode = "on",
  onDone,
  onRecheck,
  onCancel,
}: {
  slug: string;
  bank: BankState;
  mode?: "on" | "more";
  /** Turned on: the part re-reads the bank and the round. */
  onDone: () => void;
  /** Re-read the bank (the estimate changed). */
  onRecheck: () => Promise<unknown> | void;
  onCancel?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const est = bank.estimate_cents;
  const cap = bank.cap_cents;
  if (est === null || cap === null) return null;
  const more = Math.max(0, cap - bank.spent_cents);

  const turnOn = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    const r = await postJson(APPROVAL_URL, { book: slug, on: true, cap_cents: cap }, { method: "PUT" });
    if (!alive.current) return;
    const out = classifyApprovalAnswer(r.status, r.body);
    if (out.kind === "saved") {
      setSaving(false);
      onDone();
      return;
    }
    if (out.kind === "changed") {
      try {
        await onRecheck();
      } catch {
        /* the message below says to check the amount */
      }
    }
    if (!alive.current) return;
    setSaving(false);
    setMessage(out.message);
  };

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-bank-approval">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-medium text-text-primary">{mode === "more" ? "Allow more for this book" : "Questions on every chapter"}</h3>
        <InfoHint label="About chapter questions">
          Built from your Kindle highlights and published chapter guides, cited; never the book&apos;s text. Searches send
          the book and chapter titles to the search provider; your notes and answers are never searched.
        </InfoHint>
      </div>
      <p className="mt-1 font-mono text-[13px] text-text-secondary">
        {mode === "more" ? `${capDollars(more)} more · cap ${capDollars(cap)}` : `About ${estimateDollars(est)} · cap ${capDollars(cap)}`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-disabled={saving || undefined}
          onClick={() => void turnOn()}
          className={`inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-[15px] font-medium text-on-accent ${saving ? "opacity-60" : ""}`}
        >
          {mode === "more" ? `Allow ${capDollars(more)} more` : "Turn on"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="inline-flex min-h-11 items-center px-3 text-[14px] text-text-secondary">
            Cancel
          </button>
        )}
        {saving && (
          <span role="status" className="text-[12px] text-text-secondary">
            Saving
          </span>
        )}
      </div>
      {message && (
        <p role="alert" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-text-primary">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-down" />
          <span>
            <strong className="font-medium">Not turned on:</strong> {message}
          </span>
        </p>
      )}
    </section>
  );
}
