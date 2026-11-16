"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import WindDownPanel from "@/components/sleep/WindDownPanel";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { SLEEP_QUESTIONS } from "@/lib/checkin";
import {
  DEFAULT_WINDOW_NIGHTS,
  DEFAULT_WINS_NEEDED,
  MAX_WINDOW_NIGHTS,
  MIN_WINDOW_NIGHTS,
  addDays,
  clockLabel,
  isTime,
  questionOf,
  shortDate,
  sortRules,
  windDownProgress,
  type WindDownPayload,
} from "@/lib/sleep-winddown";
import { addPause, endPause, reloadWindDown, saveGoal, setWindDownHidden, useWindDown, type GoalInput } from "@/lib/use-winddown";
import { LogCard, SectionSkeleton } from "./ui";

/**
 * /log Wind-down (PROD-SLEEP-01, Riley chose progress and streaks). Opt-in: until a goal is set up this section is
 * one short card, and Today shows nothing. Set up = Riley picks the habit that means "I started winding down" (an
 * existing Notion habit, so the check-in, /habits and this button all write ONE record per night) and a target time;
 * no bedtime is suggested or assumed. The panel above the settings is the same one Today shows.
 *
 * Goal changes, pauses and hiding are explicit buttons, not autosave (AGENTS.md "Input saves itself" exception): a
 * goal version is append-only history and a pause is a deliberate act, so a half-typed value must never land.
 */

const HABITS_URL = "/api/habits/list";
type HabitOption = { id: string; name: string; category: string };
function asHabits(raw: unknown): HabitOption[] | null {
  const v = raw as { habits?: { id?: unknown; name?: unknown; category?: unknown; active?: unknown }[] } | null;
  if (!v || !Array.isArray(v.habits)) return null;
  return v.habits
    .filter((h) => typeof h.id === "string" && typeof h.name === "string" && h.name && h.active !== false && !SLEEP_QUESTIONS.has(h.name))
    .map((h) => ({ id: h.id as string, name: h.name as string, category: typeof h.category === "string" ? h.category : "" }));
}

const field = "min-h-11 rounded-control border border-border-default bg-surface-raised px-3 text-[16px] md:text-[14px] text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
const primary = "min-h-11 px-5 rounded-full text-[14px] font-semibold bg-accent text-on-accent disabled:opacity-40";
const secondary = "min-h-11 inline-flex items-center rounded-control border border-border-subtle px-3 text-[13px] text-text-primary hover:border-border-hover disabled:opacity-40";

