"use client";

/**
 * The wind-down streak panel (PROD-SLEEP-01), the SAME on Today and on Log: the goal, tonight's one action, the
 * last nights as a strip, wins against the goal, the current streak and personal best, the nights that can still be
 * answered, and a next-morning sleep line (feedback only). Data and writes: lib/use-winddown.ts (one store per page);
 * rules: lib/sleep-winddown.ts. Renders nothing until the goal is set up on Log, and nothing on Today when hidden.
 * Opening, scrolling or reading this panel writes nothing; only a tap does.
 */

import Link from "next/link";
import { Check, CircleDashed, CircleQuestionMark, Moon, Pause, X } from "lucide-react";
import {
  NIGHT_STATUS_LABEL,
  WINDDOWN_ANSWER_DAYS_BACK,
  addDays,
  clockLabel,
  durationLabel,
  nightName,
  nightWeekday,
  offerMatchesShown,
  shortDate,
  sleepFeedback,
  undoApplies,
  windDownAttention,
  windDownProgress,
  windowSummary,
  type NightView,
  type WindDownProgress,
} from "@/lib/sleep-winddown";
import { answerNight, dismissTap, resolveRecovery, retryNow, undoLast, useWindDown, type WindDownSnapshot } from "@/lib/use-winddown";
import type { SourceProbe } from "@/lib/today-attention";
import type { WindDownAttention } from "@/lib/sleep-winddown";

const primary = "min-h-11 inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 text-[14px] font-semibold text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";
const secondary = "min-h-11 inline-flex items-center justify-center rounded-control border border-border-subtle px-3 text-[13px] text-text-primary hover:border-border-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const textButton = "min-h-11 inline-flex items-center px-2 text-[13px] text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent";

