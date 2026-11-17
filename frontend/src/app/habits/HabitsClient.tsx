"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { getHabitJournal, getHabitMetadataHistory, rangeDays, rangeLabel, type Range, type HabitMetadataInterval } from "@/lib/queries";
import { axisTick, gridStyle, chartTooltip, chartColors as C } from "@/lib/chart-theme";
import { formatDate, sameJson } from "@/lib/format";
import { CACHE_KEYS, clientCache, fetchJsonValue } from "@/lib/client-cache";
import { WINDDOWN_SAVED_EVENT } from "@/lib/sleep-winddown";
import StatCard from "@/components/StatCard";
import MetricRing from "@/components/MetricRing";
import ChartCard from "@/components/ChartCard";
import InfoHint from "@/components/InfoHint";
import RangeFilter from "@/components/RangeFilter";
import LogLink from "@/components/LogLink";
import { useInFeed } from "@/components/FeedContext";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CATEGORY_COLORS: Record<string, string> = {
  health: C.up,
  fitness: C.source.garmin,
  mindfulness: C.source.eightsleep,
  productivity: C.source.whoop,
  nutrition: C.accent,
  learning: C.categorical[4],
  social: C.categorical[1],
  general: C.neutral,
};

interface NotionHabit {
  id: string;
  name: string;
  category: string;
  frequency: string;
  active: boolean;
  lastCompleted: string | null;
}

interface JournalEntry {
  cycle_date: string;
  question: string;
  category: string | null;
  answer: string | null;
}

// Tri-state answer for one (habit, date) cell: explicit Yes, explicit No, or
// null = not logged (no row). Null is represented by row ABSENCE in
// habit_journal — the HRV pipeline's missing=No fill and the (cycle_date,
// question) PK both depend on that, so "clear" deletes rather than writing a
// null-answer row.
type HabitAnswer = "Yes" | "No" | null;

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

function getDatesArray(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("en-CA"));
  }
  return dates;
}

function isAdHocFrequency(frequency: string): boolean {
  const f = frequency.trim().toLowerCase();
  return f === "ad hoc" || f === "adhoc" || f === "ad-hoc";
}

function isEligibleDay(frequency: string, dateStr: string): boolean {
  if (isAdHocFrequency(frequency)) return false; // ad hoc never has expected days
  if (frequency !== "weekdays") return true;
  const dow = new Date(dateStr + "T00:00:00").getDay();
  return dow !== 0 && dow !== 6;
}

// Find the metadata interval covering `date` for this habit. Falls back to
// the current Notion values when no history row exists yet (matches the
// pre-history-table behavior — see sql/habit_metadata_history.sql).
function resolveMetadata(
  pageId: string,
  date: string,
  history: HabitMetadataInterval[],
  fallback: { frequency: string; category: string },
): { frequency: string; category: string } {
  for (const h of history) {
    if (h.notion_page_id !== pageId) continue;
    if (date < h.valid_from) continue;
    if (h.valid_to !== null && date > h.valid_to) continue;
    return { frequency: h.frequency, category: h.category ?? fallback.category };
  }
  return fallback;
}

// For ad hoc habits, the "streak" concept doesn't apply — instead show recency.
// Returns days-ago of most recent completion (0 = today), or null if never completed.
function daysSinceLastCompletion(habitName: string, completionSet: Set<string>): number | null {
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-CA");
    if (completionSet.has(`${habitName}|${dateStr}`)) return i;
  }
  return null;
}

// Streak is anchored to the habit's CURRENT frequency (the one in effect
// today) — that's the meaningful answer to "how many consecutive periods
// have I kept this going?" Changing a habit from daily to weekly resets
// the lens, but past completions still count if they satisfy the new
// cadence. Eligibility/category lookups inside the loop are per-date so
// retroactive prop changes don't silently rewrite history.
function calculateStreak(
  habit: { id: string; name: string; frequency: string; category: string },
  completionSet: Set<string>,
  history: HabitMetadataInterval[],
): number {
  if (isAdHocFrequency(habit.frequency)) return 0;

  const now = new Date();

  if (habit.frequency === "weekly") {
    let streak = 0;
    for (let weekIdx = 0; weekIdx < 52; weekIdx++) {
      let hasCompletion = false;
      for (let d = 0; d < 7; d++) {
        const dt = new Date(now);
        dt.setDate(dt.getDate() - (weekIdx * 7 + d));
        const dateStr = dt.toLocaleDateString("en-CA");
        if (completionSet.has(`${habit.name}|${dateStr}`)) {
          hasCompletion = true;
          break;
        }
      }
      if (hasCompletion) {
        streak++;
      } else {
        if (weekIdx === 0) continue;
        break;
      }
    }
    return streak;
  }

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-CA");

    const freqOnDate = resolveMetadata(habit.id, dateStr, history, habit).frequency;
    if (!isEligibleDay(freqOnDate, dateStr)) continue;

    if (completionSet.has(`${habit.name}|${dateStr}`)) {
      streak++;
    } else {
      if (i === 0) continue; // Allow today to be incomplete
      break;
    }
  }
  return streak;
}