function GoalForm({ payload, onDone }: { payload: WindDownPayload; onDone?: () => void }) {
  const current = payload.rules.length ? sortRules(payload.rules)[payload.rules.length - 1] : null;
  const [habits, setHabits] = useState<HabitOption[] | null>(() => asHabits(clientCache.peek(HABITS_URL)));
  const [habitsFailed, setHabitsFailed] = useState(false);
  const [habitId, setHabitId] = useState(current?.habitPageId ?? "");
  const [time, setTime] = useState(current?.targetTime ?? "");
  const [wins, setWins] = useState(current?.winsNeeded ?? DEFAULT_WINS_NEEDED);
  const [nights, setNights] = useState(current?.windowNights ?? DEFAULT_WINDOW_NIGHTS);
  const snap = useWindDown();
  useEffect(() => {
    let alive = true;
    cachedJson(HABITS_URL, { check: (raw) => { if (!asHabits(raw)) throw new Error("unexpected habits answer"); } })
      .then((raw) => { if (alive) setHabits(asHabits(raw)); })
      .catch(() => { if (alive) setHabitsFailed(true); });
    return () => { alive = false; };
  }, []);
  const valid = !!habitId && isTime(time) && Number.isInteger(nights) && nights >= MIN_WINDOW_NIGHTS && nights <= MAX_WINDOW_NIGHTS && Number.isInteger(wins) && wins >= 1 && wins <= nights;
  const unchanged = !!current && current.habitPageId === habitId && current.targetTime === time && current.winsNeeded === wins && current.windowNights === nights;
  const options = habits ?? [];
  const knownCurrent = current && !options.some((h) => h.id === current.habitPageId)
    ? [{ id: current.habitPageId, name: questionOf(current, payload.habitNames), category: "" }] : [];
  const submit = async () => {
    if (!valid || unchanged) return;
    const goal: GoalInput = { habitPageId: habitId, targetTime: time, winsNeeded: wins, windowNights: nights };
    if (await saveGoal(goal)) onDone?.();
  };
  return (
    <div className="space-y-3">
      <label className="block text-[13px] text-text-secondary">The habit that means you started winding down
        <select value={habitId} onChange={(e) => setHabitId(e.target.value)} className={`${field} mt-1 w-full`}>
          <option value="">{habits ? "Choose a habit" : habitsFailed ? "Couldn't load your habits" : "Loading habits…"}</option>
          {[...knownCurrent, ...options].map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      </label>
      {habitsFailed && !habits && <p className="text-[12px] text-mid">Couldn&apos;t load your habits. <button type="button" className="underline underline-offset-4" onClick={() => { setHabitsFailed(false); clientCache.remove(HABITS_URL); cachedJson(HABITS_URL).then((raw) => setHabits(asHabits(raw))).catch(() => setHabitsFailed(true)); }}>Try again</button></p>}
      <p className="text-[12px] text-text-tertiary">Habits are kept in Notion; add one there if none fits. Sleep questions (answered for the night after) are not offered.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[13px] text-text-secondary">Target time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${field} mt-1 block`} />
        </label>
        <label className="text-[13px] text-text-secondary">Wins needed
          <input type="number" inputMode="numeric" min={1} max={nights} value={wins} onChange={(e) => setWins(Math.round(Number(e.target.value)))} className={`${field} mt-1 block w-20`} />
        </label>
        <label className="text-[13px] text-text-secondary">of nights
          <input type="number" inputMode="numeric" min={MIN_WINDOW_NIGHTS} max={MAX_WINDOW_NIGHTS} value={nights} onChange={(e) => setNights(Math.round(Number(e.target.value)))} className={`${field} mt-1 block w-20`} />
        </label>
      </div>
      <p className="text-[12px] text-text-tertiary">{DEFAULT_WINS_NEEDED} of {DEFAULT_WINDOW_NIGHTS} is a starting target you can change, not a medical threshold. A change applies from tonight; earlier nights keep the goal they had.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void submit()} disabled={!valid || unchanged || snap.busy === "rule"} className={primary}>
          {snap.busy === "rule" ? "Saving…" : current ? "Save from tonight" : "Start the streak"}
        </button>
        {onDone && <button type="button" onClick={onDone} className={secondary}>Cancel</button>}
      </div>
    </div>
  );
}

function Pauses({ payload }: { payload: WindDownPayload }) {
  const snap = useWindDown();
  const today = payload.today;
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState("");
  const running = payload.pauses.filter((p) => p.startDate <= today && (p.endDate === null || p.endDate >= today));
  const planned = payload.pauses.filter((p) => p.startDate > today);
  const past = payload.pauses.filter((p) => p.endDate !== null && p.endDate < today).slice(-3).reverse();
  const valid = start >= today && (!end || end >= start);
  return (
    <div className="space-y-2">
      <h4 className="text-[13px] font-medium text-text-primary">Pause</h4>
      <p className="text-[12px] text-text-tertiary">For travel or illness: paused nights are shown as paused and left out of every count. A pause starts tonight or later.</p>
      {[...running, ...planned].map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-2 text-[13px] text-text-primary">
          <span>{p.startDate <= today ? "Paused" : "Planned"} {shortDate(p.startDate)}{p.endDate ? ` to ${shortDate(p.endDate)}` : " until you resume"}</span>
          <button type="button" onClick={() => void endPause(p.id)} disabled={snap.busy === "pause"} className={secondary}>{p.startDate <= today ? "Resume tonight" : "Cancel"}</button>
        </div>
      ))}
      {!running.length && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[13px] text-text-secondary">From
            <input type="date" min={today} value={start} onChange={(e) => setStart(e.target.value)} className={`${field} mt-1 block`} />
          </label>
          <label className="text-[13px] text-text-secondary">Through (optional)
            <input type="date" min={start || today} value={end} onChange={(e) => setEnd(e.target.value)} className={`${field} mt-1 block`} />
          </label>
          <button type="button" onClick={() => void addPause(start, end || null).then((ok) => { if (ok) setEnd(""); })} disabled={!valid || snap.busy === "pause"} className={secondary}>
            {snap.busy === "pause" ? "Saving…" : "Pause"}
          </button>
        </div>
      )}
      {past.length > 0 && <p className="text-[12px] text-text-tertiary">Earlier: {past.map((p) => `${shortDate(p.startDate)} to ${shortDate(p.endDate as string)}`).join("; ")}.</p>}
    </div>
  );
}