function ago(ms: number | null, now: number): string | null {
  if (!ms) return null;
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

function NightMark({ night }: { night: NightView }) {
  const base = "flex h-9 w-9 items-center justify-center rounded-control border";
  switch (night.status) {
    case "win": return <span className={`${base} border-up/40 bg-up/15 text-up`}><Check className="h-4 w-4" aria-hidden="true" /></span>;
    case "missed": return <span className={`${base} border-border-default text-text-secondary`}><X className="h-4 w-4" aria-hidden="true" /></span>;
    case "pending": return <span className={`${base} border-dashed border-border-default text-text-tertiary`}><CircleDashed className="h-4 w-4" aria-hidden="true" /></span>;
    case "unknown": return <span className={`${base} border-dashed border-border-subtle text-text-tertiary`}><CircleQuestionMark className="h-4 w-4" aria-hidden="true" /></span>;
    default: return <span className={`${base} border-border-subtle text-text-tertiary`}><Pause className="h-4 w-4" aria-hidden="true" /></span>;
  }
}

function nightText(n: NightView): string {
  const start = n.start ? `, started ${clockLabel(n.start.localTime)}${n.start.onTime === true ? " (on time)" : n.start.onTime === false ? " (after the target)" : ""}` : "";
  return `${shortDate(n.date)}: ${NIGHT_STATUS_LABEL[n.status]}${start}`;
}

function Strip({ p }: { p: WindDownProgress }) {
  const w = p.window;
  if (!w) return null;
  return (
    <ol aria-label={`The last ${w.size} nights`} className="mt-3 flex flex-wrap items-end gap-1.5">
      {w.items.map((it) => it.kind === "paused" ? (
        <li key={`p-${it.from}`} className="flex flex-col items-center gap-1" title={`Paused ${shortDate(it.from)}${it.count > 1 ? ` to ${shortDate(it.to)}` : ""}`}>
          <span className="text-[10px] font-mono text-text-tertiary">{it.count > 1 ? `${it.count}×` : nightWeekday(it.from)}</span>
          <span className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-control border border-border-subtle px-1.5 text-text-tertiary"><Pause className="h-4 w-4" aria-hidden="true" /></span>
          <span className="sr-only">{it.count > 1 ? `${it.count} nights paused, ${shortDate(it.from)} to ${shortDate(it.to)}: not counted` : `${shortDate(it.from)}: paused, not counted`}</span>
        </li>
      ) : (
        <li key={it.night.date} className="flex flex-col items-center gap-1" title={nightText(it.night)}>
          <span className={`text-[10px] font-mono ${it.night.tonight ? "text-text-primary" : "text-text-tertiary"}`} aria-hidden="true">{it.night.tonight ? "Tonight" : nightWeekday(it.night.date)}</span>
          <NightMark night={it.night} />
          <span className="sr-only">{nightText(it.night)}</span>
        </li>
      ))}
    </ol>
  );
}

export function SaveLine({ s, p }: { s: WindDownSnapshot; p: WindDownProgress }) {
  const st = s.saver;
  if (st.status === "saving") return <p role="status" className="mt-2 text-[12px] text-text-tertiary">Saving…</p>;
  if (st.status === "cancelling") return <p role="status" className="mt-2 text-[12px] text-text-tertiary">Checking whether it was saved…</p>;
  if (st.status === "retrying") {
    // The tap was sent and never answered: it may already be saved. Cancel asks the server and shows what it holds.
    // (Fixed copy only: st.error can carry the server's sentence, so it is never shown here.)
    return (
      <div role="status" className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-mid">
        <span>Not confirmed yet. It may already be saved. Trying again.</span>
        <button type="button" onClick={retryNow} className={textButton}>Retry now</button>
        <button type="button" onClick={dismissTap} className={textButton}>Cancel and check</button>
      </div>
    );
  }
  if (st.status === "refused") {
    return (
      <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-mid">
        <span>{st.error}</span>
        <button type="button" onClick={dismissTap} className={textButton}>OK</button>
      </div>
    );
  }
  const last = s.last;
  // Undo while that night can still be answered here, is still under the goal version the tap answered and still
  // holds the answer the tap gave it (undoApplies). (Tonight's own Clear covers a tap that only answered tonight.)
  const undoable = !!last && undoApplies(last, s.payload) && last.night <= p.today && last.night >= addDays(p.today, -WINDDOWN_ANSWER_DAYS_BACK)
    && currentAnswer(p, last.night) === last.answer && !(last.night === p.today && last.previous === null);
  if (st.status === "saved" || undoable || s.notice) {
    return (
      <div role="status" className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px]">
        {st.status === "saved" && <span className="inline-flex items-center gap-1 text-up"><Check size={13} aria-hidden="true" />Saved</span>}
        {s.notice && <span className="text-text-secondary">{s.notice}</span>}
        {undoable && <button type="button" onClick={undoLast} className={textButton}>Undo</button>}
      </div>
    );
  }
  return null;
}
/** The answer the panel shows for a night (tonight or a night in the strip), or null. */
function currentAnswer(p: WindDownProgress, night: string): string | null {
  if (p.tonight?.date === night) return p.tonight.answer;
  for (const it of p.window?.items ?? []) if (it.kind === "night" && it.night.date === night) return it.night.answer;
  return null;
}

function Tonight({ p, saving }: { p: WindDownProgress; saving: boolean }) {
  const t = p.tonight;
  const rule = p.rule;
  if (!t || !rule) return null;
  if (t.status === "paused") {
    const end = p.pause?.endDate;
    return <p className="mt-3 text-[14px] text-text-primary">Paused tonight{end ? ` (until ${shortDate(end)})` : " (until you resume)"}. Paused nights are not counted.</p>;
  }
  // Tonight's answer can be cleared here (it is the same record the check-in shows); it is open again then.
  const clear = <button type="button" onClick={() => answerNight(t.date, null)} disabled={saving} aria-label="Clear tonight's answer" className={textButton}>Clear</button>;
  if (t.status === "win") {
    return (
      <p className="mt-3 inline-flex flex-wrap items-center gap-1.5 text-[14px] text-text-primary">
        <Check className="h-4 w-4 text-up" aria-hidden="true" />
        {t.start ? `Started ${clockLabel(t.start.localTime)}${t.start.onTime === true ? ", on time" : t.start.onTime === false ? ", after the target" : ""}.` : "Done tonight."}
        {clear}
      </p>
    );
  }
  if (t.status === "missed") {
    // A "No" can be recorded before the evening happened (the check-in's "No for the other N"): it can be changed here.
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[14px] text-text-secondary">Tonight is recorded as not done.</span>
        <button type="button" onClick={() => answerNight(t.date, "Yes")} disabled={saving} className={secondary}>I did wind down</button>
        {clear}
      </div>
    );
  }
  if (t.status !== "pending") return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => answerNight(t.date, "Yes")} disabled={saving} className={primary}>
        <Moon className="h-4 w-4" aria-hidden="true" />I started winding down
      </button>
      <span className="text-[12px] text-text-secondary">Target {clockLabel(rule.targetTime)}</span>
    </div>
  );
}

