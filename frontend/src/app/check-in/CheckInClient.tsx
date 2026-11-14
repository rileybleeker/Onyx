"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Moon, Sun, X } from "lucide-react";
import { agentsApi } from "@/lib/agents-api";
import { kitSummary, nightLabel, type CheckinAnswer, type CheckinItem, type CheckinNight, type CheckinPayload, type CheckinSuggestion } from "@/lib/checkin";
import { DeliveryDishList, useDeliveryDishes } from "@/components/DeliveryPortions";

// Daily habit check-in (2026-11-07). Yes / No per question, one Save.
// - Saved answers load as-is; questions another source can answer start pre-filled and labeled with that
//   source; everything else starts blank. Blank on save = not logged (never a "No").
// - Taps are kept as a local draft, so leaving the page (or the app being killed) loses nothing.
// - Two parts (2026-11-13, rules in lib/checkin.ts):
//     SLEEP   one block per night that already happened ("Last night", and the night before while it is
//             unanswered). It does not follow the day tabs and never asks about tonight. A night's answers
//             are saved on the behavior day that night closed (last night = yesterday), which is the night
//             the HRV pipeline scores them against. One "Usual kit" tap fills the kit questions with the
//             last answer given to each.
//     DAYTIME the day tabs (today and the two days before). Rarely-Yes questions sit in "Also did";
//             "No for the other N" answers every blank daytime question at once.
//   Kit and "No for the rest" are ordinary taps: drafted, then saved.
// - Save writes the day and each changed night (one request each), then tells the Agents chat the day is
//   done so the card settles.
// - Delivered Uber Eats restaurant dishes get one extra section, "how much did you eat?": every dish of the
//   day being checked in, plus dishes of the 2 days before whose portion was never set (the harvester runs
//   every 6 h, so a dinner delivered after the 21:30 card usually lands after that evening's check-in and is
//   asked the next evening). It loads on its own after the questions (never delays them), shows nothing when
//   there is nothing to ask, and each tap saves immediately through PATCH /api/delivery/items/[itemId]
//   (not part of the Save bar).

type Origin = "saved" | "suggested" | "tapped";
type Cell = { answer: CheckinAnswer; origin: Origin; source?: string };
type Cells = Record<string, Cell>;
/** Unsaved taps: an answer, or null for "cleared". Also the shape POSTed to /api/habits/checkin. */
type Patch = Record<string, CheckinAnswer | null>;

const CATEGORY_ORDER = ["health", "fitness", "nutrition", "mindfulness", "productivity", "social", "learning", "general"];
const dayDraftKey = (date: string) => `onyx:checkin:${date}`;
const nightDraftKey = (night: string) => `onyx:checkin:night:${night}`;

function readDraft(key: string): Patch {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Patch) : {};
  } catch {
    return {};
  }
}

function writeDraft(key: string, patch: Patch) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readDraft(key), ...patch }));
  } catch {
    /* storage unavailable: the in-memory state still works */
  }
}

