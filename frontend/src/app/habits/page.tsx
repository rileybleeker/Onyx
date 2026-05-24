"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { getHabitJournal, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { axisTick, gridStyle, chartTooltip } from "@/lib/chart-theme";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CATEGORY_COLORS: Record<string, string> = {
  health: "#22c55e",
  fitness: "#3b82f6",
  mindfulness: "#a78bfa",
  productivity: "#f59e0b",
  nutrition: "#06b6d4",
  learning: "#ec4899",
  social: "#f97316",
  general: "#71717a",
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

function calculateStreak(habitName: string, frequency: string, completionSet: Set<string>): number {
  // Ad hoc habits have no expected cadence; no meaningful streak.
  if (isAdHocFrequency(frequency)) return 0;

  const now = new Date();

  // Weekly: count consecutive 7-day windows ending at today with >=1 completion.
  // Current week is allowed to be incomplete (mirrors the daily/weekday "today is grace" rule).
  if (frequency === "weekly") {
    let streak = 0;
    for (let weekIdx = 0; weekIdx < 52; weekIdx++) {
      let hasCompletion = false;
      for (let d = 0; d < 7; d++) {
        const dt = new Date(now);
        dt.setDate(dt.getDate() - (weekIdx * 7 + d));
        const dateStr = dt.toLocaleDateString("en-CA");
        if (completionSet.has(`${habitName}|${dateStr}`)) {
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

    if (!isEligibleDay(frequency, dateStr)) continue;

    if (completionSet.has(`${habitName}|${dateStr}`)) {
      streak++;
    } else {
      if (i === 0) continue; // Allow today to be incomplete
      break;
    }
  }
  return streak;
}

export default function HabitsPage() {
  const [habits, setHabits] = useState<NotionHabit[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<Range>("30d");

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const [habitsRes, journalData] = await Promise.all([
        fetch("/api/habits/list").then((r) => r.json()),
        getHabitJournal(Math.max(days, 365)),
      ]);
      setHabits(habitsRes.habits || []);
      setJournal(journalData);

      // Sync completions from Notion (Last Completed dates)
      setSyncing(true);
      const syncRes = await fetch("/api/habits/sync", { method: "POST" });
      if (syncRes.ok) {
        const { count } = await syncRes.json();
        if (count > 0) {
          // Reload journal data to pick up synced entries
          const updated = await getHabitJournal(Math.max(days, 365));
          setJournal(updated);
        }
      }
      setSyncing(false);
    } catch (e) {
      console.error(e);
      setSyncing(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(rangeDays(range)); }, [load, range]);

  // Build a set of "habitName|date" for completed entries
  const completionSet = new Set<string>();
  journal.forEach((j) => {
    if (j.answer?.toLowerCase() === "yes") {
      completionSet.add(`${j.question}|${j.cycle_date}`);
    }
  });

  const today = todayStr();

  async function toggleCompletion(habit: NotionHabit, date: string) {
    if (date > today) return; // never log future dates
    const key = `${habit.name}|${date}`;
    const isCompleted = completionSet.has(key);
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
          undo: isCompleted,
        }),
      });

      if (res.ok) {
        if (isCompleted) {
          setJournal((prev) =>
            prev.filter((j) => !(j.question === habit.name && j.cycle_date === date))
          );
        } else {
          setJournal((prev) => [
            ...prev.filter((j) => !(j.question === habit.name && j.cycle_date === date)),
            { cycle_date: date, question: habit.name, category: habit.category, answer: "Yes" },
          ]);
        }
      }
    } catch (e) {
      console.error("Failed to toggle habit:", e);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 space-y-3">
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
    const streak = calculateStreak(h.name, h.frequency, completionSet);
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

  // Per-habit frequency-aware rate aggregator.
  // daily: 1 slot per day. weekdays: 1 slot per Mon-Fri. weekly: 1 slot per 7-day chunk
  // (chunked from the END of `dates`; leftover days <7 still get 1 slot so short ranges
  // don't drop weekly habits entirely). ad hoc: skipped entirely (never expected).
  function rateOver(dates: string[]): { possible: number; completed: number; rate: number } {
    let possible = 0;
    let completed = 0;
    habits.forEach((h) => {
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
        if (!isEligibleDay(h.frequency, d)) return;
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
    const cat = h.category || "general";
    if (!categoryAgg[cat]) categoryAgg[cat] = { possible: 0, completed: 0, count: 0 };
    categoryAgg[cat].count++;
    activeRangeDates.forEach((d) => {
      if (!isEligibleDay(h.frequency, d)) return;
      categoryAgg[cat].possible++;
      if (completionSet.has(`${h.name}|${d}`)) categoryAgg[cat].completed++;
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
          <h2 className="text-[28px] font-medium text-text-primary">Habits</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Track daily behaviors and build streaks — {rangeLabel(range)}
            {syncing && <span className="ml-2 text-accent animate-pulse">syncing from Notion...</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RangeFilter value={range} onChange={setRange} />
          <a
            href="https://www.notion.so/29cc936fd5e14ae8b10a4fe5c5f7a6cd"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-secondary border border-border-subtle rounded-[6px] hover:bg-white/10 transition-colors"
          >
            Manage in Notion
          </a>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Today" value={`${todayCompleted}/${requiredHabits.length}`} sublabel="required habits" />
        <StatCard label="7-Day Rate" value={`${completionRate}%`} sublabel={`${completedLast7} of ${possibleLast7} check-ins`} />
        <StatCard label="Longest Streak" value={longestStreak} unit={longestUnit} sublabel={bestHabit?.name} />
        <StatCard
          label="vs Prior Week"
          value={prev7Stats.possible > 0 ? `${deltaVsPrior >= 0 ? "+" : ""}${deltaVsPrior}` : "—"}
          unit={prev7Stats.possible > 0 ? "%" : undefined}
          sublabel={prev7Stats.possible > 0 ? `prior 7d was ${prev7Stats.rate}%` : "no prior data"}
        />
      </div>

      {/* Today's Checklist */}
      {habits.length > 0 && (
        <ChartCard title="Today's Habits" subtitle={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
          <div className="space-y-1">
            {habits.map((h) => {
              const done = completionSet.has(`${h.name}|${today}`);
              const isToggling = toggling.has(`${h.name}|${today}`);
              const streak = calculateStreak(h.name, h.frequency, completionSet);
              const color = CATEGORY_COLORS[h.category] || CATEGORY_COLORS.general;

              return (
                <HabitRow
                  key={h.id}
                  habit={h}
                  done={done}
                  isToggling={isToggling}
                  streak={streak}
                  color={color}
                  today={today}
                  onToggle={(d) => toggleCompletion(h, d)}
                />
              );
            })}
          </div>
        </ChartCard>
      )}

      {/* Completion-rate trend */}
      {habits.length > 0 && (
        <ChartCard
          title="7-Day Rolling Completion Rate"
          subtitle={`Across ${rangeLabel(range)} — frequency-aware denominator`}
          className="mt-6"
        >
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="habitRateGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} unit="%" />
              <Tooltip {...chartTooltip} />
              <Area
                type="monotone"
                dataKey="rate"
                stroke="#06b6d4"
                strokeWidth={2}
                fill="url(#habitRateGrad)"
                name="Completion %"
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Per-category breakdown */}
      {habits.length > 0 && categoryRates.length > 0 && (
        <ChartCard
          title="By Category"
          subtitle={`Completion rate across ${rangeLabel(range)}`}
          className="mt-6"
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
      )}

      {/* Heatmap */}
      {habits.length > 0 && (
        <ChartCard title={`Heatmap — ${rangeLabel(range)}`} className="mt-6">
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
                        const done = completionSet.has(`${h.name}|${d}`);
                        const isFuture = d > today;
                        const cellToggling = toggling.has(`${h.name}|${d}`);
                        return (
                          <td key={d} className="px-0.5 py-1 text-center">
                            <button
                              onClick={() => toggleCompletion(h, d)}
                              disabled={isFuture || cellToggling}
                              className={`w-5 h-5 rounded-sm mx-auto block transition-all ${
                                isFuture
                                  ? "cursor-not-allowed"
                                  : "hover:ring-1 hover:ring-white/30 cursor-pointer"
                              } ${cellToggling ? "opacity-50" : ""}`}
                              style={{ backgroundColor: done ? `${color}cc` : "rgba(255,255,255,0.03)" }}
                              title={`${h.name}: ${d} — ${done ? "Done (click to undo)" : isFuture ? "Future" : "Click to log"}`}
                              aria-label={`Toggle ${h.name} for ${d}`}
                            />
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
      )}

      {/* Streaks */}
      {habits.length > 0 && (
        <ChartCard title="Current Streaks" className="mt-6">
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
                  <div key={habit.id} className="flex items-center gap-3 px-3 py-2.5 rounded-[4px] bg-white/[0.02]">
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
                      <p className="text-[11px] font-mono" style={{ color: isAdHoc ? "var(--color-text-tertiary, #71717a)" : color }}>
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
      )}

      {/* Scoring legend */}
      {habits.length > 0 && (
        <ChartCard title="How rates & streaks are scored" className="mt-6">
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
          <p className="text-[11px] text-text-tertiary/70 mt-4 pt-3 border-t border-border-subtle">
            Frequency is set per habit in Notion. Longest Streak compares across frequencies by days-equivalent (a weekly streak counts as 7 days per week kept).
          </p>
        </ChartCard>
      )}

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

interface HabitRowProps {
  habit: NotionHabit;
  done: boolean;
  isToggling: boolean;
  streak: number;
  color: string;
  today: string;
  onToggle: (date: string) => void;
}

function HabitRow({ habit, done, isToggling, streak, color, today, onToggle }: HabitRowProps) {
  const dateInputRef = useRef<HTMLInputElement>(null);

  function openDatePicker(e: React.MouseEvent) {
    e.stopPropagation();
    const input = dateInputRef.current;
    if (!input) return;
    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      input.focus();
      input.click();
    }
  }

  function onDateChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.value;
    if (picked && picked <= today) onToggle(picked);
    e.target.value = "";
  }

  return (
    <div
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-[4px] transition-all group ${
        done ? "bg-white/[0.03]" : "hover:bg-white/[0.03]"
      } ${isToggling ? "opacity-50" : ""}`}
    >
      <button
        onClick={() => onToggle(today)}
        disabled={isToggling}
        className="flex items-center gap-3 flex-1 text-left min-w-0"
        aria-label={`Toggle ${habit.name} for today`}
      >
        <div
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shrink-0 ${
            done ? "border-transparent" : "border-white/20 group-hover:border-white/40"
          }`}
          style={done ? { backgroundColor: color } : {}}
        >
          {done && (
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <span className={`text-sm font-medium transition-colors ${done ? "text-text-tertiary line-through" : "text-text-primary"}`}>
            {habit.name}
          </span>
        </div>
      </button>

      {streak > 0 && (
        <span
          className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${color}20`, color }}
        >
          {streak}{habit.frequency === "weekly" ? "w" : "d"} streak
        </span>
      )}

      <span className="text-[10px] font-mono text-text-tertiary/60 uppercase tracking-wider hidden sm:inline">
        {habit.category}
      </span>

      <button
        onClick={openDatePicker}
        className="relative p-1.5 rounded-[4px] text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
        title="Log on a past date"
        aria-label={`Backdate ${habit.name}`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <input
          ref={dateInputRef}
          type="date"
          max={today}
          onChange={onDateChange}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