function OpenNights({ p, saving }: { p: WindDownProgress; saving: boolean }) {
  if (!p.openNights.length) return null;
  return (
    <ul aria-label="Nights you can still answer" className="mt-3 space-y-2">
      {p.openNights.map((n) => (
        <li key={n.date} className="flex flex-wrap items-center gap-2">
          <span className="min-w-28 text-[13px] text-text-primary">{nightName(n.date, p.today)}</span>
          <button type="button" onClick={() => answerNight(n.date, "Yes")} disabled={saving} className={secondary} aria-label={`${nightName(n.date, p.today)}: I wound down`}>Did it</button>
          <button type="button" onClick={() => answerNight(n.date, "No")} disabled={saving} className={secondary} aria-label={`${nightName(n.date, p.today)}: I didn't`}>Didn&apos;t</button>
        </li>
      ))}
    </ul>
  );
}

function SleepLine({ s, now }: { s: WindDownSnapshot; now: number }) {
  if (!s.payload) return null;
  const f = sleepFeedback(s.payload);
  const synced = f.newestSync ? ago(Date.parse(f.newestSync), now) : null;
  return (
    <div className="mt-4 border-t border-border-subtle pt-3 text-[12px] text-text-secondary">
      {f.failed ? <p>Couldn&apos;t read WHOOP sleep right now.</p> : f.lastNight ? (
        <p>
          Last night (WHOOP): {f.lastNight.asleepMin != null ? `${durationLabel(f.lastNight.asleepMin)} asleep` : "time asleep not known"}
          {f.lastNight.onset ? `, fell asleep ${clockLabel(f.lastNight.onset)}` : ""}{synced ? ` · synced ${synced}` : ""}.
        </p>
      ) : <p>No WHOOP sleep for last night yet.</p>}
      {f.onsetRange && <p className="mt-0.5">Past week: fell asleep between {clockLabel(f.onsetRange.earliest)} and {clockLabel(f.onsetRange.latest)} ({f.onsetRange.nights} nights).</p>}
      <p className="mt-0.5 text-text-tertiary">Feedback only: sleep data never marks a night or changes the streak.</p>
    </div>
  );
}

function Recovery({ s }: { s: WindDownSnapshot }) {
  const r = s.recovery;
  const p = s.payload;
  if (!r && s.recoveryChecking) {
    return <p role="status" className="mt-3 text-[13px] text-text-secondary">Checking a tap from earlier that wasn&apos;t confirmed…</p>;
  }
  if (!r || !p) return null;
  const what = r.answer === "Yes" ? "wound down" : r.answer === "No" ? "not done" : "cleared";
  // The night already shows this answer (set somewhere else, or this tap landed and its answer was lost): the tap may
  // still be on its way, so it is settled by its id (Confirm it / Discard) before any other tap for the night.
  const matches = offerMatchesShown(r);
  return (
    <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-control border border-border-subtle px-3 py-2 text-[13px] text-text-primary">
      <span>
        A tap for {nightName(r.night, p.today).toLowerCase()} ({what}) wasn&apos;t confirmed as saved.
        {matches ? " The night already shows that answer, but the tap may still be on its way." : ""}
      </span>
      <button type="button" onClick={() => resolveRecovery(true)} disabled={s.busy === "recovery"} className={textButton}>{matches ? "Confirm it" : "Save it"}</button>
      <button type="button" onClick={() => resolveRecovery(false)} disabled={s.busy === "recovery"} className={textButton}>{s.busy === "recovery" ? "Checking…" : "Discard"}</button>
      {s.actionError && <span role="alert" className="basis-full text-[12px] text-mid">{s.actionError}</span>}
    </div>
  );
}