function History({ payload }: { payload: WindDownPayload }) {
  const rules = sortRules(payload.rules).reverse();
  return (
    <div>
      <h4 className="text-[13px] font-medium text-text-primary">Goal history</h4>
      <ul className="mt-1 space-y-1 text-[12px] text-text-secondary">
        {rules.map((r) => (
          <li key={r.id}>From {shortDate(r.effectiveFrom)}: {r.habitName} by {clockLabel(r.targetTime)}, {r.winsNeeded} of {r.windowNights} nights{r.tz ? ` (set in ${r.tz})` : ""}.</li>
        ))}
      </ul>
    </div>
  );
}

export default function WindDownSection() {
  const s = useWindDown();
  const [editing, setEditing] = useState(false);
  if (!s.payload) {
    if (s.load === "error") {
      return (
        <LogCard title="Wind-down">
          <p className="text-[13px] text-text-secondary">Couldn&apos;t check your wind-down streak. <button type="button" className="underline underline-offset-4" onClick={() => void reloadWindDown()}>Try again</button></p>
        </LogCard>
      );
    }
    return <SectionSkeleton section="winddown" />;
  }
  const p = s.payload;
  if (p.status === "not_connected") {
    return <LogCard title="Wind-down"><p className="text-[13px] text-text-secondary">The wind-down streak isn&apos;t set up on the server yet.</p></LogCard>;
  }
  if (p.status === "not_set_up") {
    return (
      <LogCard title="Wind-down">
        {!editing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-text-secondary">Optional: count the nights you start winding down by a time you choose.</p>
            <button type="button" onClick={() => setEditing(true)} className={secondary}>Set up</button>
          </div>
        ) : <GoalForm payload={p} onDone={() => setEditing(false)} />}
        {s.actionError && <p role="alert" className="mt-2 text-[12px] text-mid">{s.actionError}</p>}
      </LogCard>
    );
  }
  if (p.hidden) {
    return (
      <LogCard title="Wind-down">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-text-secondary">Hidden from Today. Your nights are still recorded by the habit.</p>
          <button type="button" onClick={() => void setWindDownHidden(false)} disabled={s.busy === "hidden"} className={secondary}>Show again</button>
        </div>
        {s.actionError && <p role="alert" className="mt-2 text-[12px] text-mid">{s.actionError}</p>}
      </LogCard>
    );
  }
  const progress = windDownProgress(p);
  return (
    <div className="rounded-card border border-border-subtle bg-surface-card shadow-card p-4">
      <WindDownPanel surface="log" />
      <details className="mt-4 border-t border-border-subtle pt-3" open={editing || undefined}>
        <summary className="min-h-11 cursor-pointer text-[13px] text-text-primary">Goal, pauses and history</summary>
        <div className="mt-3 space-y-5">
          <div>
            <h4 className="mb-2 text-[13px] font-medium text-text-primary">Goal</h4>
            <GoalForm key={progress.rule?.id ?? 0} payload={p} />
          </div>
          <Pauses payload={p} />
          <History payload={p} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void setWindDownHidden(true)} disabled={s.busy === "hidden"} className={secondary}>Hide from Today</button>
            <Link href="/habits" className="text-[13px] text-text-secondary underline underline-offset-4 hover:text-accent">See the habit on Habits</Link>
          </div>
          {progress.openNights.length === 0 && p.today && <p className="text-[12px] text-text-tertiary">Nights before {shortDate(addDays(p.today, -2))} are corrected on Habits.</p>}
        </div>
      </details>
      {s.actionError && <p role="alert" className="mt-2 text-[12px] text-mid">{s.actionError}</p>}
    </div>
  );
}
