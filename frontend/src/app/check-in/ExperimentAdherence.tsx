"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, FlaskConical } from "lucide-react";
import { ADHERENCE_ANSWERS, ADHERENCE_NOTE_MAX, isAdherenceDay, type AdherenceAnswer, type AdherenceDay } from "@/lib/experiments";

// The N-of-1 trial question on the check-in, "Followed today's arm?" (docs/experiment-framework.md 4.5).
// - Shown only while a trial runs (GET /api/experiments/adherence answers "open"); with no trial, which is
//   the usual case, it renders nothing. It loads on its own and never delays the habit questions.
// - Only for an arm Today has already shown ("not_revealed" asks to open Today first), so the check-in
//   can never reveal an arm. Today, or yesterday when answered the next morning.
// - Each tap saves at once through POST /api/experiments/adherence (not part of the Save bar), and the
//   answer goes to the experiment tables, never to the habit journal.

const LABEL: Record<AdherenceAnswer, string> = { yes: "Yes", partly: "Partly", no: "No" };
const url = (date: string) => `/api/experiments/adherence?date=${date}`;

function answerStyle(selected: boolean): string {
  return selected ? "bg-accent/20 border-accent/70 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-secondary";
}

export default function ExperimentAdherence({ date, when }: { date: string; when: "today" | "yesterday" }) {
  const [day, setDay] = useState<AdherenceDay | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const current = ++seq.current;
    setDay(null);
    setLoadFailed(false);
    setError(null);
    setSaved(false);
    fetch(url(date), { cache: "no-store" })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok || !isAdherenceDay(json)) throw new Error("unavailable");
        return json;
      })
      .then((value) => {
        if (seq.current !== current) return;
        setDay(value);
        setNote(value.status === "open" ? value.note ?? "" : "");
      })
      .catch(() => { if (seq.current === current) setLoadFailed(true); });
  }, [date]);

  const send = async (answer: AdherenceAnswer) => {
    if (!day || day.status !== "open" || saving) return;
    const current = seq.current;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/experiments/adherence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, answer, note: note.trim() || null }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (seq.current !== current) return;
      const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const state = res.status === 409 ? body.state : json;
      if (res.ok && isAdherenceDay(state) && state.status === "open") {
        setDay(state);
        setNote(state.note ?? "");
        setSaved(true);
      } else if (res.status === 409 && isAdherenceDay(state)) {
        // The day closed meanwhile (06:00 the day after, or the trial was paused): show its real state.
        setDay(state);
        setError("There is no trial question to answer for this day.");
      } else {
        setError("Couldn't save the answer. Try again.");
      }
    } catch {
      if (seq.current === current) setError("Couldn't reach Onyx. Try again.");
    } finally {
      if (seq.current === current) setSaving(false);
    }
  };

  if (loadFailed) {
    return (
      <section aria-label="Trial question" className="mb-6">
        <p className="text-[12px] text-down">Couldn&apos;t check for a trial question. Reload to try again.</p>
      </section>
    );
  }
  if (!day || day.status === "none" || day.status === "not_connected") return null;

  const whose = when === "today" ? "today's" : "yesterday's";
  if (day.status === "not_revealed") {
    return (
      <section aria-label="Trial question" className="mb-6 rounded-control border border-border-subtle bg-surface-card px-3 py-2.5">
        <p className="text-[13px] text-text-secondary">
          {day.experimentId}: <Link href="/today" className="text-accent underline underline-offset-2">open Today</Link> to see {whose} arm, then answer here.
        </p>
      </section>
    );
  }

  const noteChanged = (note.trim() || null) !== day.note;
  return (
    <section aria-labelledby="trial-question" className="mb-6">
      <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2 inline-flex items-center gap-1.5">
        <FlaskConical aria-hidden="true" className="w-3.5 h-3.5" /> Trial · {day.experimentId} · day {day.dayNumber} of {day.nDays}
      </h3>
      <div className="rounded-control border border-border-subtle bg-surface-card px-3 py-2.5">
        <p id="trial-question" className="text-[14px] text-text-primary leading-snug">Followed {whose} arm?</p>
        <p className="text-[12px] text-text-tertiary mt-0.5 break-words">Arm {day.arm}: {day.instruction}</p>
        <div className="mt-2 flex gap-1.5" role="group" aria-label={`Followed ${whose} arm?`}>
          {ADHERENCE_ANSWERS.map((a) => (
            <button
              key={a}
              onClick={() => send(a)}
              disabled={saving}
              aria-pressed={day.answer === a}
              className={`h-11 min-w-16 px-3 rounded-control border text-[13px] font-medium transition-colors disabled:opacity-60 ${answerStyle(day.answer === a)}`}
            >
              {LABEL[a]}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => { setNote(e.target.value.slice(0, ADHERENCE_NOTE_MAX)); setSaved(false); }}
          maxLength={ADHERENCE_NOTE_MAX}
          rows={2}
          aria-label="Trial note (optional)"
          placeholder="Note (optional)"
          className="mt-2 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[13px] text-text-primary"
        />
        <div className="mt-1 flex items-center gap-3 min-h-6 text-[12px]">
          {day.answer && noteChanged && (
            <button onClick={() => send(day.answer!)} disabled={saving} className="min-h-11 px-3 rounded-control border border-border-subtle text-text-secondary disabled:opacity-60">
              Save note
            </button>
          )}
          {saving ? <span role="status" className="text-text-tertiary">Saving…</span>
            : error ? <span role="alert" className="text-down">{error}</span>
            : saved ? <span role="status" className="text-text-secondary inline-flex items-center gap-1"><Check className="w-3.5 h-3.5 text-up" /> Saved</span>
            : !day.answer ? <span role="status" className="text-text-tertiary">Saved as you tap.</span>
            : null}
        </div>
      </div>
    </section>
  );
}