/** After a save: drop from the draft only what was sent and is still unchanged, so a tap made mid-save survives. */
function settleDraft(key: string, posted: Patch) {
  try {
    const draft = readDraft(key);
    for (const [name, a] of Object.entries(posted)) if (draft[name] === a) delete draft[name];
    if (Object.keys(draft).length) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The server refused because the day rolled over since the page loaded: reload, don't keep the stale labels. */
class StaleDayError extends Error {}

/** Saved answers, then pre-fills for what is still blank, then the local draft on top. Only `items` are kept. */
function buildCells(
  items: CheckinItem[],
  saved: Record<string, CheckinAnswer>,
  suggestions: Record<string, CheckinSuggestion>,
  draft: Patch
): Cells {
  const next: Cells = {};
  for (const item of items) {
    const s = saved[item.name];
    const sug = suggestions[item.name];
    if (s) next[item.name] = { answer: s, origin: "saved" };
    else if (sug) next[item.name] = { answer: sug.answer, origin: "suggested", source: sug.source };
  }
  for (const [name, a] of Object.entries(draft)) {
    if (!items.some((i) => i.name === name)) continue;
    if (a === null) delete next[name];
    else if (a === "Yes" || a === "No") next[name] = { answer: a, origin: "tapped" };
  }
  return next;
}

/** What Save would change: every set answer that differs from what's stored, plus clears of stored answers. */
function changesOf(items: CheckinItem[], saved: Record<string, CheckinAnswer>, cells: Cells): Patch {
  const out: Patch = {};
  for (const item of items) {
    const stored = saved[item.name];
    const cur = cells[item.name]?.answer;
    if (cur && cur !== stored) out[item.name] = cur;
    if (!cur && stored) out[item.name] = null;
  }
  return out;
}

/** Sleep questions live in the night blocks; core ones are asked, occasional ones are an optional row there. */
const isNightItem = (i: CheckinItem) => i.sleep;
/** Reload when the app comes back after this long: "Last night" must never be a day old. */
const RELOAD_AFTER_MS = 60_000;

function dayLabel(date: string, today: string): string {
  const d = new Date(date + "T12:00:00Z");
  const t = new Date(today + "T12:00:00Z");
  const diff = Math.round((t.getTime() - d.getTime()) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
}

function longDate(date: string): string {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export default function CheckInClient() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("date");

  const [data, setData] = useState<CheckinPayload | null>(null);
  const [cells, setCells] = useState<Cells>({}); // the day tab's questions
  const [nightCells, setNightCells] = useState<Record<string, Cells>>({}); // sleep questions, per night
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const delivery = useDeliveryDishes(data?.date ?? null, { earlierDays: 2 });

  const lastLoad = useRef(0);
  const savingRef = useRef(false);

  const load = useCallback(async (date: string | null) => {
    lastLoad.current = Date.now();
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(`/api/habits/checkin${date ? `?date=${date}` : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Couldn't load the check-in (${res.status}).`);
        setData(null);
        return;
      }
      const payload = json as CheckinPayload;
      const day = buildCells(
        payload.items.filter((i) => !isNightItem(i)),
        payload.answers,
        payload.suggestions,
        readDraft(dayDraftKey(payload.date))
      );
      const sleepItems = payload.items.filter(isNightItem);
      const nights: Record<string, Cells> = {};
      for (const n of payload.nights ?? []) nights[n.date] = buildCells(sleepItems, n.answers, n.suggestions, readDraft(nightDraftKey(n.date)));
      setData(payload);
      setCells(day);
      setNightCells(nights);
      // Open "Also did" when it holds a saved or pre-filled answer, so nothing is saved out of sight.
      setShowExtras(payload.items.some((i) => i.group === "extra" && day[i.name]));
    } catch {
      setError("Couldn't reach Onyx. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    load(requested);
    // A page left open (or an installed app resumed) keeps the `today` it loaded with, so after the day rolls
    // over its "Last night" would be the night before. Reload on return; unsaved taps come back from the drafts.
    const back = () => {
      if (document.visibilityState === "visible" && !savingRef.current && Date.now() - lastLoad.current > RELOAD_AFTER_MS) load(requested);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
    };
  }, [load, requested]);

  // One or several answers at once. scope = null for the day tab, or the night's date for a sleep block.
  const apply = (scope: string | null, patch: Patch) => {
    if (!data || !Object.keys(patch).length) return;
    setSavedAt(null);
    const update = (prev: Cells): Cells => {
      const next = { ...prev };
      for (const [name, a] of Object.entries(patch)) {
        if (a === null) delete next[name];
        else next[name] = { answer: a, origin: "tapped" };
      }
      return next;
    };
    if (scope === null) {
      setCells(update);
      writeDraft(dayDraftKey(data.date), patch);
    } else {
      setNightCells((prev) => ({ ...prev, [scope]: update(prev[scope] ?? {}) }));
      writeDraft(nightDraftKey(scope), patch);
    }
  };

  // Tapping the active answer clears it.
  const tap = (scope: string | null, name: string, answer: CheckinAnswer) => {
    const cur = (scope === null ? cells : (nightCells[scope] ?? {}))[name];
    apply(scope, { [name]: cur?.answer === answer ? null : answer });
  };

  const { dayItems, sleepItems, core, extras, coreByCategory } = useMemo(() => {
    const items = data?.items ?? [];
    const sleepItems = items.filter(isNightItem);
    const dayItems = items.filter((i) => !isNightItem(i));
    const core = dayItems.filter((i) => i.group === "core");
    const extras = dayItems.filter((i) => i.group === "extra");
    const groups = new Map<string, CheckinItem[]>();
    for (const i of core) {
      const c = i.category || "general";
      groups.set(c, [...(groups.get(c) || []), i]);
    }
    const coreByCategory = [...groups.entries()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0]);
      const ib = CATEGORY_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return { dayItems, sleepItems, core, extras, coreByCategory };
  }, [data]);

  // Last night always; an earlier night only while its SAVED required answers are incomplete (so it doesn't vanish mid-tap).
  const nights = useMemo(
    () => (sleepItems.length ? (data?.nights ?? []).filter((n, i) => i === 0 || sleepItems.some((it) => it.group === "core" && !n.answers[it.name])) : []),
    [data, sleepItems]
  );

  const coreDone = core.filter((i) => cells[i.name]).length;
  const coreLeft = core.length - coreDone;
  const dayBlanks = core.filter((i) => !cells[i.name]);

  const dayChanges = useMemo(() => (data ? changesOf(dayItems, data.answers, cells) : {}), [data, dayItems, cells]);
  const nightChanges = useMemo(
    () =>
      nights
        .map((n) => ({ date: n.date, changes: changesOf(sleepItems, n.answers, nightCells[n.date] ?? {}) }))
        .filter((n) => Object.keys(n.changes).length > 0),
    [nights, sleepItems, nightCells]
  );
  // A day Riley has not touched is not saved along with a sleep save: its pre-fills can still change (a workout
  // later today), and saving them would mark the day's check-in done. With nothing else to save, Save means the day.
  const dayTouched = Object.entries(dayChanges).some(([name, a]) => a === null || cells[name]?.origin === "tapped");
  const dayPatch = dayTouched || nightChanges.length === 0 ? dayChanges : {};
  const nightCount = nightChanges.reduce((s, n) => s + Object.keys(n.changes).length, 0);
  const changeCount = Object.keys(dayPatch).length + nightCount;
  // Unsaved answers Riley tapped himself (as opposed to pre-fills waiting to be accepted).
  const tappedCount =
    Object.keys(dayChanges).filter((name) => dayChanges[name] === null || cells[name]?.origin === "tapped").length +
    nightChanges.reduce((s, n) => s + Object.keys(n.changes).filter((name) => n.changes[name] === null || nightCells[n.date]?.[name]?.origin === "tapped").length, 0);

  const save = async () => {
    if (!data || saving || changeCount === 0) return;
    setSaving(true);
    savingRef.current = true;
    setError(null);
    const post = async (date: string, answers: Patch) => {
      const res = await fetch("/api/habits/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, answers, today: data.today }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        if (res.status === 409 && json.stale) throw new StaleDayError(json.error || "A new day started since this page loaded.");
        throw new Error(json.error || `Save failed (${res.status}). Your answers are still here.`);
      }
    };
    try {
      // The day, then each night under ITS date. A part that saved is not lost if a later part fails: its
      // answers stay on screen and saving again just writes the same rows.
      if (Object.keys(dayPatch).length) {
        await post(data.date, dayPatch);
        settleDraft(dayDraftKey(data.date), dayPatch);
        // Settle the Agents card; best-effort (the card also expires on its own). Only when the day was saved.
        agentsApi.checkinDone(data.date).catch(() => {});
      }
      for (const n of nightChanges) {
        await post(n.date, n.changes);
        settleDraft(nightDraftKey(n.date), n.changes);
      }
      const date = data.date;
      await load(date);
      setSavedAt(date);
    } catch (e) {
      if (e instanceof StaleDayError) {
        // Redraw with the new day (taps come back from the drafts under their own dates), then say why.
        await load(requested);
        setError(e.message);
      } else {
        setError(e instanceof TypeError ? "Couldn't reach Onyx. Your answers are still here." : e instanceof Error ? e.message : "Save failed. Your answers are still here.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const goTo = (date: string) => {
    router.replace(`/check-in?date=${date}`, { scroll: false });
  };

  if (error && !data) {
    return (
      <div className="max-w-xl">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="mt-4 text-sm text-text-secondary">{error}</p>
        <button onClick={() => goTo(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }))} className="mt-4 px-3 py-1.5 text-[13px] bg-white/5 border border-border-subtle rounded-[6px]">
          Go to today
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-xl space-y-3">
        <div className="h-8 w-40 bg-white/5 animate-pulse rounded" />
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-12 bg-white/[0.03] animate-pulse rounded-[6px]" />
        ))}
      </div>
    );
  }

  const catchUp = data.days.find((d) => d.date !== data.date && d.date !== data.today && d.answered === 0);
  const dayName = dayLabel(data.date, data.today);

  return (
    <div className="max-w-xl">
      <div className="mb-5">
        <h2 className="text-[28px] font-medium text-text-primary">Check-in</h2>
        <p className="text-sm text-text-tertiary mt-0.5">
          {nights.length > 0
            ? `Two parts. Sleep: ${nightLabel(nights[0].date, data.today).span}. Daytime: ${dayName === "Today" || dayName === "Yesterday" ? `${dayName.toLowerCase()}, ` : ""}${longDate(data.date)}.`
            : `Daytime: ${longDate(data.date)}. Skip anything you're unsure of.`}
        </p>
      </div>

      {/* SLEEP: nights that already happened. Not tied to the day tabs below. */}
      {nights.length > 0 && (
        <section className="mb-7 rounded-[8px] border border-indigo-400/25 bg-indigo-500/[0.06] p-3" aria-label="Sleep">
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4 text-indigo-300" />
            <h3 className="text-[15px] font-medium text-text-primary">Sleep</h3>
          </div>
          <p className="text-[12px] text-text-tertiary mt-0.5 mb-3">Only nights that already happened. Tonight is asked tomorrow.</p>
          {nights.map((n, i) => (
            <NightBlock
              key={n.date}
              night={n}
              today={data.today}
              catchUp={i > 0}
              items={sleepItems}
              cells={nightCells[n.date] ?? {}}
              onTap={(name, a) => tap(n.date, name, a)}
              onKit={(kit) => apply(n.date, kit)}
            />
          ))}
        </section>
      )}

      {/* DAYTIME: one behavior day per tab */}
      <div className="flex items-center gap-2 mb-2">
        <Sun className="w-4 h-4 text-amber-300" />
        <h3 className="text-[15px] font-medium text-text-primary">
          Daytime{dayName === "Today" || dayName === "Yesterday" ? ` · ${dayName}` : ""}
        </h3>
        <span className="text-[13px] text-text-secondary">{longDate(data.date)}</span>
      </div>

      {/* Day tabs: today and the two days before, with progress */}
      <div className="flex gap-2 mb-4" role="tablist" aria-label="Day">
        {[...data.days].reverse().map((d) => {
          const active = d.date === data.date;
          const complete = d.answered >= d.total && d.total > 0;
          return (
            <button
              key={d.date}
              role="tab"
              aria-selected={active}
              onClick={() => goTo(d.date)}
              className={`flex-1 px-3 py-2 rounded-[6px] border text-left transition-colors ${
                active ? "border-accent/60 bg-accent/10" : "border-border-subtle bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className={`text-[13px] font-medium ${active ? "text-text-primary" : "text-text-secondary"}`}>{dayLabel(d.date, data.today)}</div>
              <div className="text-[11px] font-mono text-text-tertiary">{complete ? "done" : d.answered ? `${d.answered}/${d.total}` : "not started"}</div>
            </button>
          );
        })}
      </div>

      {/* Progress */}
      <div className="mb-6">
        <div className="flex justify-between text-[12px] font-mono text-text-tertiary mb-1.5">
          <span>
            {coreDone} of {core.length} answered
          </span>
          {coreLeft > 0 && <span>{coreLeft} left</span>}
        </div>
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${core.length ? (coreDone / core.length) * 100 : 0}%` }} />
        </div>
        {dayBlanks.length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => apply(null, Object.fromEntries(dayBlanks.map((i) => [i.name, "No" as CheckinAnswer])))}
              className="px-3 py-1.5 rounded-[6px] border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary transition-colors"
            >
              No for the other {dayBlanks.length}
            </button>
            <span className="text-[12px] text-text-tertiary">Tap Yes on what happened first.</span>
          </div>
        )}
      </div>

      {coreByCategory.map(([category, items]) => (
        <section key={category} className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">{category}</h3>
          <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
            {items.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} />
            ))}
          </div>
        </section>
      ))}

      {extras.length > 0 && (
        <section className="mb-6">
          <button onClick={() => setShowExtras((s) => !s)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-2">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showExtras ? "" : "-rotate-90"}`} />
            Also did ({extras.filter((i) => cells[i.name]).length}/{extras.length})
          </button>
          {showExtras && (
            <>
              <p className="text-[12px] text-text-tertiary mb-2">Weekly and rarely-Yes questions. Leave blank unless you did (or deliberately skipped) one {dayName === "Today" ? "today" : "that day"}.</p>
              <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
                {extras.map((item) => (
                  <Row key={item.name} item={item} cell={cells[item.name]} onTap={(name, a) => tap(null, name, a)} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {(delivery.groups.length > 0 || delivery.loadError) && (
        <section className="mb-6">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1">Uber Eats: how much did you eat?</h3>
          {delivery.groups.length > 0 && (
            <p className="text-[12px] text-text-tertiary mb-2">Saved as you tap. Left as All unless you change it; tap All to confirm.</p>
          )}
          {delivery.groups.map((g) => (
            <div key={g.date} className="mb-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-mono text-text-secondary">
                  {g.date === data.date ? dayLabel(g.date, data.today) : `${dayLabel(g.date, data.today)} · not answered yet`}
                </span>
                {g.totalKcal != null && (
                  <span className="text-[11px] font-mono text-text-tertiary">~{Math.round(g.totalKcal)} kcal counted</span>
                )}
              </div>
              <DeliveryDishList items={g.items} onPick={delivery.setFraction} />
            </div>
          ))}
          {delivery.loadError && <p className="text-[12px] text-red-400 mt-1.5">{delivery.loadError}</p>}
          {delivery.error && <p className="text-[12px] text-red-400 mt-1.5">{delivery.error}</p>}
        </section>
      )}

      {/* Save bar: sticks above the mobile tab bar */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:bottom-4 z-10 mt-8">
        <div className="rounded-[8px] border border-border-subtle bg-surface-card/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-lg">
          <div className="flex-1 min-w-0 text-[13px]">
            {error ? (
              <span className="text-red-400">{error}</span>
            ) : savedAt === data.date && tappedCount === 0 ? (
              <span className="text-text-secondary inline-flex items-center gap-1.5 flex-wrap">
                <Check className="w-4 h-4 text-accent" /> Saved
                {changeCount > 0 && <span className="text-text-tertiary">· {changeCount} pre-filled answer{changeCount === 1 ? "" : "s"} not saved yet</span>}
                {catchUp && (
                  <button onClick={() => goTo(catchUp.date)} className="ml-2 text-accent underline underline-offset-2">
                    Catch up {dayLabel(catchUp.date, data.today).toLowerCase()}
                  </button>
                )}
              </span>
            ) : changeCount === 0 ? (
              <span className="text-text-tertiary">Nothing to save yet</span>
            ) : (
              <span className="text-text-secondary">
                {changeCount} change{changeCount === 1 ? "" : "s"}
                {coreLeft > 0 && <span className="text-text-tertiary"> · {coreLeft} daytime left blank</span>}
              </span>
            )}
          </div>
          <button
            onClick={save}
            disabled={saving || changeCount === 0}
            className="px-4 py-2 rounded-[6px] text-[14px] font-medium bg-accent text-black disabled:opacity-40 transition-opacity"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One finished night: which night it is, the one-tap usual kit, then the sleep questions. */
function NightBlock({
  night,
  today,
  catchUp,
  items,
  cells,
  onTap,
  onKit,
}: {
  night: CheckinNight;
  today: string;
  catchUp: boolean;
  items: CheckinItem[];
  cells: Cells;
  onTap: (name: string, a: CheckinAnswer) => void;
  onKit: (kit: Record<string, CheckinAnswer>) => void;
}) {
  const label = nightLabel(night.date, today);
  // Only the kit questions on screen; "applied" once every one of them matches.
  const kit: Record<string, CheckinAnswer> = {};
  for (const i of items) {
    const a = night.usualKit?.[i.name];
    if (a) kit[i.name] = a;
  }
  const kitSize = Object.keys(kit).length;
  const kitApplied = kitSize > 0 && Object.entries(kit).every(([q, a]) => cells[q]?.answer === a);
  const asked = items.filter((i) => i.group === "core");
  const optional = items.filter((i) => i.group !== "core");
  const done = asked.filter((i) => cells[i.name]).length;

  return (
    <div className="mb-4 last:mb-0">
      {/* The weekday span is the main label: it names the night at any hour ("Last night" alone can be misread before 6 AM). */}
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[14px] font-medium text-text-primary">
          {label.span}
          <span className="ml-2 text-[11px] font-mono font-normal uppercase tracking-wider text-indigo-200/80">{label.title}</span>
        </span>
        <span className="text-[11px] font-mono text-text-tertiary shrink-0">{catchUp && done === 0 ? "not answered yet" : `${done}/${asked.length}`}</span>
      </div>
      {kitSize > 0 && (
        <button
          onClick={() => onKit(kit)}
          disabled={kitApplied}
          className={`w-full mb-2 px-3 py-2.5 rounded-[6px] border text-left transition-colors ${
            kitApplied ? "border-accent/40 bg-accent/10" : "border-border-subtle bg-white/[0.03] hover:bg-white/[0.06]"
          }`}
        >
          <span className={`text-[14px] font-medium inline-flex items-center gap-1.5 ${kitApplied ? "text-accent" : "text-text-primary"}`}>
            {kitApplied && <Check className="w-4 h-4" />} Usual kit
          </span>
          <span className="block text-[12px] text-text-tertiary mt-0.5">{kitSummary(kit)}</span>
        </button>
      )}
      <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card">
        {asked.map((item) => (
          <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} />
        ))}
      </div>
      {optional.length > 0 && (
        <>
          <p className="text-[11px] text-text-tertiary mt-2 mb-1">Optional. Leave blank unless it happened.</p>
          <div className="rounded-[6px] border border-border-subtle divide-y divide-border-subtle bg-surface-card/60">
            {optional.map((item) => (
              <Row key={item.name} item={item} cell={cells[item.name]} onTap={onTap} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ item, cell, onTap }: { item: CheckinItem; cell: Cell | undefined; onTap: (name: string, a: CheckinAnswer) => void }) {
  const yes = cell?.answer === "Yes";
  const no = cell?.answer === "No";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-[14px] text-text-primary leading-snug">{item.name}</p>
        {cell?.origin === "suggested" && cell.source && <p className="text-[11px] font-mono text-accent/80 mt-0.5">from {cell.source} · tap to change</p>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => onTap(item.name, "Yes")}
          aria-pressed={yes}
          aria-label={`${item.name}: yes`}
          className={`h-9 w-14 rounded-[6px] border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            yes ? "bg-accent/20 border-accent/70 text-accent" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <Check className="w-3.5 h-3.5" /> Yes
        </button>
        <button
          onClick={() => onTap(item.name, "No")}
          aria-pressed={no}
          aria-label={`${item.name}: no`}
          className={`h-9 w-14 rounded-[6px] border text-[13px] font-medium inline-flex items-center justify-center gap-1 transition-colors ${
            no ? "bg-red-500/15 border-red-400/60 text-red-300" : "border-border-subtle text-text-tertiary hover:text-text-secondary"
          }`}
        >
          <X className="w-3.5 h-3.5" /> No
        </button>
      </div>
    </div>
  );
}