export default function WindDownPanel({ surface, className = "" }: { surface: "today" | "log"; className?: string }) {
  const s = useWindDown();
  if (!s.payload || s.payload.status !== "ready") return null;
  if (surface === "today" && s.payload.hidden) return null;
  const p = windDownProgress(s.payload);
  const rule = p.rule;
  const w = p.window;
  if (!rule || !w) return null;
  const now = Date.now();
  // Log's sections are h2 under its h1; Today's panels are h3 under its section headings.
  const Heading = surface === "log" ? "h2" : "h3";
  // One unsaved tap at a time: while one is saving, waiting to retry, being checked or kept from an earlier visit, the
  // answer buttons wait (the line below them says why; Retry now / Cancel and check / Save it / Discard resolve it).
  const saving = s.saver.status === "saving" || s.saver.status === "retrying" || s.saver.status === "cancelling" || !!s.recovery || s.recoveryChecking;
  const checked = ago(s.at, now);
  const stopped = p.streak.current === 0 && p.streak.stoppedAt
    ? `Streak ended ${shortDate(p.streak.stoppedAt.date)}: ${p.streak.stoppedAt.status === "missed" ? "not done" : "not answered"}.`
    : null;
  return (
    <section aria-labelledby={`winddown-heading-${surface}`} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Heading id={`winddown-heading-${surface}`} className="inline-flex items-center gap-2 text-base font-semibold text-text-primary">
          <Moon className="h-5 w-5 text-text-secondary" aria-hidden="true" />Wind-down
        </Heading>
        <p className="text-[12px] text-text-secondary">
          {p.question} · by {clockLabel(rule.targetTime)} · goal {w.needed} of {w.size} nights
        </p>
      </div>
      <Tonight p={p} saving={saving} />
      <Recovery s={s} />
      <SaveLine s={s} p={p} />
      <Strip p={p} />
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
        <div><dt className="text-text-tertiary">This week</dt><dd className="font-mono text-[15px] text-text-primary">{w.wins}/{w.needed}</dd></div>
        <div><dt className="text-text-tertiary">Streak</dt><dd className="font-mono text-[15px] text-text-primary">{p.streak.current}</dd></div>
        <div><dt className="text-text-tertiary">Best</dt><dd className="font-mono text-[15px] text-text-primary">{p.streak.best}</dd></div>
      </dl>
      <p className="mt-2 text-[12px] text-text-secondary">
        {windowSummary(w)}{w.short ? " (just started)" : ""}{p.streak.pendingNights ? `. ${p.streak.pendingNights === 1 ? "1 night is" : `${p.streak.pendingNights} nights are`} still open` : ""}.
        {stopped ? ` ${stopped}` : ""} All time: {p.total.wins} of {p.total.decided} nights.
      </p>
      {p.milestone && <p className="mt-1 text-[13px] text-up">{p.milestone}</p>}
      {p.nextPause && <p className="mt-1 text-[12px] text-text-secondary">Pause planned from {shortDate(p.nextPause.startDate)}{p.nextPause.endDate ? ` to ${shortDate(p.nextPause.endDate)}` : ""}.</p>}
      <OpenNights p={p} saving={saving} />
      <SleepLine s={s} now={now} />
      <p className={`mt-2 text-[11px] ${s.refreshFailed ? "text-mid" : "text-text-tertiary"}`}>
        {s.refreshFailed ? `Couldn't refresh; showing the check from ${checked ?? "earlier"}.` : checked ? `Checked ${checked}.` : ""}
        {" "}The night is the habit&apos;s own answer (check-in and Habits show the same one).
        {surface === "today" && <> <Link href="/log#log-part-wind-down" className="underline underline-offset-4 hover:text-accent">Goal, pauses and history</Link></>}
      </p>
    </section>
  );
}