const LIST_URL = "/api/habits/list";
type HabitsList = { habits?: NotionHabit[] };
// Each read goes through the shared cache (one request even when the warm-up asks at the same time).
// An error answer is never cached (fetchJsonValue throws on it; 404 removes the entry).
const readList = () => clientCache.revalidate<HabitsList>(LIST_URL, () => fetchJsonValue(LIST_URL) as Promise<HabitsList>);
const readJournal = () => clientCache.revalidate<JournalEntry[]>(CACHE_KEYS.habitsJournal, () => getHabitJournal(365) as Promise<JournalEntry[]>);
const readHistory = () => clientCache.revalidate<HabitMetadataInterval[]>(CACHE_KEYS.habitsHistory, () => getHabitMetadataHistory());
const keep = <T,>(next: T) => (prev: T) => (sameJson(prev, next) ? prev : next);

export default function HabitsPage({ headingTestId = "page-heading" }: { headingTestId?: string } = {}) {
  // headingTestId: "feed-page-heading" when shown inside the continuous scroll (components/ContinuousScroll.tsx).
  // Start from the cached copy (instant revisit / reopen), then revalidate; the skeleton shows only when
  // nothing is cached.
  const [habits, setHabits] = useState<NotionHabit[]>(() => clientCache.peek<HabitsList>(LIST_URL)?.habits ?? []);
  const [journal, setJournal] = useState<JournalEntry[]>(() => clientCache.peek<JournalEntry[]>(CACHE_KEYS.habitsJournal) ?? []);
  const [history, setHistory] = useState<HabitMetadataInterval[]>(() => clientCache.peek<HabitMetadataInterval[]>(CACHE_KEYS.habitsHistory) ?? []);
  const [loading, setLoading] = useState(() => !(clientCache.peek(LIST_URL) && clientCache.peek(CACHE_KEYS.habitsJournal) && clientCache.peek(CACHE_KEYS.habitsHistory)));
  const shownRef = useRef(!loading);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<Range>("30d");
  const [actionError, setActionError] = useState<string | null>(null);
  const [openCell, setOpenCell] = useState<{ habit: NotionHabit; date: string; x: number; y: number } | null>(null);

  // The Notion sync (POST /api/habits/sync, 1.5-4 s) runs only when /habits is the routed page. Inside the
  // continuous scroll Habits mounts next to Check-in, Sleep, Caffeine and others, and a background sync there
  // broke the speed budget on those pages (perf-timing run 43666031043); the hourly habits-sync.yml bounds
  // staleness, and opening /habits itself still syncs.
  const inFeed = useInFeed();
  const hasSyncedRef = useRef(inFeed);
  // Monotonic per-cell sequence so a stale response (rapid re-tap on the same
  // cell) can't revert or clear the in-flight state of a newer optimistic write.
  const answerSeq = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    if (!shownRef.current) setLoading(true);
    try {
      const [habitsRes, journalData, historyData] = await Promise.all([readList(), readJournal(), readHistory()]);
      setHabits(keep(habitsRes?.habits || []));
      setJournal(keep(journalData ?? []));
      setHistory(keep(historyData ?? []));
      shownRef.current = true;
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }

    // Sync from Notion (Last Completed + metadata-history diff) AFTER first
    // paint — the sync route runs a full Notion DB query plus diff writes
    // (1.5-4s) and used to gate the skeleton, making /habits the slowest page
    // in the app. The `syncing` chip covers the window. Once per mount: range
    // changes re-run load(), but a second Notion pull buys nothing within one
    // visit (the hourly habits-sync.yml cron bounds staleness anyway), and the
    // sync route may insert new history rows, so journal + history are
    // refetched when it reports changes.
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;
    setSyncing(true);
    try {
      const syncRes = await fetch("/api/habits/sync", { method: "POST" });
      if (syncRes.ok) {
        const { count } = await syncRes.json();
        if (count > 0) {
          const updated = await readJournal();
          setJournal(keep(updated ?? []));
        }
        const fresh = await readHistory();
        setHistory(keep(fresh ?? []));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  }, []);

  // Journal is always fetched at 365d and history/habits are range-independent,
  // so a range change needs NO refetch — heatmapDates and every KPI re-derive
  // locally. Loading on every range switch used to re-run all three fetches
  // and flash the skeleton for zero new data.
  useEffect(() => { load(); }, [load]);

  // Reopening the app: fill from the copy kept on this device while the network answers.
  useEffect(() => {
    if (shownRef.current) return;
    let alive = true;
    void Promise.all([clientCache.read<HabitsList>(LIST_URL), clientCache.read<JournalEntry[]>(CACHE_KEYS.habitsJournal), clientCache.read<HabitMetadataInterval[]>(CACHE_KEYS.habitsHistory)])
      .then(([list, j, h]) => {
        if (!alive || shownRef.current || !list || !j || !h) return;
        shownRef.current = true;
        setHabits(list.habits ?? []);
        setJournal(j);
        setHistory(h);
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // Taps update the journal optimistically; keep the cached copy in step so the next visit shows them.
  useEffect(() => {
    if (!loading) clientCache.put(CACHE_KEYS.habitsJournal, journal);
  }, [journal, loading]);

  // The wind-down button (Today, Log) writes one of these habits' answers: show it here without a reload. A tap of
  // this page still in flight keeps its optimistic value (the re-read runs only while none is pending).
  const togglingRef = useRef(toggling);
  useEffect(() => { togglingRef.current = toggling; }, [toggling]);
  useEffect(() => {
    const onWindDownSaved = () => {
      if (togglingRef.current.size > 0) return;
      void readJournal().then((j) => { if (togglingRef.current.size === 0) setJournal(keep(j ?? [])); }).catch(() => {});
    };
    window.addEventListener(WINDDOWN_SAVED_EVENT, onWindDownSaved);
    return () => window.removeEventListener(WINDDOWN_SAVED_EVENT, onWindDownSaved);
  }, []);

  // Tri-state lookup of "habitName|date" → explicit answer. completionSet
  // stays Yes-only on purpose: every KPI, rate, and streak treats explicit
  // 'No' exactly like "not logged" (matching the pipeline's missing=No fill);
  // 'No' is a display + data-provenance state, not a completion.
  const answerMap = new Map<string, "Yes" | "No">();
  const completionSet = new Set<string>();
  journal.forEach((j) => {
    const a = j.answer?.toLowerCase();
    if (a === "yes") {
      answerMap.set(`${j.question}|${j.cycle_date}`, "Yes");
      completionSet.add(`${j.question}|${j.cycle_date}`);
    } else if (a === "no") {
      answerMap.set(`${j.question}|${j.cycle_date}`, "No");
    }
  });

  const today = todayStr();

  function applyLocalAnswer(habit: NotionHabit, date: string, answer: HabitAnswer) {
    setJournal((prev) => {
      const rest = prev.filter((j) => !(j.question === habit.name && j.cycle_date === date));
      return answer === null
        ? rest
        : [...rest, { cycle_date: date, question: habit.name, category: habit.category, answer }];
    });
  }

  // Sets a cell's answer directly (Yes / No / null = clear), optimistically:
  // the UI updates immediately and reverts only if the server rejects the
  // write. Tapping is no longer blocked on the API roundtrip.
  async function setAnswer(habit: NotionHabit, date: string, answer: HabitAnswer) {
    if (date > today) return; // never log future dates
    const key = `${habit.name}|${date}`;
    const previous = answerMap.get(key) ?? null;
    if (previous === answer) return;
    const seq = (answerSeq.current.get(key) ?? 0) + 1;
    answerSeq.current.set(key, seq);

    setActionError(null);
    applyLocalAnswer(habit, date, answer);
    setToggling((prev) => new Set(prev).add(key));

    try {
      const res = await fetch("/api/habits/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          habit: habit.name,
          date,
          category: habit.category,
          notionPageId: habit.id,
          answer,
        }),
      });

      if (!res.ok && answerSeq.current.get(key) === seq) {
        // E.g. the frozen-WHOOP-era guard (400) — revert the optimistic state
        // and surface it so a click that "didn't work" explains itself.
        const { error } = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
        applyLocalAnswer(habit, date, previous);
        setActionError(error || `Request failed (${res.status})`);
      }
    } catch (e) {
      console.error("Failed to set habit answer:", e);
      if (answerSeq.current.get(key) === seq) {
        applyLocalAnswer(habit, date, previous);
        setActionError("Network error — the change was not saved.");
      }
    } finally {
      if (answerSeq.current.get(key) === seq) {
        setToggling((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 space-y-3">
              <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
              <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const requiredHabits = habits.filter((h) => !isAdHocFrequency(h.frequency));
  const todayCompleted = requiredHabits.filter((h) => completionSet.has(`${h.name}|${today}`)).length;
  const streaks = habits.map((h) => {
    const adHoc = isAdHocFrequency(h.frequency);
    const streak = calculateStreak(h, completionSet, history);
    const isWeekly = h.frequency === "weekly";
    return {
      habit: h,
      streak,
      unit: isWeekly ? "weeks" : "days",
      shortUnit: isWeekly ? "w" : "d",
      isAdHoc: adHoc,
      daysSince: adHoc ? daysSinceLastCompletion(h.name, completionSet) : null,
      // Days-equivalent for cross-frequency comparison (a 4-week weekly streak ≈ 28 days sustained).
      // Ad hoc habits have rankValue 0 so they never win Longest Streak.
      rankValue: adHoc ? 0 : (isWeekly ? streak * 7 : streak),
    };
  });
  const longestEntry = streaks.length > 0
    ? streaks.reduce((best, curr) => (curr.rankValue > best.rankValue ? curr : best))
    : null;
  const longestStreak = longestEntry && longestEntry.rankValue > 0 ? longestEntry.streak : 0;
  const longestUnit = longestEntry && longestEntry.rankValue > 0 ? longestEntry.unit : "days";
  const bestHabit = longestEntry && longestEntry.rankValue > 0 ? longestEntry.habit : undefined;

  const heatmapDates = getDatesArray(Math.min(rangeDays(range), 365));
  const rangeStart = heatmapDates[0];

  // Recent metadata changes — surfaced as a small banner so the user knows
  // KPIs span a period when a habit's Frequency or Category was different.
  // A change is a non-seed interval starting on/after the visible range
  // (seed = the EARLIEST interval per pageId, which represents the initial
  // capture, not a real edit).
  const recentChanges: Array<{
    habitName: string;
    from: string;
    to: string;
    field: "frequency" | "category";
    fromVal: string;
    toVal: string;
  }> = [];
  const habitNameById = new Map(habits.map((h) => [h.id, h.name]));
  const intervalsByPage = new Map<string, HabitMetadataInterval[]>();
  history.forEach((row) => {
    const list = intervalsByPage.get(row.notion_page_id) ?? [];
    list.push(row);
    intervalsByPage.set(row.notion_page_id, list);
  });
  intervalsByPage.forEach((rows, pageId) => {
    const sorted = [...rows].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i];
      const prev = sorted[i - 1];
      if (curr.valid_from < rangeStart) continue;
      if (prev.frequency !== curr.frequency) {
        recentChanges.push({
          habitName: habitNameById.get(pageId) ?? pageId.slice(0, 8),
          from: prev.valid_from,
          to: curr.valid_from,
          field: "frequency",
          fromVal: prev.frequency,
          toVal: curr.frequency,
        });
      }
      if ((prev.category || "") !== (curr.category || "")) {
        recentChanges.push({
          habitName: habitNameById.get(pageId) ?? pageId.slice(0, 8),
          from: prev.valid_from,
          to: curr.valid_from,
          field: "category",
          fromVal: prev.category || "—",
          toVal: curr.category || "—",
        });
      }
    }
  });

  // Per-habit frequency-aware rate aggregator.
  // daily: 1 slot per day. weekdays: 1 slot per Mon-Fri. weekly: 1 slot per 7-day chunk
  // (chunked from the END of `dates`; leftover days <7 still get 1 slot so short ranges
  // don't drop weekly habits entirely). ad hoc: skipped entirely (never expected).
  function rateOver(dates: string[]): { possible: number; completed: number; rate: number } {
    let possible = 0;
    let completed = 0;
    habits.forEach((h) => {
      // Skip habits that are ad-hoc TODAY but check per-date frequency below
      // for the eligibility test. Weekly cadence is anchored to today's
      // frequency because the 7-day-window concept doesn't translate
      // mid-stream if the cadence flipped.
      if (isAdHocFrequency(h.frequency)) return;
      if (h.frequency === "weekly") {
        const slots = Math.max(1, Math.floor(dates.length / 7));
        for (let i = 0; i < slots; i++) {
          const end = dates.length - i * 7;
          const start = Math.max(0, end - 7);
          const slot = dates.slice(start, end);
          possible++;
          if (slot.some((d) => completionSet.has(`${h.name}|${d}`))) completed++;
        }
        return;
      }
      dates.forEach((d) => {
        const freqOnDate = resolveMetadata(h.id, d, history, h).frequency;
        if (!isEligibleDay(freqOnDate, d)) return;
        possible++;
        if (completionSet.has(`${h.name}|${d}`)) completed++;
      });
    });
    return { possible, completed, rate: possible > 0 ? Math.round((completed / possible) * 100) : 0 };
  }

  const last7 = getDatesArray(7);
  const prev7 = getDatesArray(14).slice(0, 7); // days -14..-8
  const last7Stats = rateOver(last7);
  const prev7Stats = rateOver(prev7);
  const completionRate = last7Stats.rate;
  const completedLast7 = last7Stats.completed;
  const possibleLast7 = last7Stats.possible;
  const deltaVsPrior = completionRate - prev7Stats.rate;

  // 7-day rolling completion rate across the active range (for trend chart)
  const activeRangeDates = heatmapDates;
  const trendData = activeRangeDates.map((d, idx) => {
    const window = activeRangeDates.slice(Math.max(0, idx - 6), idx + 1);
    return { date: formatDate(d), rate: rateOver(window).rate };
  });

  // Per-category completion rate over the active range. Ad hoc habits don't count
  // toward any denominator, so they neither add to nor reduce a category's rate.
  // Categories that contain only ad hoc habits are filtered out below.
  const categoryAgg: Record<string, { possible: number; completed: number; count: number }> = {};
  habits.forEach((h) => {
    if (isAdHocFrequency(h.frequency)) return;
    // habitCount keyed on current category — the "13 habits in fitness" line
    // describes the present, not the union of every historical category.
    const currentCat = h.category || "general";
    if (!categoryAgg[currentCat]) categoryAgg[currentCat] = { possible: 0, completed: 0, count: 0 };
    categoryAgg[currentCat].count++;

    activeRangeDates.forEach((d) => {
      const meta = resolveMetadata(h.id, d, history, h);
      if (!isEligibleDay(meta.frequency, d)) return;
      // Use per-date category so a habit that was 'general' last month and
      // 'fitness' this month contributes to the correct bucket per day.
      const catOnDate = meta.category || "general";
      if (!categoryAgg[catOnDate]) categoryAgg[catOnDate] = { possible: 0, completed: 0, count: 0 };
      categoryAgg[catOnDate].possible++;
      if (completionSet.has(`${h.name}|${d}`)) categoryAgg[catOnDate].completed++;
    });
  });
  const categoryRates = Object.entries(categoryAgg)
    .filter(([, m]) => m.possible > 0)
    .map(([cat, m]) => ({
      category: cat,
      rate: Math.round((m.completed / m.possible) * 100),
      habitCount: m.count,
      color: CATEGORY_COLORS[cat] || CATEGORY_COLORS.general,
    }))
    .sort((a, b) => b.rate - a.rate);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">Habits</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Daily behaviors — {rangeLabel(range)}
            {syncing && <span className="ml-2 text-accent animate-pulse">syncing from Notion...</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RangeFilter value={range} onChange={setRange} />
          {/* Today's answers are entered on Log (its check-in), not here; the heatmap below still corrects a day. */}
          <LogLink part="check-in">Answer today&apos;s habits on Log</LogLink>
          <a
            href="https://www.notion.so/29cc936fd5e14ae8b10a4fe5c5f7a6cd"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-secondary border border-border-subtle rounded-control hover:bg-white/10 transition-colors"
          >
            Manage in Notion
          </a>
        </div>
      </div>

      {actionError && (
        <div className="mb-6 px-3 py-2.5 rounded-control border border-red-500/30 bg-red-500/[0.06] flex items-start justify-between gap-3">
          <p className="text-[12px] text-red-300/90">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="text-[11px] font-mono text-text-tertiary hover:text-text-primary shrink-0"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Personalize: every tile, card and chart is its own part; sections have no heading on screen. */}
      <PartGrid page="/habits" title="Habits">
      <PartGroup id="section-summary" title="Summary tiles">
      {recentChanges.length > 0 && (
        <Part id="metadata-changes" title="Metadata changed in this range">
        <div className="px-3 py-2.5 rounded-control border border-amber-500/30 bg-amber-500/[0.04]">
          <p className="text-[11px] font-mono uppercase tracking-wider text-amber-300/80 mb-1.5">
            Metadata changed within this range — rates reflect each day&apos;s in-effect values
          </p>
          <ul className="text-[12px] text-text-secondary space-y-0.5">
            {recentChanges.slice(0, 6).map((c, i) => (
              <li key={i}>
                <span className="text-text-primary">{c.habitName}</span>
                {": "}
                {c.field} {c.fromVal} → {c.toVal} on {c.to}
              </li>
            ))}
            {recentChanges.length > 6 && (
              <li className="text-text-tertiary">+{recentChanges.length - 6} more</li>
            )}
          </ul>
        </div>
        </Part>
      )}

      {/* KPIs */}
      <Part id="tile-today" title="Today (ring)" width="quarter">
        <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 flex items-center justify-center">
          <MetricRing label="Today" value={todayCompleted} max={requiredHabits.length || 1} zone
            centerValue={`${todayCompleted}/${requiredHabits.length}`} sublabel="required habits" size={120} />
        </div>
      </Part>
      <Part id="tile-7day-rate" title="7-Day Rate (ring)" width="quarter">
        <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 flex items-center justify-center">
          <MetricRing label="7-Day Rate" value={completionRate} zone centerUnit="%"
            sublabel={`${completedLast7}/${possibleLast7}`} size={120} />
        </div>
      </Part>
      <Part id="tile-longest-streak" title="Longest Streak (tile)" width="quarter">
        <StatCard label="Longest Streak" value={longestStreak} unit={longestUnit} sublabel={bestHabit?.name} />
      </Part>
      <Part id="tile-vs-prior" title="vs Prior Week (tile)" width="quarter">
        <StatCard
          label="vs Prior Week"
          value={prev7Stats.possible > 0 ? `${deltaVsPrior >= 0 ? "+" : ""}${deltaVsPrior}` : "—"}
          unit={prev7Stats.possible > 0 ? "%" : undefined}
          sublabel={prev7Stats.possible > 0 ? `prior 7d was ${prev7Stats.rate}%` : "no prior data"}
        />
      </Part>
      </PartGroup>

      <PartGroup id="section-trends" title="Rates & heatmap" gap={24}>
      {/* Completion-rate trend */}
      {habits.length > 0 && (
        <Part id="rolling-rate" title="7-Day Rolling Completion Rate">
        <ChartCard
          title="7-Day Rolling Completion Rate"
          subtitle={rangeLabel(range)}
        >
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="habitRateGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.accent} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={C.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} unit="%" />
              <Tooltip {...chartTooltip} />
              <Area
                type="monotone"
                dataKey="rate"
                stroke={C.accent}
                strokeWidth={2}
                fill="url(#habitRateGrad)"
                name="Completion %"
                connectNulls={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        </Part>
      )}

      {/* Per-category breakdown */}
      {habits.length > 0 && categoryRates.length > 0 && (
        <Part id="by-category" title="By Category">
        <ChartCard
          title="By Category"
          subtitle={`Completion rate across ${rangeLabel(range)}`}
        >
          <div className="space-y-2.5">
            {categoryRates.map(({ category, rate, habitCount, color }) => (
              <div key={category} className="flex items-center gap-3">
                <div className="w-28 shrink-0 flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-[12px] text-text-secondary capitalize truncate">{category}</span>
                </div>
                <div className="flex-1 h-2.5 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${rate}%`, backgroundColor: color }}
                  />
                </div>
                <span className="text-[12px] font-mono tabular-nums text-text-primary w-12 text-right">
                  {rate}%
                </span>
                <span className="text-[10px] font-mono text-text-tertiary w-16 text-right">
                  {habitCount} habit{habitCount === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        </ChartCard>
        </Part>
      )}

      {/* Heatmap */}
      {habits.length > 0 && (
        <Part id="heatmap" title="Heatmap">
        <ChartCard
          title={`Heatmap — ${rangeLabel(range)}`}
          subtitle="Filled = yes · ✕ = no · blank = not logged · click to change"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal pr-3 py-1 sticky left-0 bg-surface-card min-w-[140px] align-bottom">
                    Habit
                  </th>
                  {heatmapDates.map((d) => {
                    const [, m, day] = d.split("-");
                    return (
                      <th key={d} className="text-text-tertiary text-[10px] font-mono font-normal px-0.5 pb-1 min-w-[28px] align-bottom">
                        <span className="block whitespace-nowrap leading-tight tabular-nums">
                          {Number(m)}/{Number(day)}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {habits.map((h) => {
                  const color = CATEGORY_COLORS[h.category] || CATEGORY_COLORS.general;
                  return (
                    <tr key={h.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="text-text-secondary pr-3 py-1 sticky left-0 bg-surface-card truncate max-w-[160px]" title={h.name}>
                        {h.name}
                      </td>
                      {heatmapDates.map((d) => {
                        const answer = answerMap.get(`${h.name}|${d}`) ?? null;
                        const isFuture = d > today;
                        const cellToggling = toggling.has(`${h.name}|${d}`);
                        const cellTitle = isFuture
                          ? "Future"
                          : `${answer ?? "Not logged"} (click to set yes / no / clear)`;
                        return (
                          <td key={d} className="px-0.5 py-1 text-center">
                            <button
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setOpenCell({ habit: h, date: d, x: rect.left + rect.width / 2, y: rect.top });
                              }}
                              disabled={isFuture}
                              className={`w-5 h-5 rounded-sm mx-auto flex items-center justify-center transition-all ${
                                isFuture
                                  ? "cursor-not-allowed"
                                  : "hover:ring-1 hover:ring-white/30 cursor-pointer"
                              } ${cellToggling ? "opacity-50" : ""}`}
                              style={{
                                backgroundColor:
                                  answer === "Yes"
                                    ? `${color}cc`
                                    : answer === "No"
                                      ? `${C.down}33`
                                      : "rgba(255,255,255,0.03)",
                              }}
                              title={`${h.name}: ${d} — ${cellTitle}`}
                              aria-label={`Set ${h.name} for ${d}`}
                            >
                              {answer === "No" && (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke={C.down} strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
        </Part>
      )}
      </PartGroup>

      <PartGroup id="section-streaks" title="Streaks" gap={24}>
      {/* Streaks */}
      {habits.length > 0 && (
        <Part id="current-streaks" title="Current Streaks">
        <ChartCard title="Current Streaks">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {streaks
              .slice()
              .sort((a, b) => {
                // Ad hoc habits sort to the bottom, then by recency (more recent first; never = last).
                if (a.isAdHoc !== b.isAdHoc) return a.isAdHoc ? 1 : -1;
                if (a.isAdHoc && b.isAdHoc) {
                  const ax = a.daysSince ?? Infinity;
                  const bx = b.daysSince ?? Infinity;
                  return ax - bx;
                }
                return b.rankValue - a.rankValue;
              })
              .map(({ habit, streak, unit, rankValue, isAdHoc, daysSince }) => {
                const color = CATEGORY_COLORS[habit.category] || CATEGORY_COLORS.general;
                const unitSingular = unit === "weeks" ? "week" : "day";
                let label: string;
                if (isAdHoc) {
                  if (daysSince === null) label = "never logged";
                  else if (daysSince === 0) label = "logged today";
                  else if (daysSince === 1) label = "1 day ago";
                  else label = `${daysSince} days ago`;
                } else {
                  label = streak > 0 ? `${streak} ${unitSingular}${streak !== 1 ? "s" : ""}` : "No streak";
                }
                return (
                  <div key={habit.id} className="flex items-center gap-3 px-3 py-2.5 rounded-control bg-white/[0.02]">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary font-medium truncate">
                        {habit.name}
                        {isAdHoc && (
                          <span className="ml-1.5 text-[9px] font-mono uppercase tracking-wider text-text-tertiary/70">
                            ad hoc
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] font-mono" style={{ color: isAdHoc ? "var(--color-text-tertiary)" : color }}>
                        {label}
                      </p>
                    </div>
                    {!isAdHoc && (
                      <div className="w-12 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${Math.min(100, (rankValue / 30) * 100)}%`, backgroundColor: color }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </ChartCard>
        </Part>
      )}

      {/* Scoring rules, closed by default */}
      {habits.length > 0 && (
        <Part id="scoring-rules" title="How rates & streaks are scored">
        <InfoHint label="How rates and streaks are scored" variant="disclosure" summary="How rates & streaks are scored">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-[12px] leading-relaxed">
            <div className="flex gap-3">
              <span className="text-text-primary font-mono shrink-0 w-20">daily</span>
              <span className="text-text-tertiary">
                Counts every day. Streak resets if you miss a day (today is grace).
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-text-primary font-mono shrink-0 w-20">weekdays</span>
              <span className="text-text-tertiary">
                Counts Mon–Fri only; weekends are skipped. Streak resets if you miss a weekday.
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-text-primary font-mono shrink-0 w-20">weekly</span>
              <span className="text-text-tertiary">
                Done at least once in any 7-day window = 100% for that window. Streak resets if you skip a whole week.
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-text-primary font-mono shrink-0 w-20">Ad Hoc</span>
              <span className="text-text-tertiary">
                Never required. Excluded from every rate. Shown with recency only (&ldquo;3 days ago&rdquo;).
              </span>
            </div>
          </div>
          <p className="text-[11px] text-text-tertiary pt-3 border-t border-border-subtle">
            Frequency is set per habit in Notion. Longest Streak compares frequencies in days (a kept week counts as 7 days).
            An explicit &ldquo;no&rdquo; counts the same as not logged in every rate and streak; it records that you answered.
          </p>
        </InfoHint>
        </Part>
      )}
      </PartGroup>
      </PartGrid>

      {/* Heatmap cell answer picker — fixed-position popover anchored to the
          clicked cell, with a transparent backdrop that closes it. */}
      {openCell && (() => {
        const current = answerMap.get(`${openCell.habit.name}|${openCell.date}`) ?? null;
        const pick = (a: HabitAnswer) => {
          setAnswer(openCell.habit, openCell.date, a);
          setOpenCell(null);
        };
        const clampedX = typeof window !== "undefined"
          ? Math.min(Math.max(openCell.x, 90), window.innerWidth - 90)
          : openCell.x;
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenCell(null)} />
            <div
              className="fixed z-50 -translate-x-1/2 -translate-y-full pb-1.5"
              style={{ left: clampedX, top: openCell.y }}
            >
              <div className="rounded-control border border-border-subtle bg-surface-card shadow-xl px-2 py-1.5">
                <p className="text-[10px] font-mono text-text-tertiary mb-1 max-w-[180px] truncate">
                  {openCell.habit.name} · {openCell.date}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => pick("Yes")}
                    className={`px-2.5 py-1 text-[12px] font-medium rounded-control transition-colors ${
                      current === "Yes"
                        ? "bg-white/15 text-text-primary"
                        : "text-text-secondary hover:bg-white/10"
                    }`}
                  >
                    ✓ Yes
                  </button>
                  <button
                    onClick={() => pick("No")}
                    className={`px-2.5 py-1 text-[12px] font-medium rounded-control transition-colors ${
                      current === "No"
                        ? "bg-white/15"
                        : "hover:bg-white/10"
                    }`}
                    style={{ color: C.down }}
                  >
                    ✕ No
                  </button>
                  {current !== null && (
                    <button
                      onClick={() => pick(null)}
                      className="px-2.5 py-1 text-[12px] font-medium rounded-control text-text-tertiary hover:bg-white/10 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        );
      })()}


      {habits.length === 0 && (
        <div className="text-center py-20">
          <p className="text-text-secondary text-sm mb-3">No active habits found.</p>
          <a
            href="https://www.notion.so/29cc936fd5e14ae8b10a4fe5c5f7a6cd"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent text-sm hover:underline"
          >
            Add habits in Notion
          </a>
        </div>
      )}
    </>
  );
}
