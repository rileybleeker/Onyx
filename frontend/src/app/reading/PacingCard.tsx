"use client";

import { useState } from "react";
import Link from "next/link";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { saveRequest } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";
import { UI_PREFS_PATH } from "@/lib/ui-preferences";
import type { ReadingOverview } from "@/lib/reading";
import {
  GOAL_MAX,
  SESSIONS_PER_WEEK,
  SESSION_MINUTES,
  actionHref,
  actionText,
  addDays,
  isPaused,
  isYmd,
  nextAction,
  prefsBody,
  prefsError,
  samePrefs,
  weekLine,
  type LearningPrefs,
} from "@/lib/learning-pacing";
import type { LearningPrefsState } from "@/lib/use-learning-prefs";

/**
 * Voluntary pacing (PROD-T06): one chosen goal, a weekly rhythm, a pause, the low-energy choice and whether XP /
 * streak / level / deadline furniture shows. The settings save themselves (lib/autosave.ts); opening the page
 * writes nothing. Rules and copy: lib/learning-pacing.ts (rest is fine, nothing is ever "behind" or "overdue").
 */
export default function PacingCard({ o, prefsState, accept }: { o: ReadingOverview; prefsState: LearningPrefsState; accept: (raw: unknown) => void }) {
  const [low, setLow] = useState(false);
  const { load, prefs, configured } = prefsState;
  const book = { title: o.book.title, status: o.book.status, chaptersDone: o.chaptersDone, totalChapters: o.totalChapters };
  const action = nextAction({ prefs, configured, today: o.today, sessionDates: o.sessions.map((s) => s.session_date), dueReviews: o.dueReviews.length, book, lowEnergy: low });
  const week = weekLine({ prefs, configured, today: o.today, sessionDates: o.sessions.map((s) => s.session_date) });
  const text = actionText(action);

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" aria-labelledby="pacing-heading" data-testid="reading-pacing">
      <h3 id="pacing-heading" className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary">Your pace</h3>
      {prefs.goal && <p className="mt-1.5 text-sm text-text-primary">{prefs.goal}</p>}
      {text ? (
        <p className="mt-1.5 text-sm text-text-secondary">
          {text}
          {(action.kind === "review" || action.kind === "read") && (
            <> <Link href={actionHref(action)} className="text-accent underline underline-offset-2">Open</Link></>
          )}
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-text-secondary">Nothing suggested. Rest is fine.</p>
      )}
      {week && <p className="mt-1 text-[12px] font-mono text-text-tertiary">{week}</p>}
      {(action.kind === "review" || action.kind === "read" || (low && action.kind === "none")) && (
        <button
          type="button"
          onClick={() => setLow((v) => !v)}
          aria-pressed={low}
          className={`mt-2 min-h-11 rounded-control border px-3 text-[13px] ${low ? "border-accent/60 text-accent" : "border-border-subtle text-text-secondary hover:text-text-primary"}`}
        >
          Low energy today
        </button>
      )}
      <details className="mt-3 border-t border-border-subtle pt-2">
        <summary className="min-h-11 cursor-pointer py-2 text-[13px] text-text-secondary">Pacing settings</summary>
        {load === "loading" && <p className="mt-2 text-sm text-text-tertiary">Loading your settings…</p>}
        {load === "error" && <p className="mt-2 text-sm text-mid">Couldn&apos;t read your pacing settings, so they can&apos;t be changed right now. Reload to try again.</p>}
        {load === "ready" && <PacingEditor initial={prefs} today={o.today} accept={accept} />}
      </details>
    </section>
  );
}

function PacingEditor({ initial, today, accept }: { initial: LearningPrefs; today: string; accept: (raw: unknown) => void }) {
  const [draft, setDraft] = useState<LearningPrefs>(initial);
  const auto = useAutosave<LearningPrefs>(
    "reading-pacing",
    {
      save: async (v, ctx) => {
        accept(await saveRequest(UI_PREFS_PATH, { method: "PUT", body: prefsBody(v), keepalive: ctx.keepalive }));
      },
      ready: (v) => prefsError(v, today),
      same: samePrefs,
    },
    initial,
  );
  const set = (patch: Partial<LearningPrefs>, now = false) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    auto.change(next, now ? { delayMs: 0 } : undefined);
  };
  const paused = isPaused(draft, today);
  const field = "min-h-11 rounded-control border border-border-subtle bg-surface-sunken px-2 text-base text-text-primary";
  return (
    <div className="mt-2 space-y-3">
      <label className="block text-[12px] text-text-secondary">
        One goal (optional)
        <input
          type="text"
          value={draft.goal}
          maxLength={GOAL_MAX}
          onChange={(e) => set({ goal: e.target.value })}
          onBlur={() => void auto.flush()}
          className={`${field} mt-1 w-full`}
          placeholder="For example: understand the second half well enough to explain it"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-[12px] text-text-secondary">
          Sessions a week
          <select value={draft.weeklySessions} onChange={(e) => set({ weeklySessions: Number(e.target.value) }, true)} className={`${field} mt-1 block`}>
            {SESSIONS_PER_WEEK.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-text-secondary">
          Minutes each
          <select value={draft.sessionMinutes} onChange={(e) => set({ sessionMinutes: Number(e.target.value) }, true)} className={`${field} mt-1 block`}>
            {SESSION_MINUTES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="text-[12px] text-text-secondary">
        {paused ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>Paused through {draft.pauseUntil}. Nothing is suggested.</span>
            <button type="button" onClick={() => set({ pauseUntil: null }, true)} className="min-h-11 rounded-control border border-border-subtle px-3 text-text-primary">Resume</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" onClick={() => set({ pauseUntil: addDays(today, 6) }, true)} className="min-h-11 rounded-control border border-border-subtle px-3 text-text-primary">Pause for a week</button>
            <label>
              Pause through
              <input
                type="date"
                min={today}
                value={draft.pauseUntil ?? ""}
                onChange={(e) => { const v = e.target.value; if (v === "") set({ pauseUntil: null }, true); else if (isYmd(v)) set({ pauseUntil: v }, true); }}
                className={`${field} mt-1 block`}
              />
            </label>
          </div>
        )}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-[13px] text-text-primary">
        <input type="checkbox" checked={draft.showIncentives} onChange={(e) => set({ showIncentives: e.target.checked }, true)} className="h-5 w-5" />
        Show XP, level, streak, badges and deadline pace
      </label>
      <AutosaveStatus state={auto.state} onRetry={() => void auto.retry()} showIncomplete />
    </div>
  );
}
